import { z } from "zod";
import { auditFailure, AuditWriteError } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { drainMeetJobs } from "@/lib/google/meet";
import { ok, parseJson } from "@/lib/http";
import { logger } from "@/lib/log";
import { drainSoon } from "@/lib/notify/outbox";
import { paymentError } from "@/lib/payments/errors";
import { runPaymentJobsSoon } from "@/lib/payments/jobs";
import { razorpaySettings, RazorpayConfigError, verifyCheckoutSignature } from "@/lib/payments/razorpay";
import { applyPaymentCaptured, findGuardianPaymentByOrder } from "@/lib/payments/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("payments.verify");

const VerifySchema = z
  .object({
    razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
    razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
    razorpay_signature: z.string().regex(/^[0-9a-fA-F]{64}$/),
  })
  .strict();

// 031 FR-4: Razorpay Checkout's success handler. Only the guardian who booked the appointment (others 404); the
// signature HMAC_SHA256(order_id + "|" + payment_id, key_secret) is compared in constant time (400 on mismatch); then
// the same capture path as the webhook (applyPaymentCaptured, idempotent).
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, VerifySchema);
  if ("response" in parsed) return parsed.response;
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = parsed.data;

  const payment = await findGuardianPaymentByOrder(orderId, session.user.id);
  if (!payment) return paymentError("payment_not_found");

  let keySecret: string;
  try {
    keySecret = razorpaySettings().keySecret;
  } catch (err) {
    if (err instanceof RazorpayConfigError) return paymentError("not_configured");
    throw err;
  }
  if (!verifyCheckoutSignature({ orderId, paymentId, signature }, keySecret)) {
    log.warn("checkout signature mismatch", { payment: payment.id });
    return paymentError("invalid_signature");
  }

  try {
    const result = await applyPaymentCaptured({ orderId, paymentId, actorUserId: session.user.id, source: "checkout" });
    if (result.event_id) drainSoon([result.event_id]);
    // 037: a paid video appointment's Meet event (queued with appointment.confirmed) right after the response.
    if (result.event_id) await drainMeetJobs(result.appointment_id);
    if (result.payment_status === "refund_pending") runPaymentJobsSoon([result.payment_id]);
    return ok({
      appointment_id: result.appointment_id,
      appointment_status: result.appointment_status,
      payment_status: result.payment_status,
      outcome: result.outcome,
    });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    if ((err as { message?: string }).message === "payment_conflict") return paymentError("invalid_signature");
    throw err;
  }
}
