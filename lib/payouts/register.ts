// Ticket 046: hooks 045's fee refunds (package unused sessions, session charges, overpayments) so the matching Route
// transfers are reversed first (FR-5). Imported for its side effect by lib/fees/jobs.ts, which runs the fee refunds.
// (A second registration after a dev reload is harmless: the hook is idempotent.)
import { refundPreconditions, registerRefundPrecondition, type RefundPrecondition } from "@/lib/fees/store";
import { reverseBeforeRefund } from "./reversals";

const reverseTransfersFirst: RefundPrecondition = async (refund) => {
  await reverseBeforeRefund({
    paymentId: refund.payment_id,
    amountPaise: refund.amount_paise,
    appointmentId: refund.appointment_id,
    full: false,
    excludeRefundId: refund.id,
  });
};

if (!refundPreconditions().includes(reverseTransfersFirst)) registerRefundPrecondition(reverseTransfersFirst);

export const PAYOUT_REFUND_HOOK = reverseTransfersFirst;
