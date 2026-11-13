// Ticket 044: attendance register (server only). Marking goes through one SQL function (`attendance_mark`, migration
// 20261113004400_attendance.sql) that calls 030's booking_complete / booking_cancel for first markings and records
// corrections in 030's state history; this module wraps it in a transaction with the strict audit row (FR-8). Every
// caller gates first (requireProviderApi / case access); the SQL function re-checks the actor with 043's
// `series_can_manage` (active member: owner/admin, or the therapist bound to the appointment's profile) and answers
// `not_found` (404) for everyone else.
import { NextResponse } from "next/server";
import { z } from "zod";
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { pg, type Queryable } from "@/lib/pg";
import { canManage, listMemberships, type Membership } from "@/lib/orgs";
import { ATTENDANCE_VALUES, NEEDS_ATTENTION_HOURS, MEMBER_WINDOW_DAYS, type Attendance } from "./attendance-display";
import { BOOKING_ERRORS, isBookingErrorCode, type BookingErrorCode } from "./errors";
import { addDays, todayIn, wallToUtc } from "./time";

if (typeof window !== "undefined") {
  throw new Error("lib/booking/attendance.ts is server-only");
}

// ---------- schemas ----------

export const AttendanceMarkSchema = z.object({
  attendance: z.enum(ATTENDANCE_VALUES, { error: "Choose present, absent, late cancel or centre cancelled" }),
  /** Required for corrections (an already marked session), kept in the audit row and the state history. */
  reason: z.string().trim().max(300, { error: "Keep the reason under 300 characters" }).optional(),
});

export const MarkAllSchema = z.object({
  appointment_ids: z.array(z.uuid()).min(1).max(200),
});

export const AttendancePolicySchema = z.object({
  bill_absent: z.boolean(),
  bill_late_cancel: z.boolean(),
  late_cancel_hours: z.number().int().min(0, { error: "0 to 168 hours" }).max(168, { error: "0 to 168 hours" }),
});

export type AttendancePolicy = z.output<typeof AttendancePolicySchema>;
export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicy = { bill_absent: false, bill_late_cancel: false, late_cancel_hours: 24 };

// ---------- errors ----------

export const ATTENDANCE_ERRORS = {
  reason_required: { status: 422, error: "Give a reason for the correction." },
  correction_window: { status: 403, error: "Sessions older than 7 days can only be changed by an owner or admin." },
  not_started: { status: 409, error: "Present and absent can be marked from the start time." },
} as const;

type AttendanceErrorCode = keyof typeof ATTENDANCE_ERRORS | BookingErrorCode;

export class AttendanceError extends Error {
  constructor(readonly code: AttendanceErrorCode) {
    super(code);
    this.name = "AttendanceError";
  }
}

export function toAttendanceErrorCode(err: unknown): AttendanceErrorCode | null {
  if (err instanceof AttendanceError) return err.code;
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(ATTENDANCE_ERRORS, message)) return message as keyof typeof ATTENDANCE_ERRORS;
  return isBookingErrorCode(message) ? message : null;
}

export function attendanceErrorResponse(code: AttendanceErrorCode): Response {
  const { status, error } =
    code in ATTENDANCE_ERRORS ? ATTENDANCE_ERRORS[code as keyof typeof ATTENDANCE_ERRORS] : BOOKING_ERRORS[code as BookingErrorCode];
  return NextResponse.json({ error, code }, { status });
}

// ---------- marking (FR-1 - FR-4, FR-8, NFR-2) ----------

export type MarkResult = {
  result: "marked" | "corrected" | "unchanged";
  appointment_id: string;
  org_id: string;
  child_id: string | null;
  case_id: string | null;
  from: Attendance | null;
  to: Attendance;
  billable: boolean | null;
  from_status: string;
  to_status: string;
};

type MarkActor = SessionAuditActor & { actorUserId: string };

/**
 * Marks (or corrects, with a reason) one appointment's attendance. One transaction: the SQL function (row lock, 030
 * state machine, state history) + the strict audit row `appointment.attendance_marked` or
 * `appointment.attendance_corrected` (actor, from, to, reason, billable). The same value twice is `unchanged`: no
 * second event, no second audit row (NFR-2).
 */
export async function markAttendance(appointmentId: string, actor: MarkActor, attendance: Attendance, reason?: string | null): Promise<MarkResult> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ r: MarkResult }[]>`
      select public.attendance_mark(${appointmentId}::uuid, ${actor.actorUserId}::uuid, ${attendance}, ${reason ?? null}) as r`;
    const r = row.r;
    if (r.result !== "unchanged") {
      await auditStrict(
        {
          ...actor,
          orgId: r.org_id,
          childId: r.child_id,
          caseId: r.case_id,
          action: r.result === "corrected" ? "appointment.attendance_corrected" : "appointment.attendance_marked",
          entity: "appointment",
          entityId: r.appointment_id,
          details: {
            from: r.from,
            to: r.to,
            from_status: r.from_status,
            to_status: r.to_status,
            billable: r.billable,
            ...(r.result === "corrected" ? { reason: (reason ?? "").trim().slice(0, 300) } : {}),
          },
        },
        tx,
      );
    }
    return r;
  }) as Promise<MarkResult>;
}

// ---------- org policy (FR-2) ----------

function toPolicy(value: unknown): AttendancePolicy {
  const parsed = AttendancePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_ATTENDANCE_POLICY;
}

export async function getAttendancePolicy(orgId: string): Promise<AttendancePolicy> {
  const sql = await pg();
  const [row] = await sql<{ p: unknown }[]>`select attendance_policy as p from public.organizations where id = ${orgId}`;
  return toPolicy(row?.p);
}

/** Owner/admin changes the billing rules (the caller checked the role). Strict audit: fees depend on it. */
export async function setAttendancePolicy(orgId: string, policy: AttendancePolicy, actor: MarkActor): Promise<AttendancePolicy> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [before] = await tx<{ p: unknown }[]>`select attendance_policy as p from public.organizations where id = ${orgId} for update`;
    await tx`update public.organizations set attendance_policy = ${tx.json(policy)} where id = ${orgId}`;
    await auditStrict(
      {
        ...actor,
        orgId,
        action: "org.attendance_policy_changed",
        entity: "organization",
        entityId: orgId,
        details: { from: toPolicy(before?.p), to: policy },
      },
      tx,
    );
    return policy;
  }) as Promise<AttendancePolicy>;
}

// ---------- register (FR-3) ----------

export type RegisterRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  attendance: Attendance | null;
  billable: boolean | null;
  marked_at: string | null;
  child_name: string | null;
  case_id: string | null;
  provider_profile_id: string;
  provider_name: string;
  service_name: string;
  mode: "in_clinic" | "video";
  fee_inr: number;
  series_id: string | null;
};

export type RegisterOrg = { id: string; name: string; manage: boolean };

export type Register = {
  org: RegisterOrg;
  orgs: RegisterOrg[];
  date: string;
  today: string;
  /** Earliest date the viewer may open (members: 7 days back; owner/admin: null = any). */
  minDate: string | null;
  timeZone: string;
  rows: RegisterRow[];
  policy: AttendancePolicy;
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const REGISTER_SELECT = (sql: Queryable) => sql`
  select a.id, lower(a.slot) as starts_at, upper(a.slot) as ends_at, a.status, a.attendance, a.billable,
         a.attendance_marked_at as marked_at, c.display_name as child_name, a.case_id, a.provider_profile_id,
         coalesce(a.service_snapshot ->> 'provider_name', p.display_name) as provider_name,
         a.service_snapshot ->> 'name' as service_name, a.service_snapshot ->> 'mode' as mode,
         coalesce((a.service_snapshot ->> 'fee_inr')::int, 0) as fee_inr, a.series_id
  from public.appointments a
  join public.provider_profiles p on p.id = a.provider_profile_id
  left join public.children c on c.id = a.child_id and c.deleted_at is null`;

function toRow(r: Record<string, unknown>): RegisterRow {
  return { ...(r as unknown as RegisterRow), starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), marked_at: isoOrNull(r.marked_at) };
}

/** Sessions of the register: still to mark (confirmed) or with an outcome (completed / no-show / marked cancellation). */
const ON_REGISTER = (sql: Queryable) => sql`(a.status in ('confirmed', 'completed', 'no_show') or a.attendance is not null)`;

function orgsOf(memberships: Membership[]): RegisterOrg[] {
  return memberships.map((m) => ({ id: m.org.id, name: m.org.name, manage: canManage(m.org_role) }));
}

/**
 * The register for one organisation and local date (viewer's time zone): owner/admin see every session of the org,
 * members their own (sessions of the provider profile bound to them). Null when the user is in no organisation.
 * `date` outside the member's window falls back to today.
 */
export async function loadRegister(
  userId: string,
  opts: { orgId?: string | null; date?: string | null; timeZone: string; now?: Date },
): Promise<Register | null> {
  const memberships = await listMemberships(userId);
  if (memberships.length === 0) return null;
  const orgs = orgsOf(memberships);
  const org = orgs.find((o) => o.id === opts.orgId) ?? orgs[0];
  const today = todayIn(opts.timeZone, opts.now);
  const minDate = org.manage ? null : addDays(today, -MEMBER_WINDOW_DAYS);
  let date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) && opts.date <= today ? opts.date : today;
  if (minDate && date < minDate) date = today;
  const from = wallToUtc(date, 0, opts.timeZone) ?? new Date(`${date}T00:00:00Z`);
  const to = wallToUtc(addDays(date, 1), 0, opts.timeZone) ?? new Date(`${addDays(date, 1)}T00:00:00Z`);
  const sql = await pg();
  const rows = await sql`
    ${REGISTER_SELECT(sql)}
    where a.org_id = ${org.id} and lower(a.slot) >= ${from} and lower(a.slot) < ${to} and ${ON_REGISTER(sql)}
      ${org.manage ? sql`` : sql`and p.user_id = ${userId}`}
    order by provider_name, lower(a.slot), a.id
    limit 500`;
  return { org, orgs, date, today, minDate, timeZone: opts.timeZone, rows: rows.map(toRow), policy: await getAttendancePolicy(org.id) };
}

/** Rows grouped by therapist (FR-3), each group in time order. */
export function groupByTherapist(rows: RegisterRow[]): { provider_profile_id: string; provider_name: string; rows: RegisterRow[] }[] {
  const groups = new Map<string, { provider_profile_id: string; provider_name: string; rows: RegisterRow[] }>();
  for (const r of rows) {
    const g = groups.get(r.provider_profile_id) ?? { provider_profile_id: r.provider_profile_id, provider_name: r.provider_name, rows: [] };
    g.rows.push(r);
    groups.set(r.provider_profile_id, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: g.rows.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) }))
    .sort((a, b) => a.provider_name.localeCompare(b.provider_name));
}

// ---------- needs attention (FR-4) ----------

export type NeedsAttentionItem = {
  id: string;
  starts_at: string;
  child_name: string | null;
  provider_name: string;
  service_name: string;
  org_id: string;
  org_name: string;
  /** Owner/admin of the org, or a member inside the 7-day window: may mark it on the register. */
  can_mark: boolean;
};

/**
 * Sessions that started more than 24 h ago and were never marked, for every organisation of the user (owner/admin:
 * all sessions; members: their own). Self-contained so 052's provider "Today" panel can reuse it.
 */
export async function listNeedsAttention(userId: string, opts: { limit?: number } = {}): Promise<{ items: NeedsAttentionItem[]; total: number }> {
  const memberships = await listMemberships(userId);
  if (memberships.length === 0) return { items: [], total: 0 };
  const manageIds = memberships.filter((m) => canManage(m.org_role)).map((m) => m.org.id);
  const memberIds = memberships.filter((m) => !canManage(m.org_role)).map((m) => m.org.id);
  const sql = await pg();
  const scope = sql`(
    ${manageIds.length ? sql`a.org_id in ${sql(manageIds)}` : sql`false`}
    or (${memberIds.length ? sql`a.org_id in ${sql(memberIds)}` : sql`false`} and p.user_id = ${userId})
  )`;
  const rows = await sql`
    select a.id, lower(a.slot) as starts_at, c.display_name as child_name,
           coalesce(a.service_snapshot ->> 'provider_name', p.display_name) as provider_name,
           a.service_snapshot ->> 'name' as service_name, a.org_id, coalesce(o.public_name, o.name) as org_name,
           count(*) over () as total
    from public.appointments a
    join public.provider_profiles p on p.id = a.provider_profile_id
    join public.organizations o on o.id = a.org_id
    left join public.children c on c.id = a.child_id and c.deleted_at is null
    where a.status = 'confirmed' and a.attendance is null
      and lower(a.slot) < now() - make_interval(hours => ${NEEDS_ATTENTION_HOURS})
      and ${scope}
    order by lower(a.slot) desc, a.id
    limit ${opts.limit ?? 50}`;
  const windowStart = Date.now() - MEMBER_WINDOW_DAYS * 86_400_000;
  const items = rows.map((r) => {
    const starts = iso(r.starts_at);
    return {
      id: r.id as string,
      starts_at: starts,
      child_name: (r.child_name as string | null) ?? null,
      provider_name: r.provider_name as string,
      service_name: r.service_name as string,
      org_id: r.org_id as string,
      org_name: r.org_name as string,
      can_mark: manageIds.includes(r.org_id as string) || new Date(starts).getTime() >= windowStart,
    };
  });
  return { items, total: rows.length ? Number(rows[0].total) : 0 };
}

// ---------- case month (FR-6) ----------

export type CaseAttendanceRow = RegisterRow & { local_date: string };

/** The case's sessions in a month (viewer's zone): the case's own appointments and the child's in the case's org. */
export async function listCaseAttendance(kase: { id: string; org_id: string; child_id: string | null }, month: string, timeZone: string): Promise<CaseAttendanceRow[]> {
  const first = `${month}-01`;
  const next = (() => {
    const [y, m] = month.split("-").map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  })();
  const from = wallToUtc(first, 0, timeZone) ?? new Date(`${first}T00:00:00Z`);
  const to = wallToUtc(next, 0, timeZone) ?? new Date(`${next}T00:00:00Z`);
  const sql = await pg();
  const rows = await sql`
    ${REGISTER_SELECT(sql)}
    where a.org_id = ${kase.org_id}
      and (a.case_id = ${kase.id} ${kase.child_id ? sql`or a.child_id = ${kase.child_id}` : sql``})
      and lower(a.slot) >= ${from} and lower(a.slot) < ${to} and ${ON_REGISTER(sql)}
    order by lower(a.slot), a.id
    limit 400`;
  return rows.map((r) => {
    const row = toRow(r);
    return { ...row, local_date: todayIn(timeZone, new Date(row.starts_at)) };
  });
}
