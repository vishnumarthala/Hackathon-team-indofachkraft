// Shared handling for the provider schedule routes (FR-8): input errors -> 400 with the field, everything else rethrown.
import { fail } from "@/lib/http";
import { ProviderInputError } from "./store";

export async function withProviderInput<T>(fn: () => Promise<T>): Promise<{ data: T } | { response: Response }> {
  try {
    return { data: await fn() };
  } catch (err) {
    if (err instanceof ProviderInputError) return { response: fail(400, "Invalid request", { [err.field]: err.message }) };
    // 23514: a location not linked to the profile (booking_check_location) or a table check constraint.
    if ((err as { code?: string }).code === "23514") return { response: fail(400, "Invalid request", { body: "Check the values" }) };
    throw err;
  }
}
