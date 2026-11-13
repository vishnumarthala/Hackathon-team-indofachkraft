import { AuditWriteError } from "@/lib/audit";
import { fail, ok } from "@/lib/http";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon } from "@/lib/notify/outbox";
import { runPaymentJobsSoon } from "@/lib/payments/jobs";
import { razorpaySettings, RazorpayConfigError, verifyWebhookSignature } from "@/lib/payments/razorpay";
import { handleWebhookEvent } from "@/lib/payments/store";
import { parseWebhook, type ParsedWebhook } from "@/lib/payments/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const log = logger("payments.webhook");
const MAX_BODY_BYTES = 256 * 1024;

// 031 FR-5 (public, no session): Razorpay webhooks. X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret),
// checked in constant time before anything is parsed or stored (401). Deduplicated by X-Razorpay-Event-Id
// (replay -> 200 { received: true, duplicate: true }). Handles payment.authorized / .captured / .failed and
// refund.processed; anything else -> 200 ignored. Quick (NFR-2): one transaction; refunds and notifications run after
// the response (refund job, outbox).
export async function POST(req: Request) {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return fail(413, "Payload too large");

  let secret: string | null;
  try {
    secret = razorpaySettings().webhookSecret;
  } catch (err) {
    if (err instanceof RazorpayConfigError) {
      log.error("webhook refused: razorpay not configured");
      return fail(503, "Not configured");
    }
    throw err;
  }
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"), secret)) return fail(401, "Invalid signature");

  const eventId = req.headers.get("x-razorpay-event-id")?.trim();
  if (!eventId || eventId.length > 100) return fail(400, "Missing event id");

  let parsed: ParsedWebhook;
  try {
    parsed = parseWebhook(raw);
  } catch {
    return fail(400, "Invalid payload");
  }

  try {
    const result = await handleWebhookEvent(eventId, parsed);
    if (result.duplicate) return ok({ received: true, duplicate: true });
    if (result.eventIds.length) drainSoon(result.eventIds);
    runPaymentJobsSoon(result.refundPaymentIds);
    log.info("webhook processed", { event: parsed.event, outcome: result.outcome });
    return ok({ received: true, outcome: result.outcome, ...(result.outcome === "ignored" ? { ignored: parsed.event } : {}) });
  } catch (err) {
    // Nothing was stored (one transaction): Razorpay retries the delivery.
    log.error("webhook failed", { event: parsed.event, error: err instanceof AuditWriteError ? err.message : errorMessage(err) });
    return fail(500, "Could not process the event");
  }
}
