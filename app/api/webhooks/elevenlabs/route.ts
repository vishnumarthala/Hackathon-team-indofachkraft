import { env } from "@/lib/env";
import { fail, ok } from "@/lib/http";
import { isAppointmentPostCall, processAppointmentPostCall } from "@/lib/intake/appointment-process";
import { InvalidPostCallError, processPostCall } from "@/lib/intake/process";
import { verifySignature } from "@/lib/intake/signature";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function webhookSecret(): string | undefined {
  try {
    return env.ELEVENLABS_WEBHOOK_SECRET;
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get("elevenlabs-signature"), webhookSecret())) {
    return fail(401, "Invalid signature");
  }

  let payload: { type?: unknown; data?: unknown };
  try {
    payload = JSON.parse(rawBody) as { type?: unknown; data?: unknown };
  } catch {
    return fail(400, "Invalid payload");
  }
  if (!payload || typeof payload !== "object") return fail(400, "Invalid payload");
  if (payload.type !== "post_call_transcription") {
    return ok({ received: true, ignored: String(payload.type) });
  }

  try {
    // 035: appointment intake calls carry `intake_attempt_id`; case-level links (009/010) carry `intake_token`.
    if (isAppointmentPostCall(payload.data)) return ok(await processAppointmentPostCall(payload.data));
    return ok(await processPostCall(payload.data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`elevenlabs webhook: ${message}`);
    if (err instanceof InvalidPostCallError) return fail(400, "Invalid payload");
    return fail(500, "Could not save the call");
  }
}
