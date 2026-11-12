// Ticket 020: intake link lifetime (pure; shared by routes, pages and processing).
import type { CaseRow } from "@/lib/types";

export const INTAKE_LINK_DAYS = 7;
export const LINK_EXPIRED = "This link has expired";
/** A call that started before expiry may still finish and be delivered this long after (complete/webhook). */
export const INTAKE_COMPLETION_GRACE_MS = 2 * 60 * 60 * 1000;

export type IntakeLinkState = "none" | "active" | "expired" | "revoked";

/** 020 FR-6/FR-10: intake links expire after 7 days and can be revoked. */
export function intakeLinkState(
  row: Pick<CaseRow, "intake_token" | "intake_token_expires_at" | "intake_token_revoked_at">,
  now: number = Date.now(),
  graceMs = 0,
): IntakeLinkState {
  if (!row.intake_token) return "none";
  if (row.intake_token_revoked_at) return "revoked";
  // Fail closed: a token without a recorded lifetime is treated as expired.
  if (!row.intake_token_expires_at) return "expired";
  return Date.parse(row.intake_token_expires_at) + graceMs > now ? "active" : "expired";
}
