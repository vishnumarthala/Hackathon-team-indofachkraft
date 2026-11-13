// 037 FR-3 / FR-4: the Meet jobs, run by the outbox worker (lib/notify/jobs.ts). Enqueued in the booking transaction by
// the `meet_jobs_from_outbox` trigger (migration 20261113003700): `appointment.confirmed` -> `meet.create`,
// `appointment.rescheduled` -> `meet.update` (or `meet.create` if there is no event yet), `appointment.cancelled` ->
// `meet.delete`. All three are idempotent:
//   * create looks the event up by the private extended property `dnm_appointment_id=<id>` before inserting, and the
//     insert's `conferenceData.createRequest.requestId` is the appointment id (D-2), so retries after a timeout never
//     create a second event;
//   * the event has no attendees and `sendUpdates=none` (D-5): the guardian's email never reaches the calendar;
//   * summary `DoctorNearMe video consultation`, description = app link only (no child data).
import { z } from "zod";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/notify/outbox";
import { JobError, type JobContext, type JobDefinition, type JobFailureContext } from "@/lib/notify/job-types";
import type { Tx } from "@/lib/pg";
import { googleApi, GoogleError, meetLinkOf, type CalendarEvent, type GoogleApi } from "./client";
import { accessTokenFor, markConnectionExpired, NotConnectedError } from "./connections";
import { TokenDecryptError } from "./crypto";

const payload = z.object({ appointment_id: z.uuid() }).strict();
type Payload = z.output<typeof payload>;

export const MEET_TOPICS = { create: "meet.create", update: "meet.update", delete: "meet.delete" } as const;

/** FR-4: 5 attempts (first + 4 retries over ~50 minutes), then `failed` and the provider adds a link by hand. */
export const MEET_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
export const MEET_MAX_ATTEMPTS = MEET_RETRY_DELAYS_MS.length + 1;

type ApptRow = {
  id: string;
  provider_profile_id: string;
  status: string;
  mode: string | null;
  starts_at: Date;
  ends_at: Date;
  time_zone: string | null;
  meet_url: string | null;
  meet_status: string | null;
  google_event_id: string | null;
  cancel_reason: string | null;
};

async function loadAppointment(sql: Tx, id: string): Promise<ApptRow | null> {
  const [row] = await sql<ApptRow[]>`
    select a.id, a.provider_profile_id, a.status, a.service_snapshot ->> 'mode' as mode, lower(a.slot) as starts_at,
           upper(a.slot) as ends_at, coalesce(a.service_snapshot ->> 'time_zone', p.time_zone) as time_zone, a.meet_url,
           a.meet_status, a.google_event_id, a.cancel_reason
    from public.appointments a join public.provider_profiles p on p.id = a.provider_profile_id
    where a.id = ${id}`;
  return row ?? null;
}

function description(): string {
  const app = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return [
    "Video consultation booked on DoctorNearMe.",
    `Appointment details: ${app}/dashboard/schedule`,
    "The family joins signed in to their Google account: admit them from the Meet waiting room.",
  ].join("\n");
}

function times(a: ApptRow) {
  return { start: new Date(a.starts_at).toISOString(), end: new Date(a.ends_at).toISOString(), timeZone: a.time_zone || "Asia/Kolkata" };
}

/** Bounded wait for the appointment row lock (a concurrent cancel holds it only briefly); timeout -> retry later. */
async function withLockTimeout<T>(sql: Tx, fn: () => Promise<T>): Promise<T> {
  await sql`select set_config('lock_timeout', '5s', true)`;
  try {
    return await fn();
  } finally {
    await sql`select set_config('lock_timeout', '0', true)`;
  }
}

/** Deletes every event of ours for this appointment id (cleanup after a cancel or a lost race). */
async function deleteEvents(api: GoogleApi, token: string, appointmentId: string, knownEventId: string | null): Promise<number> {
  const ids = new Set<string>(knownEventId ? [knownEventId] : []);
  for (const e of await api.findEvents(token, appointmentId)) ids.add(e.id);
  let deleted = 0;
  for (const id of ids) if (await api.deleteEvent(token, id)) deleted += 1;
  return deleted;
}

/** Converts connection/token problems into permanent job errors (handled in onFailure). */
async function tokenOrFail(sql: Tx, a: ApptRow, api: GoogleApi): Promise<string> {
  try {
    return await accessTokenFor(sql, a.provider_profile_id, api);
  } catch (err) {
    if (err instanceof NotConnectedError) throw new JobError(err.message, true);
    if (err instanceof TokenDecryptError) throw new JobError("google_token_unreadable", true);
    if (err instanceof GoogleError && err.code === "invalid_grant") throw new JobError("google_token_expired", true);
    throw err;
  }
}

async function ensureEvent(a: ApptRow, api: GoogleApi, token: string): Promise<CalendarEvent> {
  const found = await api.findEvents(token, a.id);
  let event: CalendarEvent | null = found[0] ?? null;
  // Never more than one: an extra copy (should not happen) is removed.
  for (const extra of found.slice(1)) await api.deleteEvent(token, extra.id);
  if (!event) event = await api.insertEvent(token, { ...times(a), appointmentId: a.id, description: description() });
  if (!meetLinkOf(event)) {
    // Conference creation can be asynchronous: read it back once, otherwise retry later (the lookup finds this event).
    event = (await api.getEvent(token, event.id)) ?? event;
    if (!meetLinkOf(event)) throw new JobError("meet_conference_pending", false);
  }
  return event;
}

async function createRun(p: Payload, { sql }: JobContext, api: GoogleApi = googleApi()): Promise<void> {
  const a = await loadAppointment(sql, p.appointment_id);
  if (!a || a.mode !== "video") return;
  if (a.status !== "confirmed") {
    // Cancelled (or moved) before the link existed: remove anything an earlier timed-out attempt created.
    if (a.cancel_reason === "rescheduled" && a.google_event_id) return; // the event moved to the new appointment
    const token = await accessTokenFor(sql, a.provider_profile_id, api).catch(() => null);
    if (token) await deleteEvents(api, token, a.id, null);
    return;
  }
  if ((a.meet_status === "created" || a.meet_status === "manual") && a.meet_url) return;

  const token = await tokenOrFail(sql, a, api);
  const event = await ensureEvent(a, api, token);
  const link = meetLinkOf(event) as string;
  const updated = await withLockTimeout(sql, () => sql<{ id: string }[]>`
    update public.appointments set meet_url = ${link}, google_event_id = ${event.id}, meet_status = 'created', updated_at = now()
    where id = ${a.id} and status = 'confirmed' and coalesce(meet_status, 'pending') in ('pending', 'failed')
    returning id`);
  if (updated.length === 0) {
    const now = await loadAppointment(sql, a.id);
    if (now?.status !== "confirmed") await deleteEvents(api, token, a.id, event.id); // cancelled meanwhile
    return; // or a manual link was added meanwhile: keep it (the provider's choice), leave the calendar event
  }
  const [{ payload: notifyPayload }] = await sql<{ payload: Record<string, unknown> }[]>`select public.booking_notify_payload(${a.id}) as payload`;
  await enqueue(sql, {
    topic: "appointment.meet_ready",
    aggregateType: "appointment_meet",
    aggregateId: a.id,
    payload: notifyPayload as never,
    dedupKey: `appt:${a.id}:meet_ready`,
  });
}

async function createFailure(p: Payload, { sql, error, final }: JobFailureContext): Promise<void> {
  const a = await loadAppointment(sql, p.appointment_id);
  if (!a) return;
  if (error instanceof JobError && error.code === "google_token_expired") await markConnectionExpired(sql, a.provider_profile_id);
  if (!final) return;
  // FR-4: provider sees `Add a video link`; the guardian `Your provider will share the video link soon.`
  const failed = await withLockTimeout(sql, () => sql<{ id: string }[]>`
    update public.appointments set meet_status = 'failed', updated_at = now()
    where id = ${a.id} and status = 'confirmed' and coalesce(meet_status, 'pending') = 'pending'
    returning id`);
  if (failed.length === 0) return;
  const [{ payload: notifyPayload }] = await sql<{ payload: Record<string, unknown> }[]>`select public.booking_notify_payload(${a.id}) as payload`;
  await enqueue(sql, {
    topic: "appointment.meet_failed",
    aggregateType: "appointment_meet",
    aggregateId: a.id,
    payload: notifyPayload as never,
    dedupKey: `appt:${a.id}:meet_failed`,
  });
}

/** Reschedule: patch the moved event (same link for the guardian), re-key it to the new appointment id. */
async function updateRun(p: Payload, ctx: JobContext, api: GoogleApi = googleApi()): Promise<void> {
  const { sql } = ctx;
  const a = await loadAppointment(sql, p.appointment_id);
  if (!a || a.mode !== "video") return;
  if (a.status !== "confirmed" || !a.google_event_id) return createRun(p, ctx, api);
  const token = await tokenOrFail(sql, a, api);
  const patched = await api.patchEvent(token, a.google_event_id, { ...times(a), appointmentId: a.id, description: description() });
  if (patched) return;
  // The provider deleted the event in Google Calendar: create a new one (the guardian gets the new link).
  await withLockTimeout(sql, () => sql`
    update public.appointments set meet_url = null, google_event_id = null, meet_status = 'pending', updated_at = now()
    where id = ${a.id} and meet_status = 'created'`);
  await createRun(p, ctx, api);
}

async function updateFailure(p: Payload, ctx: JobFailureContext): Promise<void> {
  const a = await loadAppointment(ctx.sql, p.appointment_id);
  if (a && ctx.error instanceof JobError && ctx.error.code === "google_token_expired") await markConnectionExpired(ctx.sql, a.provider_profile_id);
  // The Meet link keeps working at the new time; only the provider's calendar entry may show the old time.
  if (a?.meet_status === "pending") await createFailure(p, ctx);
}

/** Cancel: delete the calendar event (known id + lookup). Not for the old half of a reschedule (the event moved). */
async function deleteRun(p: Payload, { sql }: JobContext, api: GoogleApi = googleApi()): Promise<void> {
  const a = await loadAppointment(sql, p.appointment_id);
  if (!a || a.status === "confirmed" || a.cancel_reason === "rescheduled") return;
  const token = await tokenOrFail(sql, a, api);
  await deleteEvents(api, token, a.id, a.google_event_id);
  await sql`update public.appointments set google_event_id = null where id = ${a.id}`;
}

async function deleteFailure(p: Payload, ctx: JobFailureContext): Promise<void> {
  const a = await loadAppointment(ctx.sql, p.appointment_id);
  if (a && ctx.error instanceof JobError && ctx.error.code === "google_token_expired") await markConnectionExpired(ctx.sql, a.provider_profile_id);
}

export const MEET_JOBS: Record<string, JobDefinition<typeof payload>> = {
  [MEET_TOPICS.create]: {
    payload,
    maxAttempts: MEET_MAX_ATTEMPTS,
    retryDelaysMs: MEET_RETRY_DELAYS_MS,
    run: (p, ctx) => createRun(p, ctx),
    onFailure: createFailure,
  },
  [MEET_TOPICS.update]: {
    payload,
    maxAttempts: MEET_MAX_ATTEMPTS,
    retryDelaysMs: MEET_RETRY_DELAYS_MS,
    run: (p, ctx) => updateRun(p, ctx),
    onFailure: updateFailure,
  },
  [MEET_TOPICS.delete]: {
    payload,
    maxAttempts: MEET_MAX_ATTEMPTS,
    retryDelaysMs: MEET_RETRY_DELAYS_MS,
    run: (p, ctx) => deleteRun(p, ctx),
    onFailure: deleteFailure,
  },
};
