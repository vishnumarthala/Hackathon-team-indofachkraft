// Ticket 055: free pilot mode. One server-side switch, `PAYMENTS_ENABLED` (lib/env.ts): payments run only when it is
// exactly "true"; the default is the free pilot. Payment code stays in place so payments can be switched on later
// (docs/payments.md "Free pilot mode").
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import type { Queryable } from "@/lib/pg";

export function paymentsEnabled(): boolean {
  return env.PAYMENTS_ENABLED;
}

/** Fee / package / payout / payment-link APIs while payments are off: a plain 404. */
export function paymentsDisabledResponse(): Response {
  return NextResponse.json({ error: "Not found", code: "payments_disabled" }, { status: 404 });
}

/** Null when payments are on; otherwise the 404 every payment-only route returns first. */
export function paymentsGate(): Response | null {
  return paymentsEnabled() ? null : paymentsDisabledResponse();
}

/**
 * Passes the switch to the database for the rest of the transaction (`app.payments_enabled`, migration
 * 20261120005500_free_pilot_mode.sql): 044's billing rule and 045's billing trigger read it. Call it first in every
 * transaction that marks an outcome through 030's functions.
 */
export async function setPaymentsMode(tx: Queryable): Promise<void> {
  await tx`select public.payments_set_enabled(${paymentsEnabled()})`;
}
