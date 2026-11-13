import { z } from "zod";
import { requireGuardian } from "@/lib/authz";
import { env } from "@/lib/env";
import { ok, parseJson } from "@/lib/http";
import { paymentError } from "@/lib/payments/errors";
import { checkoutSignature, demoId, razorpaySettings } from "@/lib/payments/razorpay";
import { getPaymentForAppointment, markPaymentFailed } from "@/lib/payments/store";
import { getAppointment } from "@/lib/booking/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DemoSchema = z.object({ appointment_id: z.uuid(), outcome: z.enum(["success", "failure"]) }).strict();

// 031 DEMO_MODE only (404 otherwise): the demo checkout. `success` returns what Razorpay Checkout would hand to the
// success handler (order id, a deterministic payment id and its signature); the page then calls POST
// /api/payments/verify, exactly like a real payment. `failure` records a failed attempt (like payment.failed).
// Only the booking guardian, only for an order that exists.
export async function POST(req: Request) {
  if (!env.DEMO_MODE) return paymentError("not_found");
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, DemoSchema);
  if ("response" in parsed) return parsed.response;

  const appointment = await getAppointment(parsed.data.appointment_id);
  if (!appointment || appointment.guardian_user_id !== session.user.id) return paymentError("not_found");
  const payment = await getPaymentForAppointment(appointment.id);
  if (!payment || payment.gateway !== "demo") return paymentError("payment_not_found");

  const orderId = payment.razorpay_order_id;
  if (parsed.data.outcome === "failure") {
    await markPaymentFailed(orderId, demoId("pay", `${orderId}:failed`), "DEMO_DECLINED: demo payment declined");
    return ok({ status: "failed" });
  }
  const paymentId = demoId("pay", orderId);
  return ok({
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: checkoutSignature(orderId, paymentId, razorpaySettings().keySecret),
  });
}
