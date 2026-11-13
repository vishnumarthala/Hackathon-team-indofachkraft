// 037: Meet links on appointments - Google-account check for video bookings (FR-5a), the join window (FR-5),
// manual links (FR-4) and the read model for the family list and the provider agenda.
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { drainSoon, enqueue } from "@/lib/notify/outbox";
import { pg, type Queryable } from "@/lib/pg";

export type MeetStatus = "not_needed" | "pending" | "created" | "failed" | "manual";

/** FR-5: `Join video call` from 10 minutes before the start until 30 minutes after the end. */
export const JOIN_OPENS_MIN_BEFORE = 10;
export const JOIN_CLOSES_MIN_AFTER = 30;

export const GOOGLE_ACCOUNT_REQUIRED = "Link your Google account to book a video consultation";

export function joinWindow(startsAt: string | Date, endsAt: string | Date): { opens: Date; closes: Date } {
  return {
    opens: new Date(new Date(startsAt).getTime() - JOIN_OPENS_MIN_BEFORE * 60_000),
    closes: new Date(new Date(endsAt).getTime() + JOIN_CLOSES_MIN_AFTER * 60_000),
  };
}

export type JoinState = "open" | "not_yet" | "closed";

export function joinState(startsAt: string | Date, endsAt: string | Date, now: Date = new Date()): JoinState {
  const { opens, closes } = joinWindow(startsAt, endsAt);
  if (now < opens) return "not_yet";
  return now <= closes ? "open" : "closed";
}

const MEET_CODE = /^[a-z0-9][a-z0-9-]{2,63}$/;

/**
 * FR-4: a pasted link must be a Google Meet room: `https://meet.google.com/<code>` (query, fragment and a trailing
 * slash are dropped). Anything else -> null (400).
 */
export function normalizeMeetUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 300) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "meet.google.com" || url.port || url.username || url.password) return null;
  const code = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  return MEET_CODE.test(code) ? `https://meet.google.com/${code}` : null;
}

/** FR-5a: the guardian has a linked Google identity (019 `linkIdentity`, or signed up with Google). */
export async function hasGoogleIdentity(userId: string, sql?: Queryable): Promise<boolean> {
  const db = sql ?? (await pg());
  const [row] = await db<{ ok: boolean }[]>`
    select exists (select 1 from auth.identities where user_id = ${userId}::uuid and provider = 'google') as ok`;
  return row.ok;
}

export type MeetInfo = { meet_url: string | null; meet_status: MeetStatus | null };

/** Meet fields for appointments the caller has already been authorised to see. */
export async function getMeetInfo(appointmentIds: string[]): Promise<Map<string, MeetInfo>> {
  if (appointmentIds.length === 0) return new Map();
  const sql = await pg();
  const rows = await sql<({ id: string } & MeetInfo)[]>`
    select id, meet_url, meet_status from public.appointments where id in ${sql(appointmentIds)}`;
  return new Map(rows.map((r) => [r.id, { meet_url: r.meet_url, meet_status: r.meet_status }]));
}

/** Pending Meet jobs of an appointment, delivered right after the response (the cron is the fallback). */
export async function drainMeetJobs(appointmentId: string | null | undefined): Promise<void> {
  if (!appointmentId) return;
  try {
    const sql = await pg();
    const rows = await sql<{ id: string }[]>`
      select id::text as id from public.outbox_events
      where aggregate_type = 'meet' and aggregate_id = ${appointmentId}::uuid and status = 'pending' and deliver_after <= now()`;
    if (rows.length) drainSoon(rows.map((r) => r.id));
  } catch {
    // Best effort: the every-minute cron runs the jobs anyway.
  }
}

export type ManualLinkResult = { ok: true; meet_url: string } | { ok: false; code: "not_found" | "not_video" | "invalid_state" };

/**
 * FR-4: the provider side (profile owner or an org owner/admin, the same rule as 030's cancel) pastes a Meet link for a
 * confirmed video appointment whose automatic link failed (or replaces an earlier manual link). The guardian is told
 * once (`appointment.meet_ready`). Strict audit in the same transaction.
 */
export async function setManualMeetLink(input: { appointmentId: string; meetUrl: string; actor: SessionAuditActor }): Promise<ManualLinkResult> {
  const sql = await pg();
  const result = await sql.begin(async (tx): Promise<{ result: ManualLinkResult; eventId: string | null }> => {
    const [a] = await tx<{ id: string; status: string; mode: string | null; meet_status: MeetStatus | null; ends_at: Date; is_provider: boolean; child_id: string | null; org_id: string }[]>`
      select a.id, a.status, a.service_snapshot ->> 'mode' as mode, a.meet_status, upper(a.slot) as ends_at, a.child_id, a.org_id,
             public.booking_is_provider(a.provider_profile_id, a.org_id, ${input.actor.actorUserId}::uuid) as is_provider
      from public.appointments a where a.id = ${input.appointmentId} for update`;
    if (!a || !a.is_provider) return { result: { ok: false, code: "not_found" }, eventId: null };
    if (a.mode !== "video") return { result: { ok: false, code: "not_video" }, eventId: null };
    if (a.status !== "confirmed" || !["failed", "manual"].includes(a.meet_status ?? "") || new Date(a.ends_at).getTime() < Date.now()) {
      return { result: { ok: false, code: "invalid_state" }, eventId: null };
    }
    await tx`update public.appointments set meet_url = ${input.meetUrl}, meet_status = 'manual', updated_at = now() where id = ${a.id}`;
    const [{ payload }] = await tx<{ payload: Record<string, unknown> }[]>`select public.booking_notify_payload(${a.id}) as payload`;
    const eventId = await enqueue(tx, {
      topic: "appointment.meet_ready",
      aggregateType: "appointment_meet",
      aggregateId: a.id,
      payload: payload as never,
      dedupKey: `appt:${a.id}:meet_ready`,
    });
    await auditStrict(
      {
        ...input.actor,
        action: "appointment.meet_link_set",
        entity: "appointment",
        entityId: a.id,
        orgId: a.org_id,
        childId: a.child_id,
        details: { previous_status: a.meet_status },
      },
      tx,
    );
    return { result: { ok: true, meet_url: input.meetUrl }, eventId };
  });
  if (result.eventId) drainSoon([result.eventId]);
  return result.result;
}
