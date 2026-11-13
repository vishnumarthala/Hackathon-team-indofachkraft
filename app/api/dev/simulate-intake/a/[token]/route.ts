// Ticket 035 (DEMO_MODE only): replays the synthetic post-call fixture of the attempt's agent (Child Development or
// generic) for this appointment intake link, through the same processor as the webhook. 049: optional JSON body
// `{ language }` replays the generic agent's Hindi or Telugu demo call.
import { requireConsent } from "@/lib/consent";
import { isDemoMode } from "@/lib/demo";
import { fail, ok } from "@/lib/http";
import { isLocale } from "@/lib/i18n/config";
import { demoAppointmentPostCall, demoConversationId, processAppointmentPostCall } from "@/lib/intake/appointment-process";
import { attemptLinkState, getAttemptByToken } from "@/lib/intake/attempts";
import { LINK_EXPIRED } from "@/lib/intake/link";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!isDemoMode()) return fail(404, "Not found");
  const { token } = await params;
  const attempt = await getAttemptByToken(token);
  if (!attempt) return fail(404, "This link is not valid.");
  const state = attemptLinkState(attempt);
  if (state === "completed") return fail(409, "This intake call is already complete");
  if (state !== "active" || !attempt.child_id) return fail(410, LINK_EXPIRED);
  const blocked = await requireConsent(attempt.child_id, "ai_intake_call");
  if (blocked) return blocked;

  const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
  const language = isLocale(body?.language) ? body.language : "en";
  try {
    return ok(
      await processAppointmentPostCall(demoAppointmentPostCall(attempt, demoConversationId(), language), { expectedAttemptId: attempt.id }),
    );
  } catch (err) {
    console.error(`simulate appointment intake: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not save the call");
  }
}
