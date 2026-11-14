// Shared handling for the provider schedule routes (FR-8): input errors -> 400 with the field, everything else rethrown.
import { fail } from "@/lib/http";
import { PayoutsError, payoutsErrorResponse } from "@/lib/payouts/store";
import { ProviderInputError } from "./store";

export async function withProviderInput<T>(fn: () => Promise<T>): Promise<{ data: T } | { response: Response }> {
  try {
    return { data: await fn() };
  } catch (err) {
    if (err instanceof ProviderInputError) return { response: fail(400, "Invalid request", { [err.field]: err.message }) };
    // 046 FR-2: 409 payout_account_inactive / fee_policy_not_accepted ("Finish payout setup to accept payments").
    if (err instanceof PayoutsError) return { response: payoutsErrorResponse(err.code) };
    // 23514: a location not linked to the profile (booking_check_location) or a table check constraint.
    if ((err as { code?: string }).code === "23514") return { response: fail(400, "Invalid request", { body: "Check the values" }) };
    throw err;
  }
}
