// FR-2 topic registry: `topic -> { payload schema, recipients, channels, template }`.
// To add a topic: add a template under lib/notify/templates/, add an entry here, then emit it with `enqueue(tx, ...)`
// inside the producing transaction (or `public.outbox_enqueue(...)` from SQL). See docs/notifications.md.
// Payloads carry ids and small non-clinical values only (strict schemas reject anything else).
import { z } from "zod";
import { env } from "@/lib/env";
import type { Queryable } from "@/lib/pg";
import {
  activeGrantRecipients,
  activeGuardians,
  caseProviders,
  childAccessFilter,
  existingUser,
  profileOwner,
} from "./recipients";
import type { TemplateName } from "./templates";
import type { Channel, OutboxEventRow } from "./types";

const uuid = z.uuid();
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

export const TOPICS = {
  // Dev/ops check. aggregate = the user to ping (`aggregate_type` 'user').
  "test.ping": topic({
    payload: z.object({ ics_start: z.iso.datetime({ offset: true }).optional() }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "test_ping",
    devOnly: true,
    recipients: (_payload, { sql, event }) => existingUser(sql, event.aggregate_id),
  }),
  // 027 registers thread participants here; until then the producer names recipients, re-checked against the child.
  "message.created": topic({
    payload: z
      .object({
        message_id: uuid,
        child_id: uuid.optional(),
        case_id: uuid.optional(),
        recipient_user_ids: userList.optional(),
      })
      .strict(),
    channels: GUARDIAN_CHANNELS,
    template: "message_created",
    recipients: async (p, { sql }) =>
      p.child_id && p.recipient_user_ids ? childAccessFilter(sql, p.child_id, p.recipient_user_ids) : [],
  }),
  // 023: guardian-visible document uploaded by a provider.
  "document.shared_with_guardian": topic({
    payload: z.object({ document_id: uuid, child_id: uuid }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "document_shared",
    recipients: (p, { sql }) => activeGuardians(sql, p.child_id),
  }),
  // 025
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
  // 024
  "assessment.assigned": topic({
    payload: z.object({ assessment_id: uuid, child_id: uuid, case_id: uuid.optional() }).strict(),
    channels: GUARDIAN_CHANNELS,
    template: "assessment_assigned",
    recipients: (p, { sql }) => activeGuardians(sql, p.child_id),
  }),
  // 024: providers of the case (optionally only the named ones, still re-checked against the case org).
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
