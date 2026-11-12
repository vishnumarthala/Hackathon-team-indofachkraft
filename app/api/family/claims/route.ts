import { requireGuardian } from "@/lib/authz";
import {
  CLAIM_CONFLICT,
  CLAIM_INVALID,
  CLAIM_RATE_LIMITED,
  ClaimSchema,
  childJson,
  claimChild,
  getChild,
  hashClaimCode,
  normalizeClaimCode,
} from "@/lib/children";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// A well-formed hash that matches no code: malformed input counts as a failed attempt like any wrong code.
const NO_MATCH = "0".repeat(64);

// 020 FR-12: link a clinic record with the code from the therapist. Invalid, expired and used codes all
// get the same 404; 5 failures per user per hour -> 429.
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, ClaimSchema);
  if ("response" in parsed) return parsed.response;
  const { code, relationship, existing_child_id } = parsed.data;
  const normalized = normalizeClaimCode(code);

  let result;
  try {
    result = await claimChild({
      codeHash: normalized ? hashClaimCode(normalized) : NO_MATCH,
      userId: session.user.id,
      relationship,
      existingChildId: existing_child_id ?? null,
    });
  } catch (err) {
    console.error(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not save. Please try again.");
  }

  if (result.result !== "claimed") {
    if (result.result === "rate_limited") return fail(429, CLAIM_RATE_LIMITED);
    if (result.result === "conflict") return fail(409, CLAIM_CONFLICT);
    if (result.result === "not_your_child") return fail(404, "Child not found");
    return fail(404, CLAIM_INVALID);
  }
  const child = await getChild(result.child_id);
  if (!child) return fail(503, "Could not save. Please try again.");
  return ok({ child: childJson(child) }, 201);
}
