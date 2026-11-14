// Ticket 052 FR-6: "What happens next" after booking. The four steps of a visit with their live status:
// Permissions -> Intake call (only when the service has one, 035) -> Visit -> Home program (026). Shown on the booking
// confirmation (`/family/appointments/<id>?booked=1`) and on `/family/appointments/<id>`. `journeySteps` is pure;
// `loadAppointmentJourney` gates on the booking guardian + an active link to the child (anyone else: null -> 404).
import { effectiveAttendance } from "@/lib/booking/attendance-display";
import type { AppointmentView } from "@/lib/booking/store";
import { getAppointment } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { getActiveGuardianLink } from "@/lib/children";
import { intakeAttemptPath } from "@/lib/intake/attempt-token";
import { pg } from "@/lib/pg";
import { appointmentHref, homeProgramHref, permissionHref, visitDay } from "./next-step";

export type JourneyStepKey = "permissions" | "intake" | "visit" | "home";
/** done = finished; due = the family can act now; waiting = nothing to do yet (we say why); upcoming = later; skipped. */
export type JourneyStatus = "done" | "due" | "waiting" | "upcoming" | "skipped";
/** Message key under `family.journey.steps.<step>` plus the action, when there is one. */
export type JourneyStep = {
  key: JourneyStepKey;
  status: JourneyStatus;
  detail: string;
  action: { label: string; href: string; external?: boolean } | null;
};

export type JourneyInput = {
  appointment: Pick<AppointmentView, "id" | "status" | "starts_at" | "ends_at" | "attendance" | "provider_profile_id" | "child_id"> & {
    mode: "in_clinic" | "video";
    has_intake: boolean;
  };
  intake_consent: boolean;
  attempt: { id: string; status: "issued" | "started" | "completed"; path: string | null } | null;
  /** The child has a published, guardian-visible home program (any organisation). */
  home_program: boolean;
  timeZone: string;
};

export function journeySteps(input: JourneyInput, now: Date = new Date()): JourneyStep[] {
  const a = input.appointment;
  const childId = a.child_id ?? "";
  const ended = Date.parse(a.ends_at) <= now.getTime();
  const cancelled = a.status === "cancelled" || a.status === "expired";
  const outcome = effectiveAttendance(a);
  const attended = outcome === "present";
  const steps: JourneyStep[] = [];

  // 1. Permissions: only the AI intake call needs one before the visit; the rest can be reviewed any time.
  if (a.has_intake && !input.intake_consent && !cancelled && !ended && input.attempt?.status !== "completed") {
    steps.push({ key: "permissions", status: "due", detail: "needed", action: { label: "give", href: permissionHref(childId) } });
  } else {
    steps.push({
      key: "permissions",
      status: "done",
      detail: a.has_intake ? "given" : "notNeeded",
      action: { label: "review", href: permissionHref(childId) },
    });
  }

  // 2. Intake call (035), only when the service has one.
  if (a.has_intake) {
    if (input.attempt?.status === "completed") steps.push({ key: "intake", status: "done", detail: "done", action: null });
    else if (cancelled || ended) steps.push({ key: "intake", status: "skipped", detail: "skipped", action: null });
    else if (!input.intake_consent) steps.push({ key: "intake", status: "waiting", detail: "afterPermission", action: null });
    else if (input.attempt?.path) steps.push({ key: "intake", status: "due", detail: "ready", action: { label: "start", href: input.attempt.path } });
    else steps.push({ key: "intake", status: "waiting", detail: "linkSoon", action: null });
  }

  // 3. The visit.
  if (cancelled) steps.push({ key: "visit", status: "skipped", detail: "cancelled", action: null });
  else if (a.status === "pending_payment") {
    steps.push({ key: "visit", status: "due", detail: "payToConfirm", action: { label: "pay", href: `/book/${a.provider_profile_id}/pay/${a.id}` } });
  } else if (attended) steps.push({ key: "visit", status: "done", detail: "attended", action: null });
  else if (outcome === "absent" || outcome === "late_cancel_family") steps.push({ key: "visit", status: "skipped", detail: "missed", action: null });
  else if (outcome === "cancelled_centre") steps.push({ key: "visit", status: "skipped", detail: "cancelled", action: null });
  else if (ended) steps.push({ key: "visit", status: "waiting", detail: "awaitingCentre", action: null });
  else {
    const day = visitDay(a, input.timeZone, now);
    steps.push({ key: "visit", status: day ? "due" : "upcoming", detail: day ?? "scheduled", action: null });
  }

  // 4. Home program (026): practice at home once the therapist shares it.
  if (input.home_program) {
    steps.push({ key: "home", status: attended ? "due" : "upcoming", detail: "ready", action: { label: "open", href: homeProgramHref(childId) } });
  } else {
    steps.push({ key: "home", status: cancelled ? "skipped" : attended ? "waiting" : "upcoming", detail: "afterVisit", action: null });
  }
  return steps;
}

/** A confirmed visit that has not ended yet (calendar, reschedule, cancel and Meet stay available). */
export function visitStillAhead(a: { status: string; ends_at: string }, now: Date = new Date()): boolean {
  return a.status === "confirmed" && Date.parse(a.ends_at) > now.getTime();
}

export type AppointmentJourney = {
  appointment: AppointmentView;
  input: JourneyInput;
  meet: { meet_url: string | null; meet_status: string | null };
};

/** The booking guardian's appointment with what the timeline needs; null (-> 404) for anyone else. */
export async function loadAppointmentJourney(userId: string, appointmentId: string, timeZone: string, now: Date = new Date()): Promise<AppointmentJourney | null> {
  if (!isUuid(appointmentId)) return null;
  const appointment = await getAppointment(appointmentId);
  if (!appointment || appointment.guardian_user_id !== userId || !appointment.child_id) return null;
  if (appointment.status === "held") return null;
  if (!(await getActiveGuardianLink(appointment.child_id, userId))) return null;
  const sql = await pg();
  const [row] = await sql<{ attempt_id: string | null; attempt_status: "issued" | "started" | "completed" | null; consent: boolean; home: boolean; meet_url: string | null; meet_status: string | null }[]>`
    select t.id as attempt_id, t.status as attempt_status, coalesce(s.granted, false) as consent, a.meet_url, a.meet_status,
           exists (
             select 1 from public.home_programs p
             join lateral (
               select * from public.published_versions v where v.entity_type = 'home_program' and v.entity_id = p.id
               order by v.version desc limit 1
             ) pv on true
             where p.child_id = a.child_id and p.status = 'published' and pv.visible_to_guardian
           ) as home
    from public.appointments a
    left join lateral (
      select id, status from public.intake_attempts
      where appointment_id = a.id and (status = 'completed' or (status in ('issued', 'started') and expires_at > ${now}))
      order by (status = 'completed') desc, created_at desc limit 1
    ) t on true
    left join public.child_consent_state s on s.child_id = a.child_id and s.feature = 'ai_intake_call'
    where a.id = ${appointment.id}`;
  const snap = appointment.service_snapshot;
  const attempt = row?.attempt_id && row.attempt_status
    ? { id: row.attempt_id, status: row.attempt_status, path: row.attempt_status === "completed" ? null : intakeAttemptPath(row.attempt_id) }
    : null;
  return {
    appointment,
    meet: { meet_url: row?.meet_url ?? null, meet_status: row?.meet_status ?? null },
    input: {
      appointment: {
        id: appointment.id,
        status: appointment.status,
        starts_at: appointment.starts_at,
        ends_at: appointment.ends_at,
        attendance: appointment.attendance,
        provider_profile_id: appointment.provider_profile_id,
        child_id: appointment.child_id,
        mode: snap.mode === "video" ? "video" : "in_clinic",
        has_intake: snap.intake_kind === "child_dev" || snap.intake_kind === "generic",
      },
      intake_consent: Boolean(row?.consent),
      attempt,
      home_program: Boolean(row?.home),
      timeZone,
    },
  };
}

export { appointmentHref };
