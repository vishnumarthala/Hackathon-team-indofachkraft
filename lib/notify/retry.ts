// FR-5 retry policy and NFR-3 error hygiene.
import { redactPhones } from "@/lib/family/phone";

/** Delay before each retry: 1 min, 5 min, 30 min, 2 h, 12 h. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;

/** The first attempt plus one retry per delay; the attempt after the 12 h retry fails into `dead`. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export type FailureDecision = { status: "failed"; nextAttemptAt: Date } | { status: "dead" };

/** `attempts` counts the attempt that just failed (1 for the first). */
export function failureDecision(attempts: number, permanent: boolean, now: Date = new Date()): FailureDecision {
  if (permanent || attempts >= MAX_ATTEMPTS) return { status: "dead" };
  const delay = RETRY_DELAYS_MS[Math.max(0, attempts - 1)];
  return { status: "failed", nextAttemptAt: new Date(now.getTime() + delay) };
}

const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi;

/** `last_error`: one line, at most 500 characters, no addresses or phone numbers, never payload text. */
export function sanitizeError(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "unknown_error";
  return redactPhones(raw.replace(EMAIL, "[redacted]")).replace(/\s+/g, " ").trim().slice(0, 500) || "unknown_error";
}
