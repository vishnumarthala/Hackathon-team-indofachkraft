// Ticket 051: the voice start gate every voice route runs BEFORE contacting ElevenLabs (NFR-1):
//   1. a signed-in user (401 `sign_in_required`; tapping stays anonymous),
//   2. optionally the Turnstile bot check (400 `bot_check_failed`; only when configured, FR-8),
//   3. one atomic SQL call for quota, concurrency and the platform budget (FR-4/FR-5): 429 `quota_day` / `quota_month`
//      / `concurrent`, 503 `voice_paused` for everyone once the budget is reached.
// On success the caller holds a reservation (`voice_usage` row). If the provider then fails, call `release()`.
import type { User } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/auth";
import { fail } from "@/lib/http";
import { errorMessage, logger } from "@/lib/log";
import { verifyTurnstile } from "@/lib/turnstile";
import { VOICE_ERRORS, VOICE_MAX_SECONDS, type VoiceAgent, type VoiceRefusal } from "./constants";
import { budgetAlertFor, endVoiceUsage, queueBudgetAlert, releaseVoiceUsage, startVoiceUsage, type VoiceStartResult } from "./usage";

const log = logger("voice-gate");

export type VoiceGrant = {
  user: User;
  usageId: string;
  maxSeconds: number;
  /** The provider failed before any call: the reservation counts for nothing. */
  release: () => Promise<void>;
  /** No live call will happen (DEMO_MODE without a call): the start counts against the quota with 0 seconds. */
  endNow: () => Promise<void>;
};

export function refuse(reason: VoiceRefusal): Response {
  const { code, status } = VOICE_ERRORS[reason];
  return fail(status, code);
}

const REFUSAL: Record<Exclude<VoiceStartResult["status"], "ok">, VoiceRefusal> = {
  budget: "paused",
  quota_day: "quotaDay",
  quota_month: "quotaMonth",
  concurrent: "concurrent",
};

async function alertIfNeeded(result: VoiceStartResult): Promise<void> {
  const alert = budgetAlertFor(result);
  if (!alert) return;
  try {
    await queueBudgetAlert(alert);
  } catch (err) {
    log.error("budget alert failed", { error: errorMessage(err) });
  }
}

export async function voiceGate(
  req: Request,
  agent: VoiceAgent,
  opts: { user?: User | null; turnstile?: boolean } = {},
): Promise<VoiceGrant | { response: Response }> {
  const user = opts.user !== undefined ? opts.user : await getAuthenticatedUser().catch(() => null);
  if (!user) return { response: refuse("signIn") };
  if (opts.turnstile && !(await verifyTurnstile(req))) return { response: refuse("botCheck") };

  const result = await startVoiceUsage(user.id, agent);
  await alertIfNeeded(result);
  if (result.status !== "ok") return { response: refuse(REFUSAL[result.status]) };

  const usageId = result.usageId;
  return {
    user,
    usageId,
    maxSeconds: VOICE_MAX_SECONDS[agent],
    release: () => releaseVoiceUsage(usageId),
    endNow: async () => {
      await endVoiceUsage({ usageId, userId: user.id, seconds: 0 });
    },
  };
}
