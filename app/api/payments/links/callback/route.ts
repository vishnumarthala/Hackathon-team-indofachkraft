import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { guardianOfChild } from "@/lib/fees/authz";
import { runFeeJobsSoon } from "@/lib/fees/jobs";
import { applyLinkPaid, findLinkPayment } from "@/lib/fees/store";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon } from "@/lib/notify/outbox";
import { razorpaySettings, verifyPaymentLinkSignature } from "@/lib/payments/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("fees.callback");

function redirectTo(path: string): Response {
  return NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL), 303);
}

// 045 (public): Razorpay sends the payer back here after a payment link (and the DEMO_MODE checkout does the same).
// The query carries razorpay_payment_id, razorpay_payment_link_id, _reference_id, _status and razorpay_signature =
// HMAC_SHA256(link_id|reference_id|status|payment_id, key_secret), checked in constant time. A paid link goes through
// the same capture path as the `payment_link.paid` webhook (idempotent). A signed-in guardian of the child lands on the
// child's Payments page; anyone else (a phone at the desk) on a plain confirmation page without names.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const input = {
    paymentId: q.get("razorpay_payment_id") ?? "",
    linkId: q.get("razorpay_payment_link_id") ?? "",
    referenceId: q.get("razorpay_payment_link_reference_id") ?? "",
    status: q.get("razorpay_payment_link_status") ?? "",
    signature: q.get("razorpay_signature") ?? "",
  };
  let secret: string;
  try {
    secret = razorpaySettings().keySecret;
  } catch {
    return redirectTo("/pay/done?state=error");
  }
  if (!/^plink_[A-Za-z0-9]{6,40}$/.test(input.linkId) || !verifyPaymentLinkSignature(input, secret)) {
    return redirectTo("/pay/done?state=invalid");
  }
  const payment = await findLinkPayment(input.linkId);
  if (!payment) return redirectTo("/pay/done?state=invalid");
  if (input.status !== "paid") return redirectTo("/pay/done?state=failed");
  try {
    const r = await applyLinkPaid({ linkId: input.linkId, paymentId: input.paymentId, source: payment.gateway === "demo" ? "demo" : "callback" });
    runFeeJobsSoon();
    drainSoon();
    const user = await getAuthenticatedUser();
    if (user && payment.child_id && (await guardianOfChild(user.id, payment.child_id))) {
      return redirectTo(`/family/children/${payment.child_id}/payments?paid=1`);
    }
    return redirectTo(`/pay/done?state=paid${r.receipt_no ? `&receipt=${encodeURIComponent(r.receipt_no)}` : ""}`);
  } catch (err) {
    log.error("link capture failed", { error: errorMessage(err) });
    return redirectTo("/pay/done?state=error");
  }
}
