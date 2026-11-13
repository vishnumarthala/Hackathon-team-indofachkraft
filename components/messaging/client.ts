// Ticket 027: small browser-safe helpers of the messaging UI (pure; unit-tested).
import { MESSAGING_ERRORS } from "@/lib/messaging/constants";
import type { MessageView } from "@/lib/messaging/types";

export type MessagingErrorKey =
  | "tooFast"
  | "archived"
  | "notAttachable"
  | "noGuardian"
  | "tooLate"
  | "notOwn"
  | "forbidden"
  | "failed"
  | "subjectRequired"
  | "bodyRequired"
  | "tooLong"
  | "chooseCase";

/** Maps an API status (+ English error body) to a translated error key (API bodies stay English). */
export function messagingErrorKey(status: number, error?: string): MessagingErrorKey {
  if (status === 429) return "tooFast";
  if (status === 409) return error === MESSAGING_ERRORS.tooLate ? "tooLate" : "archived";
  if (status === 422) return error === MESSAGING_ERRORS.noGuardian ? "noGuardian" : "notAttachable";
  if (status === 403) return error === MESSAGING_ERRORS.notOwn ? "notOwn" : "forbidden";
  return "failed";
}

/** Merges a fetched page into the list by id (newer copies win, e.g. a deletion), oldest -> newest. */
export function mergeMessages(current: MessageView[], incoming: MessageView[]): MessageView[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** One id per draft: a retried send reuses it, so the server stores the message once (FR-2 idempotency). */
export function newClientId(): string {
  return crypto.randomUUID();
}
