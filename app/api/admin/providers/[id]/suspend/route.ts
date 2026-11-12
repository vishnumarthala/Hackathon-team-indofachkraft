import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { SuspendSchema } from "@/lib/providers/schemas";
import { suspendProfile } from "@/lib/providers/verification";

export const dynamic = "force-dynamic";

// FR-4 `Suspend` (verified profiles only). The audit row is written in the same transaction.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Profile not found");

  const parsed = await parseJson(req, SuspendSchema);
  if ("response" in parsed) return parsed.response;

  const result = await suspendProfile(id, gate.actor.user.id, parsed.data.note);
  if (!result.ok) return fail(result.status, result.error);
  invalidatePublicProviders();
  return ok({ verification_status: "suspended" });
}
