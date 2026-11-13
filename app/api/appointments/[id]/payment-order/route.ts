import { audit } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { getAppointment } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { ok } from "@/lib/http";
import { errorMessage, logger } from "@/lib/log";
import { paymentError } from "@/lib/payments/errors";
import { razorpaySettings, RazorpayConfigError, type RazorpaySettings } from "@/lib/payments/razorpay";
import { createPaymentOrder } from "@/lib/payments/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("payments.order");

// 031 FR-3: the booking guardian of a `pending_payment` appointment (hold unexpired) gets a Razorpay order, created
// once (an existing order is returned). Someone else's appointment 404; nothing to pay (free / at the clinic /
// confirmed) 409; already paid 409; expired 410.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  if (!isUuid(id)) return paymentError("not_found");
  const appointment = await getAppointment(id);
  if (!appointment || appointment.guardian_user_id !== session.user.id) return paymentError("not_found");

  const snap = appointment.service_snapshot;
  // 042 FR-2a: demo bookings are never paid (the database also refuses a payment row for them).
  if (appointment.is_demo || snap.payment_mode !== "online" || !(snap.fee_inr > 0)) return paymentError("not_payable");
  const expired =
    appointment.status === "expired" ||
    (appointment.status === "pending_payment" && (!appointment.hold_expires_at || Date.parse(appointment.hold_expires_at) <= Date.now()));
  if (expired) return paymentError("hold_expired");
  if (appointment.status !== "pending_payment") return paymentError("not_payable");

  let settings: RazorpaySettings;
  try {
    settings = razorpaySettings();
  } catch (err) {
    if (err instanceof RazorpayConfigError) {
      log.error("razorpay not configured", { error: err.message });
      return paymentError("not_configured");
    }
    throw err;
  }

  let result: Awaited<ReturnType<typeof createPaymentOrder>>;
  try {
    result = await createPaymentOrder({ appointmentId: id, amountPaise: snap.fee_inr * 100 }, { settings });
  } catch (err) {
    log.error("order creation failed", { appointment: id, error: errorMessage(err) });
    return paymentError("gateway_error");
  }
  if (!result.ok) return paymentError(result.code);

  if (result.created) {
    await audit({
      actorUserId: session.user.id,
      actorRole: "guardian",
      orgId: appointment.org_id,
      childId: appointment.child_id,
      action: "payment.order_created",
      entity: "payment",
      entityId: result.payment.id,
      details: { appointment_id: id, amount_paise: result.payment.amount_paise, gateway: result.payment.gateway },
    });
  }
  return ok({
    key_id: result.keyId,
    order_id: result.payment.razorpay_order_id,
    amount_paise: result.payment.amount_paise,
    currency: result.payment.currency,
    prefill: { name: session.profile.display_name ?? "" },
    demo: settings.mode === "demo",
  });
}
