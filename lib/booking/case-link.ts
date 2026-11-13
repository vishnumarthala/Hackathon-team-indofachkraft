// Ticket 035 FR-2/FR-3 (rule 11): appointment -> case -> intake. Server only.
// `appointment.link_case` runs as an outbox consumer of `appointment.confirmed` / `appointment.rescheduled`
// (lib/notify/consumers.ts) inside the fan-out transaction, before the confirmation is rendered, so the confirmation
// carries the intake link (or the consent hint). Every step is idempotent by appointment id: re-running links the same
// case, never adds a second assignment and returns the same active attempt.
import type { Queryable } from "@/lib/pg";
import { issueIntakeAttempt, type AgentKind } from "@/lib/intake/attempts";

export type LinkCaseResult =
  | { result: "linked" | "existing"; case_id: string; case_created: boolean; provider_assignment: "added" | "existing" | "skipped" }
  | { result: "not_applicable"; case_id: string | null }
  | { result: "not_found" };

/** FR-2: select or create the org's case for the child, assign the provider, set appointments.case_id. */
export async function linkAppointmentCase(sql: Queryable, appointmentId: string): Promise<LinkCaseResult> {
  const [row] = await sql<{ r: LinkCaseResult }[]>`select public.appointment_link_case(${appointmentId}) as r`;
  return row.r;
}

/** What the confirmation says about the intake (payload `intake`; ids only). */
export type IntakeNotice =
  | { status: "link"; attempt_id: string; agent_kind: AgentKind }
  | { status: "consent_needed"; agent_kind: AgentKind };

const isAgentKind = (v: unknown): v is AgentKind => v === "child_dev" || v === "generic";

/** FR-2 + FR-3 for one confirmed appointment. Null when the service has no intake (or nothing applies any more). */
export async function prepareAppointmentIntake(sql: Queryable, appointmentId: string): Promise<IntakeNotice | null> {
  const linked = await linkAppointmentCase(sql, appointmentId);
  if (linked.result === "not_found") return null;
  const issued = await issueIntakeAttempt(sql, appointmentId);
  if ((issued.result === "issued" || issued.result === "existing") && isAgentKind(issued.agent_kind)) {
    return { status: "link", attempt_id: issued.attempt_id, agent_kind: issued.agent_kind };
  }
  if (issued.result === "consent_needed" && isAgentKind(issued.agent_kind)) {
    return { status: "consent_needed", agent_kind: issued.agent_kind };
  }
  return null;
}

/**
 * FR-3 `consent.granted` consumer: once a guardian allows `ai_intake_call`, issue links for the child's upcoming
 * confirmed appointments that still need one and notify the guardian (`appointment.intake_link`). Returns the event
 * ids it enqueued. Re-running issues nothing new (one active attempt per appointment; dedup key per attempt). The
 * aggregate is the attempt, so the appointment's calendar SEQUENCE is unaffected; the `appt:<id>:` dedup prefix lets
 * cancel/reschedule cancel an unsent link.
 */
export async function issueIntakeLinksForChild(sql: Queryable, childId: string): Promise<string[]> {
  const appointments = await sql<{ id: string }[]>`
    select a.id from public.appointments a
    where a.child_id = ${childId} and a.status = 'confirmed' and lower(a.slot) > now()
      and coalesce(a.service_snapshot ->> 'intake_kind', 'none') in ('child_dev', 'generic')
    order by lower(a.slot)`;
  const events: string[] = [];
  for (const a of appointments) {
    const linked = await linkAppointmentCase(sql, a.id);
    if (linked.result === "not_found") continue;
    const issued = await issueIntakeAttempt(sql, a.id);
    if (issued.result !== "issued") continue;
    const [row] = await sql<{ id: string }[]>`
      select public.outbox_enqueue('appointment.intake_link', 'intake_attempt', ${issued.attempt_id},
        public.booking_notify_payload(${a.id}) || jsonb_build_object('intake_attempt_id', ${issued.attempt_id}::text),
        ${`appt:${a.id}:intake_link:${issued.attempt_id}`}, now())::text as id`;
    events.push(row.id);
  }
  return events;
}
