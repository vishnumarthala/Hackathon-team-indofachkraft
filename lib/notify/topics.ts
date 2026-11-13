// FR-2 topic registry: `topic -> { payload schema, recipients, channels, template }`.
// To add a topic: add a template under lib/notify/templates/, add an entry here, then emit it with `enqueue(tx, ...)`
// inside the producing transaction (or `public.outbox_enqueue(...)` from SQL). See docs/notifications.md.
// Payloads carry ids and small non-clinical values only (strict schemas reject anything else).
import { z } from "zod";
import { env } from "@/lib/env";
import type { Queryable } from "@/lib/pg";
import {
  activeGrantRecipients,
  appointmentParties,
  activeGuardians,
  assignedAssessmentGuardian,
  caseProviders,
  existingUser,
  profileOwner,
  platformAdmins,
  threadMessageRecipients,
  visibleDocumentGuardians,
} from "./recipients";
import type { TemplateName } from "./templates";
import type { Channel, OutboxEventRow } from "./types";
import { deletionRequester, exportRequester } from "@/lib/privacy/recipients";
import { refundedPaymentGuardian } from "@/lib/payments/recipients";

const uuid = z.uuid();
// 030 appointment events (display values for the templates; no child data).
const appointmentPayload = z
  .object({
    appointment_id: uuid,
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
    provider_name: z.string().min(1).max(120),
    mode: z.enum(["in_clinic", "video"]),
    time_zone: z.string().min(1).max(64),
    location: z.string().max(300).nullable().optional(),
    cancelled_by: z.enum(["guardian", "provider", "system"]).optional(),
  })
  .strict();
const userList = z.array(uuid).min(1).max(100);

export type RecipientContext = { sql: Queryable; event: OutboxEventRow };

type TopicDefinition<S extends z.ZodType> = {
  payload: S;
  channels: readonly Channel[];
  template: TemplateName;
  /** Runs at fan-out time and must re-check access (rows only for users who may still see the subject). */
  recipients(payload: z.output<S>, ctx: RecipientContext): Promise<string[]>;
  /** Only fanned out outside production or in DEMO_MODE. */
  devOnly?: boolean;
};

function topic<S extends z.ZodType>(def: TopicDefinition<S>): TopicDefinition<S> {
  return def;
}

const GUARDIAN_CHANNELS = ["in_app", "email", "whatsapp"] as const;
const PROVIDER_CHANNELS = ["in_app", "email"] as const;
// Guardian topics without a WhatsApp message (023 documents).
const GUARDIAN_IN_APP_EMAIL = ["in_app", "email"] as const;

export const TOPICS = {
  // Dev/ops check. aggregate = the user to ping (`aggregate_type` 'user').
  "test.ping": topic({
    payload: z.object({ ics_start: z.iso.datetime({ offset: true }).optional() }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "test_ping",
    devOnly: true,
    recipients: (_payload, { sql, event }) => existingUser(sql, event.aggregate_id),
  }),
  // 027 FR-3: enqueued by `create_message_thread` / `send_thread_message` in the sending transaction, 2 minutes later
  // (aggregate = the thread). At fan-out: the child's active guardians, the case's assigned care team and anyone who
  // started or wrote in the thread, still with access, minus the sender and anyone who has read the thread since
  // the message; nobody once the message is deleted. Generic text only (no sender, child or body).
  "message.created": topic({
    payload: z.object({ message_id: uuid }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "message_created",
    recipients: (p, { sql }) => threadMessageRecipients(sql, p.message_id),
  }),
  // 023: a provider document became visible to the guardians (enqueued by `complete_document` /
  // `set_document_visibility`). In-app + email only. At fan-out: active guardians, and only while the document is
  // still a ready, guardian-visible provider upload of that child (hidden or deleted again -> nobody).
  "document.shared_with_guardian": topic({
    payload: z.object({ document_id: uuid, child_id: uuid }).strict(),
    channels: GUARDIAN_IN_APP_EMAIL,
    template: "document_shared",
    recipients: (p, { sql }) => visibleDocumentGuardians(sql, p.document_id, p.child_id),
  }),
  // 025: enqueued by publishPlan() in the publishing transaction (dedup `iep:<plan id>:v<published version>`).
  "iep.published": topic({
    payload: z.object({ plan_id: uuid, child_id: uuid, case_id: uuid.optional() }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "iep_published",
    recipients: (p, { sql }) => activeGuardians(sql, p.child_id),
  }),
  // 026
  "home_program.published": topic({
    payload: z.object({ program_id: uuid, child_id: uuid, case_id: uuid.optional() }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "home_program_published",
    recipients: (p, { sql }) => activeGuardians(sql, p.child_id),
  }),
  // 024: enqueued by createAssessment() in the assigning transaction. Only the assigned guardian, and only while the
  // questionnaire is still open and their link to the child is active.
  "assessment.assigned": topic({
    payload: z.object({ assessment_id: uuid, child_id: uuid, case_id: uuid.optional() }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "assessment_assigned",
    recipients: (p, { sql }) => assignedAssessmentGuardian(sql, p.assessment_id, p.child_id),
  }),
  // 024: enqueued by saveResponses() when a red-flag question is newly answered yes. Providers of the case (org
  // owners/admins + assigned care team; optionally only the named ones, still re-checked against the case org).
  "assessment.red_flag": topic({
    payload: z
      .object({ assessment_id: uuid, child_id: uuid, case_id: uuid, recipient_user_ids: userList.optional() })
      .strict(),
    channels: PROVIDER_CHANNELS,
    template: "assessment_red_flag",
    recipients: async (p, { sql }) => {
      const providers = await caseProviders(sql, p.case_id, p.child_id);
      return p.recipient_user_ids ? providers.filter((id) => p.recipient_user_ids?.includes(id)) : providers;
    },
  }),
  // 024: enqueued by submitAssessment(). Providers of the case (022 rule), re-checked at fan-out.
  "assessment.submitted": topic({
    payload: z.object({ assessment_id: uuid, child_id: uuid, case_id: uuid }).strict(),
    channels: PROVIDER_CHANNELS,
    template: "assessment_submitted",
    recipients: (p, { sql }) => caseProviders(sql, p.case_id, p.child_id),
  }),
  // 022: emitted by a trigger on sharing_grants inside create_sharing_grant (migration 20261113003201). Owners/admins
  // of the grantee org, only while the grant is in force and the granting guardian's link is still active.
  "sharing.granted": topic({
    payload: z
      .object({ grant_id: uuid, child_id: uuid, source_org_id: uuid, grantee_org_id: uuid, grantee_case_id: uuid.optional() })
      .strict(),
    channels: PROVIDER_CHANNELS,
    template: "sharing_granted",
    recipients: (p, { sql }) => activeGrantRecipients(sql, p.grant_id),
  }),
  // 028: emitted by triggers inside the verification / claim transactions (migration 20261113003200_outbox.sql).
  "provider.verified": topic({
    payload: z.object({ provider_profile_id: uuid, submission_id: uuid }).strict(),
    channels: PROVIDER_CHANNELS,
    template: "provider_verified",
    recipients: (p, { sql }) => profileOwner(sql, p.provider_profile_id),
  }),
  "provider.rejected": topic({
    payload: z.object({ provider_profile_id: uuid, submission_id: uuid }).strict(),
    channels: PROVIDER_CHANNELS,
    template: "provider_rejected",
    recipients: (p, { sql }) => profileOwner(sql, p.provider_profile_id),
  }),
  "provider.suspended": topic({
    payload: z.object({ provider_profile_id: uuid }).strict(),
    channels: PROVIDER_CHANNELS,
    template: "provider_suspended",
    recipients: (p, { sql }) => profileOwner(sql, p.provider_profile_id),
  }),
  "provider.claimed": topic({
    payload: z.object({ provider_profile_id: uuid }).strict(),
    channels: PROVIDER_CHANNELS,
    template: "provider_claimed",
    recipients: (p, { sql }) => profileOwner(sql, p.provider_profile_id),
  }),
  // 041 FR-7: the requesting guardian, while still linked to the live child and the export is ready.
  "privacy.export_ready": topic({
    payload: z.object({ export_id: uuid, child_id: uuid }).strict(),
    channels: GUARDIAN_IN_APP_EMAIL,
    template: "privacy_export_ready",
    recipients: (p, { sql }) => exportRequester(sql, p.export_id, p.child_id),
  }),
  // 041 FR-8: platform admins review deletion requests.
  "privacy.deletion_requested": topic({
    payload: z.object({ request_id: uuid, child_id: uuid }).strict(),
    channels: PROVIDER_CHANNELS,
    template: "privacy_deletion_requested",
    recipients: (_p, { sql }) => platformAdmins(sql),
  }),
  // 041 FR-8: the requesting guardian (their link may already be revoked by the erasure: account only).
  "privacy.deletion_completed": topic({
    payload: z.object({ request_id: uuid }).strict(),
    channels: GUARDIAN_IN_APP_EMAIL,
    template: "privacy_deletion_completed",
    recipients: (p, { sql }) => deletionRequester(sql, p.request_id, "completed"),
  }),
  "privacy.deletion_rejected": topic({
    payload: z.object({ request_id: uuid, child_id: uuid }).strict(),
    channels: GUARDIAN_IN_APP_EMAIL,
    template: "privacy_deletion_rejected",
    recipients: (p, { sql }) => deletionRequester(sql, p.request_id, "rejected"),
  }),
  // 030: enqueued by the booking SQL functions in the same transaction (supabase/migrations/20261113003000_booking.sql).
  // Payload: small display values only (provider name, time, mode, location) - never the child.
  "appointment.confirmed": topic({
    payload: appointmentPayload,
    channels: GUARDIAN_CHANNELS,
    template: "appointment_confirmed",
    recipients: (p, { sql }) => appointmentParties(sql, p.appointment_id, ["confirmed"]),
  }),
  "appointment.reminder_day_before": topic({
    payload: appointmentPayload,
    channels: GUARDIAN_CHANNELS,
    template: "appointment_reminder_24h",
    recipients: (p, { sql }) => appointmentParties(sql, p.appointment_id, ["confirmed"], "guardian"),
  }),
  "appointment.reminder_two_hours": topic({
    payload: appointmentPayload,
    channels: GUARDIAN_CHANNELS,
    template: "appointment_reminder_2h",
    recipients: (p, { sql }) => appointmentParties(sql, p.appointment_id, ["confirmed"], "guardian"),
  }),
  "appointment.cancelled": topic({
    payload: appointmentPayload,
    channels: GUARDIAN_CHANNELS,
    template: "appointment_cancelled",
    recipients: (p, { sql }) => appointmentParties(sql, p.appointment_id, ["cancelled"]),
  }),
  "appointment.rescheduled": topic({
    payload: appointmentPayload,
    channels: GUARDIAN_CHANNELS,
    template: "appointment_rescheduled",
    recipients: (p, { sql }) => appointmentParties(sql, p.appointment_id, ["confirmed"]),
  }),
  // 031: enqueued by payment_mark_refunded in the refunding transaction (dedup `payment:<id>:refunded`). The booking
  // guardian only, while the payment is refunded. In-app + email (no approved WhatsApp template yet).
  "payment.refunded": topic({
    payload: z
      .object({
        payment_id: uuid,
        appointment_id: uuid,
        reason: z.enum(["slot_unavailable", "appointment_cancelled", "provider_cancelled", "guardian_cancelled", "system_cancelled", "amount_mismatch", "external"]),
      })
      .strict(),
    channels: GUARDIAN_IN_APP_EMAIL,
    template: "payment_refunded",
    recipients: (p, { sql }) => refundedPaymentGuardian(sql, p.payment_id),
  }),
} as const;

export type Topic = keyof typeof TOPICS;
export type TopicPayload<T extends Topic> = z.input<(typeof TOPICS)[T]["payload"]>;

export const PROVIDER_TOPICS = {
  verified: "provider.verified",
  rejected: "provider.rejected",
  suspended: "provider.suspended",
  claimed: "provider.claimed",
} as const satisfies Record<string, Topic>;

export const SHARING_TOPICS = {
  granted: "sharing.granted",
} as const satisfies Record<string, Topic>;

// 027 FR-3: enqueued by `create_message_thread` / `send_thread_message` (migration 20261113002700).
export const MESSAGE_TOPICS = {
  created: "message.created",
} as const satisfies Record<string, Topic>;

// 024: questionnaires (enqueued in the producing transactions in lib/assessments).
export const ASSESSMENT_TOPICS = {
  assigned: "assessment.assigned",
  submitted: "assessment.submitted",
  redFlag: "assessment.red_flag",
} as const satisfies Record<string, Topic>;

// 023 FR-9: enqueued by `complete_document` / `set_document_visibility` (migration 20261113002300).
export const DOCUMENT_TOPICS = {
  sharedWithGuardian: "document.shared_with_guardian",
} as const satisfies Record<string, Topic>;

// 041: privacy export / deletion notifications.
export const PRIVACY_TOPICS = {
  exportReady: "privacy.export_ready",
  deletionRequested: "privacy.deletion_requested",
  deletionCompleted: "privacy.deletion_completed",
  deletionRejected: "privacy.deletion_rejected",
} as const satisfies Record<string, Topic>;

// 030: booking (enqueued by the SQL state machine; reminders cancelled with outbox_cancel('appt:<id>:')).
export const APPOINTMENT_TOPICS = {
  confirmed: "appointment.confirmed",
  reminder24h: "appointment.reminder_day_before",
  reminder2h: "appointment.reminder_two_hours",
  cancelled: "appointment.cancelled",
  rescheduled: "appointment.rescheduled",
} as const satisfies Record<string, Topic>;

// 031: payments (enqueued by the payment SQL functions).
export const PAYMENT_TOPICS = {
  refunded: "payment.refunded",
} as const satisfies Record<string, Topic>;

export function isTopic(value: string): value is Topic {
  return Object.prototype.hasOwnProperty.call(TOPICS, value);
}

/** Widened view for the worker, which handles every topic the same way. */
export type AnyTopicDefinition = TopicDefinition<z.ZodType<Record<string, unknown>>>;

export function getTopic(name: string): AnyTopicDefinition | null {
  return isTopic(name) ? (TOPICS[name] as unknown as AnyTopicDefinition) : null;
}

export function topicEnabled(def: AnyTopicDefinition): boolean {
  return !def.devOnly || env.DEMO_MODE || process.env.NODE_ENV !== "production";
}
