// Ticket 031: payment API errors. Bodies are `{ error, code }` (English contract); the UI maps `code` to translations.
import { NextResponse } from "next/server";

export const PAYMENT_ERRORS = {
  not_found: { status: 404, error: "Appointment not found" },
  payment_not_found: { status: 404, error: "Payment not found" },
  not_payable: { status: 409, error: "This appointment has nothing to pay online." },
  already_paid: { status: 409, error: "This appointment is already paid." },
  hold_expired: { status: 410, error: "Your hold expired. Please pick the time again." },
  invalid_signature: { status: 400, error: "The payment could not be verified." },
  not_configured: { status: 503, error: "Online payment is not available right now. Please try again later." },
  gateway_error: { status: 502, error: "The payment could not be started. Please try again." },
} as const;

export type PaymentErrorCode = keyof typeof PAYMENT_ERRORS;

export function paymentError(code: PaymentErrorCode): Response {
  const { status, error } = PAYMENT_ERRORS[code];
  return NextResponse.json({ error, code }, { status });
}
