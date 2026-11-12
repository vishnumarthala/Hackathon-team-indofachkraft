// Notification topics emitted before the outbox exists. Ticket 032 turns this file into the topic registry
// (`topic -> { recipients, channels, template }`) and replaces `notifyLater` with `outbox_enqueue` inside
// the producing transaction. Until then events are only logged, so nothing is sent.

export const PROVIDER_TOPICS = {
  verified: "provider.verified",
  rejected: "provider.rejected",
  suspended: "provider.suspended",
  claimed: "provider.claimed",
} as const;

export type NotifyTopic = (typeof PROVIDER_TOPICS)[keyof typeof PROVIDER_TOPICS];

export type NotifyPayload = Record<string, string | number | boolean | null>;

// TODO(032): enqueue into the transactional outbox. Payloads carry ids only (no notes, no personal data).
export async function notifyLater(topic: NotifyTopic, payload: NotifyPayload): Promise<void> {
  console.info(`[notify:pending-032] ${topic} ${JSON.stringify(payload)}`);
}
