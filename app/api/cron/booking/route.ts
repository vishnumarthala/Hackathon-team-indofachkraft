import { expireStaleHolds } from "@/lib/booking/store";
import { cronAuthorized } from "@/lib/cron";
import { fail, ok } from "@/lib/http";
import { expireStaleVoiceUsage, reconcileVoiceDurations } from "@/lib/voice/usage";

// FR-5 hold cleanup. Vercel cron calls it every minute (vercel.json) with `Authorization: Bearer <CRON_SECRET>`;
// POST does the same for manual runs. held / pending_payment rows past hold_expires_at -> expired (+ history row).
// Late payments after expiry are 031's concern.
// 051 FR-7: the same schedule expires voice calls that never reported their end (reserved + 2 minutes, actual =
// reserved) and fetches real call durations from ElevenLabs (skipped in DEMO_MODE / without an API key).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  const expired = await expireStaleHolds();
  const voiceExpired = await expireStaleVoiceUsage();
  const voiceReconciled = await reconcileVoiceDurations();
  return ok({ expired, voice_expired: voiceExpired, voice_reconciled: voiceReconciled });
}

export { handle as GET, handle as POST };
