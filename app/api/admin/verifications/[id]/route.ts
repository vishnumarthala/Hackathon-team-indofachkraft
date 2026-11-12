import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { ReviewSchema } from "@/lib/providers/schemas";
import { reviewSubmission } from "@/lib/providers/verification";

export const dynamic = "force-dynamic";

// FR-4 approve / reject a submitted credential. Reject always needs a note; approve needs one for
// council OTHER (what the admin checked). Audit `provider.verified` / `provider.rejected` is strict.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Submission not found");

  const parsed = await parseJson(req, ReviewSchema);
  if ("response" in parsed) return parsed.response;

  const result = await reviewSubmission(id, gate.actor.user.id, parsed.data.action, parsed.data.note ?? null);
  if (!result.ok) return fail(result.status, result.error);
  invalidatePublicProviders();
  return ok({
    profile_id: result.data.profileId,
    verification_status: parsed.data.action === "approve" ? "verified" : "rejected",
  });
}
