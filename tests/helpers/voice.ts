// Ticket 051 test helpers: voice starts need a signed-in user with quota and room in the platform budget. Suites that
// start voice sessions for other reasons (033/034/040) stub generous limits and close their user's open call before
// the next start (one active voice call per user).
import type { Sql } from "postgres";
import { vi } from "vitest";

/** Generous quotas and caps so other suites' voice starts never hit the cost guard. */
export function stubGenerousVoiceLimits(): void {
  for (const name of [
    "VOICE_QUOTA_SCREEN_DAY",
    "VOICE_QUOTA_SCREEN_30D",
    "VOICE_QUOTA_BOOKING_DAY",
    "VOICE_QUOTA_BOOKING_30D",
    "VOICE_QUOTA_FOLLOWUP_DAY",
    "VOICE_QUOTA_FOLLOWUP_30D",
    "VOICE_QUOTA_INTAKE_DEMO_DAY",
  ]) {
    vi.stubEnv(name, "100000");
  }
  vi.stubEnv("VOICE_DAILY_MINUTES_CAP", "100000000");
  vi.stubEnv("VOICE_MONTHLY_MINUTES_CAP", "100000000");
  vi.stubEnv("TURNSTILE_SITE_KEY", "");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
}

/** Ends the user's open voice call(s), as the browser would when the call ends. */
export async function closeOpenVoiceCalls(sql: Sql, userId: string): Promise<void> {
  await sql`
    update voice_usage set status = 'ended', ended_at = now(), actual_seconds = 0
    where user_id = ${userId} and status = 'started'`;
}
