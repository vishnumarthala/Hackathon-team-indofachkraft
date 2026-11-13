// SQL state-machine error codes (raised by the booking_* functions) -> HTTP responses (FR-4). API error bodies stay
// English (contract); the UI maps `code` to translated text.
import { NextResponse } from "next/server";

export const BOOKING_ERRORS = {
  slot_taken: { status: 409, error: "This slot was just taken. Please pick another time." },
  hold_expired: { status: 410, error: "Your hold expired. Please pick the time again." },
  slot_unavailable: { status: 422, error: "This time is not available. Please pick another time." },
  too_soon: { status: 422, error: "Appointments must be booked at least 2 hours ahead." },
  too_far: { status: 422, error: "Appointments can be booked up to 14 days ahead." },
  service_not_found: { status: 404, error: "Service not found" },
  not_found: { status: 404, error: "Appointment not found" },
  invalid_transition: { status: 409, error: "This appointment cannot be changed in its current state." },
  too_late: { status: 409, error: "It is too late to change this appointment. Please contact the provider." },
  not_started: { status: 409, error: "The appointment has not started yet." },
  child_required: { status: 422, error: "Choose which child the appointment is for." },
  child_not_linked: { status: 422, error: "Choose one of your children." },
  not_guardian: { status: 403, error: "Only family accounts can book appointments." },
  invalid_owner: { status: 400, error: "Invalid request" },
  idempotency_mismatch: { status: 422, error: "This request key was already used for a different booking." },
  invalid_status: { status: 400, error: "Invalid request" },
} as const;

export type BookingErrorCode = keyof typeof BOOKING_ERRORS;

export class BookingError extends Error {
  constructor(readonly code: BookingErrorCode) {
    super(code);
    this.name = "BookingError";
  }
}

export function isBookingErrorCode(value: unknown): value is BookingErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BOOKING_ERRORS, value);
}

/** A postgres error raised by `booking_raise(code)` (message = code) -> BookingError; anything else is rethrown. */
export function toBookingError(err: unknown): BookingError | null {
  if (err instanceof BookingError) return err;
  const message = (err as { message?: unknown } | null)?.message;
  return isBookingErrorCode(message) ? new BookingError(message) : null;
}

export function bookingErrorResponse(code: BookingErrorCode): Response {
  const { status, error } = BOOKING_ERRORS[code];
  return NextResponse.json({ error, code }, { status });
}

/** Runs a state-machine call; booking errors become their HTTP response, other errors propagate (500). */
export async function withBookingErrors<T>(fn: () => Promise<T>): Promise<{ data: T } | { response: Response }> {
  try {
    return { data: await fn() };
  } catch (err) {
    const known = toBookingError(err);
    if (known) return { response: bookingErrorResponse(known.code) };
    throw err;
  }
}
