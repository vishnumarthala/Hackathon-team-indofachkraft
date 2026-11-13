// Ticket 043: recurring therapy sessions (weekly series). Server-only data access + request schemas + error mapping.
// A series generates real `confirmed` appointments on a rolling 8-week horizon (SQL `series_materialize`, migration
// 20261113004300_appointment_series.sql); clashes become `series_conflicts`. Every write goes through one
// security-definer SQL function that re-checks the actor (FR-2: org owner/admin, or the provider bound to the
// profile, always an active member); routes gate first (requireProviderApi + case access / getManageableSeries) and
// answer 404 for other tenants' ids. "This session only" uses 030's cancel / reschedule routes unchanged.
import { NextResponse } from "next/server";
import { z } from "zod";
import { errorMessage, logger } from "@/lib/log";
import { pg, type Queryable } from "@/lib/pg";
import { isValidDate } from "./time";

const log = logger("series");

// ---------- schemas ----------

const uuid = z.uuid();
const dateField = z.string().refine(isValidDate, "Use YYYY-MM-DD");
const timeField = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
export const BILLING_MODES = ["package", "per_session", "free"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
const weekdaysField = z
  .array(z.number().int().min(0).max(6))
  .min(1, "Choose at least one day")
  .max(4, "Choose up to 4 days")
  .refine((days) => new Set(days).size === days.length, "Each day once")
  .transform((days) => [...days].sort((a, b) => a - b));

export const SeriesCreateSchema = z
  .object({
    case_id: uuid,
    provider_profile_id: uuid,
    service_id: uuid,
    weekdays: weekdaysField,
    start_time: timeField,
    starts_on: dateField,
    ends_on: dateField.nullable().optional(),
    billing_mode: z.enum(BILLING_MODES),
    /** Show the timetable in the family's app and send them updates (the child's linked guardian account). */
    notify_family: z.boolean().default(true),
  })
  .refine((s) => !s.ends_on || s.ends_on >= s.starts_on, { path: ["ends_on"], message: "End after start" });

/** "This and future sessions": omitted fields stay as they are; `ends_on: null` removes the end date. */
export const SeriesChangeSchema = z
  .object({
    from: dateField,
    provider_profile_id: uuid.optional(),
    service_id: uuid.optional(),
    weekdays: weekdaysField.optional(),
    start_time: timeField.optional(),
    ends_on: dateField.nullable().optional(),
    billing_mode: z.enum(BILLING_MODES).optional(),
  })
  .refine((s) => !s.ends_on || s.ends_on >= s.from, { path: ["ends_on"], message: "End after the change date" })
  .refine((s) => !s.provider_profile_id || s.service_id, { path: ["service_id"], message: "Choose the new therapist's service" });

export const SeriesPauseSchema = z
  .object({ from: dateField, to: dateField })
  .refine((s) => s.to >= s.from, { path: ["to"], message: "End after start" });

export const SeriesEndSchema = z.object({ ends_on: dateField.optional() });

export const ConflictResolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("reschedule"), start: z.iso.datetime({ offset: true }) }),
]);

export type SeriesCreate = z.output<typeof SeriesCreateSchema>;
export type SeriesChange = z.output<typeof SeriesChangeSchema>;

// ---------- errors (SQL booking_raise codes -> HTTP) ----------

export const SERIES_ERRORS = {
  not_found: { status: 404, error: "Not found" },
  invalid_input: { status: 400, error: "Invalid request" },
  case_required: { status: 422, error: "The child needs a case in this organisation first." },
  service_invalid: { status: 422, error: "Choose an active service of this therapist in this organisation." },
  guardian_not_linked: { status: 422, error: "That family account is not linked to this child." },
  starts_in_past: { status: 422, error: "The start date cannot be in the past." },
  pause_exists: { status: 409, error: "This timetable is already paused. Change the pause after it ends." },
  already_resolved: { status: 409, error: "This date was already handled." },
  invalid_transition: { status: 409, error: "This timetable has ended." },
  slot_taken: { status: 409, error: "This time is taken. Please pick another time." },
  blocked_date: { status: 422, error: "The therapist is not available on that date." },
  outside_hours: { status: 422, error: "This time is outside the therapist's weekly hours." },
  too_soon: { status: 422, error: "Pick a time at least 1 hour from now." },
} as const;

export type SeriesErrorCode = keyof typeof SERIES_ERRORS;

export function toSeriesErrorCode(err: unknown): SeriesErrorCode | null {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && Object.prototype.hasOwnProperty.call(SERIES_ERRORS, message) ? (message as SeriesErrorCode) : null;
}

export function seriesErrorResponse(code: SeriesErrorCode): Response {
  const { status, error } = SERIES_ERRORS[code];
  return NextResponse.json({ error, code }, { status });
}

export async function withSeriesErrors<T>(fn: () => Promise<T>): Promise<{ data: T } | { response: Response }> {
  try {
    return { data: await fn() };
  } catch (err) {
    const code = toSeriesErrorCode(err);
    if (code) return { response: seriesErrorResponse(code) };
    throw err;
  }
}

// ---------- types ----------

export type SeriesStatus = "active" | "paused" | "ended";
export type ConflictReason = "slot_taken" | "blocked_date" | "outside_hours";

export type SeriesRow = {
  id: string;
  org_id: string;
  provider_profile_id: string;
  provider_name: string;
  service_id: string | null;
  service_name: string;
  duration_min: number;
  mode: "in_clinic" | "video";
  location_name: string | null;
  child_id: string;
  case_id: string | null;
  guardian_user_id: string | null;
  weekdays: number[];
  start_time: string;
  time_zone: string;
  starts_on: string;
  ends_on: string | null;
  status: SeriesStatus;
  billing_mode: BillingMode;
  paused_from: string | null;
  paused_until: string | null;
  replaces_series_id: string | null;
  created_at: string;
};

export type OccurrenceRow = {
  id: string;
  series_id: string;
  occurrence_date: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  cancel_reason: string | null;
};

export type ConflictRow = {
  id: string;
  series_id: string;
  occurrence_date: string;
  reason: ConflictReason;
  /** The occurrence's usual start (the series time on that date), for `Pick another time`. */
  usual_start: string;
  provider_name: string;
  service_name: string;
  child_name: string | null;
  case_id: string | null;
  time_zone: string;
};

export type MaterializeResult = { created: number; conflicts: { date: string; reason: ConflictReason }[] };

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const SERIES_SELECT = (sql: Queryable) => sql`
  select s.id, s.org_id, s.provider_profile_id, coalesce(s.service_snapshot ->> 'provider_name', p.display_name) as provider_name,
         s.service_id, s.service_snapshot ->> 'name' as service_name, (s.service_snapshot ->> 'duration_min')::int as duration_min,
         s.service_snapshot ->> 'mode' as mode, s.service_snapshot -> 'location' ->> 'name' as location_name,
         s.child_id, s.case_id, s.guardian_user_id, s.weekdays::int[] as weekdays, to_char(s.start_time, 'HH24:MI') as start_time,
         s.time_zone, s.starts_on::text as starts_on, s.ends_on::text as ends_on, s.status, s.billing_mode,
         s.paused_from::text as paused_from, s.paused_until::text as paused_until, s.replaces_series_id, s.created_at
  from public.appointment_series s join public.provider_profiles p on p.id = s.provider_profile_id`;

function toSeries(row: Record<string, unknown>): SeriesRow {
  return { ...(row as unknown as SeriesRow), created_at: iso(row.created_at), weekdays: (row.weekdays as number[]).map(Number) };
}

// ---------- access ----------

/** FR-2 gate for /api/provider/series/:id: the series if the user may manage it, else null (route answers 404). */
export async function getManageableSeries(seriesId: string, userId: string): Promise<SeriesRow | null> {
  const sql = await pg();
  const rows = await sql`
    ${SERIES_SELECT(sql)}
    where s.id = ${seriesId} and public.series_can_manage(s.org_id, s.provider_profile_id, ${userId}::uuid)`;
  return rows[0] ? toSeries(rows[0]) : null;
}

/** The conflict's series if the user may manage it, else null. */
export async function getManageableConflict(conflictId: string, userId: string): Promise<{ series: SeriesRow; conflictId: string } | null> {
  const sql = await pg();
  const [row] = await sql<{ series_id: string }[]>`select series_id from public.series_conflicts where id = ${conflictId}`;
  if (!row) return null;
  const series = await getManageableSeries(row.series_id, userId);
  return series ? { series, conflictId } : null;
}

// ---------- writes ----------

type CreateArgs = {
  actorUserId: string;
  orgId: string;
  caseId: string;
  childId: string;
  profileId: string;
  serviceId: string;
  weekdays: number[];
  startTime: string;
  startsOn: string;
  endsOn?: string | null;
  billingMode: BillingMode;
  /** "auto" = the child's first active guardian link (if any); null = no family account (paper consent). */
  guardian: "auto" | string | null;
};

export type CreateResult = MaterializeResult & { series_id: string };

/** The guardian whose app shows the series: the child's earliest active guardian link, or null. */
export async function defaultGuardianFor(childId: string, sql?: Queryable): Promise<string | null> {
  const db = sql ?? (await pg());
  const [row] = await db<{ user_id: string }[]>`
    select gl.user_id from public.guardian_links gl join public.user_profiles u on u.id = gl.user_id and u.role = 'guardian'
    where gl.child_id = ${childId} and gl.status = 'active' order by gl.created_at, gl.id limit 1`;
  return row?.user_id ?? null;
}

/**
 * FR-2/FR-3: validates (in SQL), creates, materializes 8 weeks and enqueues one summary message - one transaction.
 * `tx` (044, 047 import): run inside the caller's open transaction instead (the caller handles savepoints).
 */
export async function createSeries(args: CreateArgs, tx?: Queryable): Promise<CreateResult> {
  const run = async (q: Queryable) => {
    const guardian = args.guardian === "auto" ? await defaultGuardianFor(args.childId, q) : args.guardian;
    const [row] = await q<{ r: CreateResult }[]>`
      select public.series_create(${args.actorUserId}::uuid, ${args.orgId}::uuid, ${args.profileId}::uuid, ${args.serviceId}::uuid,
        ${args.childId}::uuid, ${args.caseId}::uuid, ${guardian}::uuid, ${args.weekdays}::smallint[], ${args.startTime}::time,
        ${args.startsOn}::date, ${args.endsOn ?? null}::date, ${args.billingMode}) as r`;
    return row.r;
  };
  if (tx) return run(tx);
  const sql = await pg();
  return sql.begin((t) => run(t)) as Promise<CreateResult>;
}

export type ChangeResult = CreateResult & { cancelled: number; replaced_series_id: string };

/** FR-5 "This and future sessions". */
export async function changeSeriesFrom(seriesId: string, actorUserId: string, input: SeriesChange): Promise<ChangeResult> {
  const sql = await pg();
  const [row] = await sql<{ r: ChangeResult }[]>`
    select public.series_change_from(${seriesId}::uuid, ${actorUserId}::uuid, ${input.from}::date,
      ${input.provider_profile_id ?? null}::uuid, ${input.service_id ?? null}::uuid,
      ${input.weekdays ?? null}::smallint[], ${input.start_time ?? null}::time,
      ${input.ends_on ?? null}::date, ${input.ends_on === null}, ${input.billing_mode ?? null}) as r`;
  return row.r;
}

export async function pauseSeries(seriesId: string, actorUserId: string, from: string, to: string): Promise<{ series_id: string; cancelled: number }> {
  const sql = await pg();
  const [row] = await sql<{ r: { series_id: string; cancelled: number } }[]>`
    select public.series_pause(${seriesId}::uuid, ${actorUserId}::uuid, ${from}::date, ${to}::date) as r`;
  return row.r;
}

export async function endSeries(seriesId: string, actorUserId: string, endsOn?: string): Promise<{ series_id: string; cancelled: number }> {
  const sql = await pg();
  const [row] = await sql<{ r: { series_id: string; cancelled: number } }[]>`
    select public.series_end(${seriesId}::uuid, ${actorUserId}::uuid, ${endsOn ?? null}::date) as r`;
  return row.r;
}

export type ResolveResult = { conflict_id: string; resolution: "skipped" | "rescheduled"; appointment_id?: string };

export async function resolveConflict(
  conflictId: string,
  actorUserId: string,
  input: { action: "skip" } | { action: "reschedule"; start: string },
): Promise<ResolveResult> {
  const sql = await pg();
  const [row] = await sql<{ r: ResolveResult }[]>`
    select public.series_resolve_conflict(${conflictId}::uuid, ${actorUserId}::uuid, ${input.action},
      ${input.action === "reschedule" ? input.start : null}::timestamptz) as r`;
  return row.r;
}

/** FR-3 for one series (tests, manual runs). `until` defaults to 8 weeks ahead in the series' time zone. */
export async function materializeSeries(seriesId: string, until?: string, sql?: Queryable): Promise<MaterializeResult> {
  const db = sql ?? (await pg());
  const [row] = await db<{ r: MaterializeResult }[]>`select public.series_materialize(${seriesId}::uuid, ${until ?? null}::date) as r`;
  return row.r;
}

export type MaterializeTotals = { series: number; created: number; conflicts: number; failed: number };

/** Materializes the given series, `concurrency` at a time, each in its own transaction (NFR-1). */
export async function materializeMany(ids: string[], opts: { concurrency?: number; until?: string } = {}): Promise<MaterializeTotals> {
  const sql = await pg();
  let next = 0;
  const totals = { series: ids.length, created: 0, conflicts: 0, failed: 0 };
  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const r = await materializeSeries(id, opts.until, sql);
        totals.created += r.created;
        totals.conflicts += r.conflicts.length;
      } catch (err) {
        totals.failed += 1;
        log.warn("materialize failed", { series_id: id, error: errorMessage(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, ids.length)) }, worker));
  return totals;
}

/**
 * FR-4 rolling horizon (cron): flips finished pauses/ends, then materializes every live series up to 8 weeks ahead and
 * schedules the next reminder. One transaction per series (each takes its series lock, then 030's provider lock), a
 * few in parallel; a series that fails is logged and retried next run.
 */
export async function materializeDueSeries(opts: { concurrency?: number; limit?: number } = {}): Promise<MaterializeTotals> {
  const sql = await pg();
  const ids = (await sql<{ id: string }[]>`select public.series_due(${opts.limit ?? 2000}) as id`).map((r) => r.id);
  return materializeMany(ids, { concurrency: opts.concurrency });
}

// ---------- reads ----------

/** The case's series (newest first) with their upcoming occurrences and open conflicts (Timetable card). */
export type CaseSeries = SeriesRow & { can_manage: boolean; upcoming: OccurrenceRow[]; conflicts: ConflictRow[] };

/** `can_manage`: the viewer may change it (FR-2); other case members only see it. */
export async function listCaseSeries(caseId: string, userId: string): Promise<CaseSeries[]> {
  const sql = await pg();
  const rows = (
    await sql`
      select x.*, public.series_can_manage(x.org_id, x.provider_profile_id, ${userId}::uuid) as can_manage
      from (${SERIES_SELECT(sql)} where s.case_id = ${caseId}) x
      order by (x.status = 'ended'), x.created_at desc limit 50`
  ).map((r) => ({ ...toSeries(r), can_manage: Boolean(r.can_manage) }));
  if (rows.length === 0) return [];
  const ids = rows.map((s) => s.id);
  const occurrences = await listOccurrences(ids, { upcomingOnly: true, limit: 400 });
  const conflicts = await listOpenConflicts({ seriesIds: ids });
  return rows.map((s) => ({
    ...s,
    upcoming: occurrences.filter((o) => o.series_id === s.id),
    conflicts: conflicts.filter((c) => c.series_id === s.id),
  }));
}

export async function listOccurrences(seriesIds: string[], opts: { upcomingOnly?: boolean; limit?: number } = {}): Promise<OccurrenceRow[]> {
  if (seriesIds.length === 0) return [];
  const sql = await pg();
  const rows = await sql`
    select a.id, a.series_id, a.series_occurrence_date::text as occurrence_date, lower(a.slot) as starts_at, upper(a.slot) as ends_at,
           a.status, a.cancel_reason
    from public.appointments a
    where a.series_id in ${sql(seriesIds)}
      ${opts.upcomingOnly ? sql`and a.status = 'confirmed' and upper(a.slot) > now()` : sql``}
    order by lower(a.slot)
    limit ${opts.limit ?? 400}`;
  return rows.map((r) => ({ ...(r as unknown as OccurrenceRow), starts_at: iso(r.starts_at), ends_at: iso(r.ends_at) }));
}

async function listOpenConflicts(filter: { seriesIds: string[] } | { manageableBy: string }): Promise<ConflictRow[]> {
  const sql = await pg();
  const where =
    "seriesIds" in filter
      ? sql`s.id in ${sql(filter.seriesIds)}`
      : sql`public.series_can_manage(s.org_id, s.provider_profile_id, ${filter.manageableBy}::uuid)`;
  const rows = await sql`
    select c.id, c.series_id, c.occurrence_date::text as occurrence_date, c.reason,
           public.series_occurrence_start(c.occurrence_date, s.start_time, s.time_zone) as usual_start,
           coalesce(s.service_snapshot ->> 'provider_name', p.display_name) as provider_name, s.service_snapshot ->> 'name' as service_name,
           ch.display_name as child_name, s.case_id, s.time_zone
    from public.series_conflicts c
    join public.appointment_series s on s.id = c.series_id
    join public.provider_profiles p on p.id = s.provider_profile_id
    left join public.children ch on ch.id = s.child_id and ch.deleted_at is null
    where c.resolved_at is null and ${where}
    order by c.occurrence_date, c.created_at
    limit 200`;
  return rows.map((r) => ({ ...(r as unknown as ConflictRow), usual_start: iso(r.usual_start) }));
}

/** FR-6 `Conflicts` list on /dashboard/schedule: open conflicts of the series the user manages (their own profile's,
 * plus every series of the organisations they own/administer). */
export async function listManageableConflicts(userId: string): Promise<ConflictRow[]> {
  return listOpenConflicts({ manageableBy: userId });
}

/** FR-7: the guardian's live timetables (their own series), for /family/appointments. */
export async function listGuardianSeries(userId: string): Promise<(SeriesRow & { child_name: string | null })[]> {
  const sql = await pg();
  const rows = await sql`
    select x.*, ch.display_name as child_name from (
      ${SERIES_SELECT(sql)} where s.guardian_user_id = ${userId} and s.status in ('active', 'paused')
    ) x
    left join public.children ch on ch.id = x.child_id and ch.deleted_at is null
    join public.guardian_links gl on gl.child_id = x.child_id and gl.user_id = ${userId} and gl.status = 'active'
    order by x.created_at`;
  return rows.map((r) => ({ ...toSeries(r), child_name: (r.child_name as string | null) ?? null }));
}

export type SeriesFormOptions = {
  therapists: { profile_id: string; name: string; services: { id: string; name: string; mode: "in_clinic" | "video"; duration_min: number; location_name: string | null }[] }[];
  hasGuardian: boolean;
  /** Clinic time zone per profile (first service's), so the form can say which zone the time is in. */
  timeZone: string;
};

/**
 * Timetable form choices for a case: therapists of the case's org with active in-clinic/video services there. Org
 * owners/admins see every therapist; other members only their own profile (FR-2).
 */
export async function seriesFormOptions(caseId: string, userId: string): Promise<SeriesFormOptions & { orgId: string; childId: string } | null> {
  const sql = await pg();
  const [kase] = await sql<{ org_id: string; child_id: string }[]>`select org_id, child_id from public.cases where id = ${caseId}`;
  if (!kase) return null;
  const services = await sql<{ profile_id: string; name: string; id: string; service_name: string; mode: "in_clinic" | "video"; duration_min: number; location_name: string | null; time_zone: string }[]>`
    select p.id as profile_id, p.display_name as name, s.id, s.name as service_name, s.mode, s.duration_min, l.name as location_name,
           coalesce(l.time_zone, p.time_zone) as time_zone
    from public.services s
    join public.provider_profiles p on p.id = s.provider_profile_id and not p.is_synthetic
    left join public.practice_locations l on l.id = s.location_id
    where s.org_id = ${kase.org_id} and s.active and s.mode in ('in_clinic', 'video')
      and public.series_can_manage(s.org_id, p.id, ${userId}::uuid)
    order by p.display_name, s.name`;
  const therapists: SeriesFormOptions["therapists"] = [];
  for (const s of services) {
    let t = therapists.find((x) => x.profile_id === s.profile_id);
    if (!t) therapists.push((t = { profile_id: s.profile_id, name: s.name, services: [] }));
    t.services.push({ id: s.id, name: s.service_name, mode: s.mode, duration_min: s.duration_min, location_name: s.location_name });
  }
  const guardian = await defaultGuardianFor(kase.child_id, sql);
  return { orgId: kase.org_id, childId: kase.child_id, therapists, hasGuardian: guardian !== null, timeZone: services[0]?.time_zone ?? "Asia/Kolkata" };
}
