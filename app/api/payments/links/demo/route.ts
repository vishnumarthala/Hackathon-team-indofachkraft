import { z } from "zod";
import { env } from "@/lib/env";
import { findLinkPayment } from "@/lib/fees/store";
import { fail, ok, parseJson } from "@/lib/http";
import { demoId, paymentLinkSignature, razorpaySettings } from "@/lib/payments/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DemoSchema = z.object({ link_id: z.string().regex(/^plink_[A-Za-z0-9]{6,40}$/), outcome: z.enum(["success", "failure"]) }).strict();

// 045 DEMO_MODE only (404 otherwise; public like a Razorpay hosted page): the demo payment link page. `success`
// returns the signed redirect Razorpay would send (the page follows it to /api/payments/links/callback, the same path
// as a real payment); `failure` does nothing to the link (a real failed attempt leaves it open too).
export async function POST(req: Request) {
  if (!env.DEMO_MODE) return fail(404, "Not found");
  const parsed = await parseJson(req, DemoSchema);
  if ("response" in parsed) return parsed.response;
  const payment = await findLinkPayment(parsed.data.link_id);
  if (!payment || payment.gateway !== "demo") return fail(404, "Payment link not found");
  if (payment.status !== "created") return fail(409, "This payment link is closed");
  if (parsed.data.outcome === "failure") return ok({ status: "failed" });
  const paymentId = demoId("pay", payment.razorpay_payment_link_id);
  const params = {
    linkId: payment.razorpay_payment_link_id,
    referenceId: payment.id.replace(/-/g, ""),
    status: "paid",
    paymentId,
  };
  const query = new URLSearchParams({
    razorpay_payment_id: paymentId,
    razorpay_payment_link_id: params.linkId,
    razorpay_payment_link_reference_id: params.referenceId,
    razorpay_payment_link_status: "paid",
    razorpay_signature: paymentLinkSignature(params, razorpaySettings().keySecret),
  });
  return ok({ callback_url: `/api/payments/links/callback?${query.toString()}` });
}

