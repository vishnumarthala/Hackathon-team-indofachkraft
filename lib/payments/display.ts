// Ticket 031 FR-8: payment labels for /family/appointments and the provider agenda. Pure; the pages translate the
// returned key (`payments.labels.<key>`).
import type { PaymentRow } from "./store";

export type PaymentLabel = "paid" | "paidOnline" | "pending" | "refundPending" | "refunded" | "notRefunded" | "atClinic";

/** Guardian-side cancellations at least this long before the start are refunded in full (FR-7). */
export const REFUND_WINDOW_HOURS = 24;

type Appt = { status: string; service_snapshot: { payment_mode: "online" | "at_clinic" | "free" } };

export function paymentLabel(appointment: Appt, payment: Pick<PaymentRow, "status"> | null | undefined, viewer: "guardian" | "provider"): PaymentLabel | null {
  const mode = appointment.service_snapshot.payment_mode;
  if (mode === "at_clinic") return "atClinic";
  if (mode !== "online") return null;
  switch (payment?.status) {
    case "captured":
      return appointment.status === "cancelled" ? "notRefunded" : viewer === "guardian" ? "paid" : "paidOnline";
    case "refund_pending":
      return "refundPending";
    case "refunded":
      return "refunded";
    default:
      return appointment.status === "pending_payment" ? "pending" : null;
  }
}

export const PAYMENT_LABEL_STYLE: Record<PaymentLabel, string> = {
  paid: "bg-teal-50 text-teal-900",
  paidOnline: "bg-teal-50 text-teal-900",
  pending: "bg-amber-50 text-amber-900",
  refundPending: "bg-sky-50 text-sky-900",
  refunded: "bg-sky-50 text-sky-900",
  notRefunded: "bg-slate-100 text-slate-700",
  atClinic: "bg-slate-100 text-slate-800",
};

/** A pending_payment appointment whose 15-minute payment hold is still open (`Pay now`). */
export function paymentHoldOpen(a: { status: string; hold_expires_at: string | null }, now = Date.now()): boolean {
  return a.status === "pending_payment" && Boolean(a.hold_expires_at) && Date.parse(a.hold_expires_at as string) > now;
}
