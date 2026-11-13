// Ticket 051: voice cost guard. Pure constants and helpers, safe in the browser and on the server.
import { VOICE_MAX_MINUTES as BOOKING_MAX_MINUTES } from "@/lib/agents/booking/constants";
import { VOICE_MAX_MINUTES as FOLLOWUP_MAX_MINUTES } from "@/lib/followup/constants";
import { VOICE_MAX_MINUTES as SCREEN_MAX_MINUTES } from "@/lib/screen/questions";

export const VOICE_AGENTS = ["screen", "booking", "followup", "intake_demo"] as const;
export type VoiceAgent = (typeof VOICE_AGENTS)[number];

/** The landing page's live intake demo (components/landing/VoiceDemo.tsx ends it after 3 minutes). */
export const INTAKE_DEMO_MAX_SECONDS = 180;

/** FR-6: maximum call length per agent = the seconds reserved against the quota and budget at start. */
export const VOICE_MAX_SECONDS: Record<VoiceAgent, number> = {
  screen: SCREEN_MAX_MINUTES * 60,
  booking: BOOKING_MAX_MINUTES * 60,
  followup: FOLLOWUP_MAX_MINUTES * 60,
  intake_demo: INTAKE_DEMO_MAX_SECONDS,
};

/** FR-6: the page ends a call after this long without speech from the user (ElevenLabs is set to the same). */
export const SILENCE_TIMEOUT_SECONDS = 30;

/** FR-7: a call still `started` this long after its maximum length is expired with actual = reserved. */
export const EXPIRE_GRACE_SECONDS = 120;

/** FR-3: `voice_usage` rows are deleted this many days after the call (lib/privacy/retention.ts). */
export const VOICE_USAGE_RETENTION_DAYS = 180;

/** Results of `voice_session_start` (FR-4). */
export type VoiceStartStatus = "ok" | "quota_day" | "quota_month" | "budget" | "concurrent";

/** API error codes of a refused voice start (body `{ error }`) and their HTTP status. */
export const VOICE_ERRORS = {
  signIn: { code: "sign_in_required", status: 401 },
  paused: { code: "voice_paused", status: 503 },
  quotaDay: { code: "quota_day", status: 429 },
  quotaMonth: { code: "quota_month", status: 429 },
  concurrent: { code: "concurrent", status: 429 },
  botCheck: { code: "bot_check_failed", status: 400 },
  notAllowed: { code: "live_demo_not_allowed", status: 403 },
} as const;

export type VoiceRefusal = keyof typeof VOICE_ERRORS;

/** Maps a refused start (status + `{ error }`) to a UI message key; null when it is not a cost-guard refusal. */
export function voiceRefusal(status: number, body: unknown): VoiceRefusal | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== "string") return null;
  for (const [key, value] of Object.entries(VOICE_ERRORS) as [VoiceRefusal, { code: string; status: number }][]) {
    if (value.code === error && value.status === status) return key;
  }
  return null;
}

/** Where `Sign in to use voice` goes; the guardian sign-in returns to `next` (lib/auth-access.ts postSignInPath). */
export function voiceSignInHref(next: string): string {
  return `/family/login?next=${encodeURIComponent(next)}`;
}
