// Ticket 051: browser side of the voice cost guard, free of React so it can be tested with mocks.
import { SILENCE_TIMEOUT_SECONDS } from "./constants";

/** Header carrying the Cloudflare Turnstile token on voice starts and phone sign-in codes (FR-8). */
export const TURNSTILE_HEADER = "x-turnstile-token";

/** Fields every voice start response carries (FR-7: the client reports the end against `voice_usage_id`). */
export type VoiceUsageStart = { voice_usage_id: string; max_seconds: number };

/**
 * FR-6: "no speech from the user for 30 seconds". The clock runs only while the call is connected and the agent is
 * not speaking; a user transcript (or the agent starting to speak) resets it.
 */
export class SilenceWatch {
  private lastActivity: number;
  private agentSpeaking = false;

  constructor(
    now: number,
    private readonly timeoutMs = SILENCE_TIMEOUT_SECONDS * 1000,
  ) {
    this.lastActivity = now;
  }

  /** The user said something (a user transcript arrived). */
  heard(now: number): void {
    this.lastActivity = now;
  }

  /** The agent started or stopped speaking; the silence clock restarts when it stops. */
  speaking(isSpeaking: boolean, now: number): void {
    if (this.agentSpeaking === isSpeaking) return;
    this.agentSpeaking = isSpeaking;
    this.lastActivity = now;
  }

  /** True once the user has been silent for the timeout while the agent was not speaking. */
  silent(now: number): boolean {
    return !this.agentSpeaking && now - this.lastActivity >= this.timeoutMs;
  }
}

/** Whole seconds between two timestamps (ms), never negative. */
export function callSeconds(startedAt: number | null, endedAt: number): number {
  if (startedAt === null) return 0;
  return Math.max(0, Math.round((endedAt - startedAt) / 1000));
}

/**
 * FR-7: reports the end of a voice call. `keepalive` lets it finish when the page is closing. Never throws; a lost
 * report is reconciled by the server (expired at reserved + 2 minutes).
 */
export async function reportVoiceEnd(
  fetchFn: typeof fetch,
  usageId: string | null | undefined,
  seconds: number,
  conversationId?: string | null,
): Promise<boolean> {
  if (!usageId) return false;
  try {
    const res = await fetchFn(`/api/voice/usage/${encodeURIComponent(usageId)}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        duration_seconds: Math.max(0, Math.round(seconds)),
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Headers for a voice start: JSON plus the Turnstile token when the page has one. */
export function voiceStartHeaders(turnstileToken: string | null | undefined, json = true): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(turnstileToken ? { [TURNSTILE_HEADER]: turnstileToken } : {}),
  };
}
