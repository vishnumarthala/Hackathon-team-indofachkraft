import { audit } from "@/lib/audit";
import { requireProviderProfileOwner } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { setListed } from "@/lib/providers";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { ListingSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-8 `Show my profile publicly`: only a verified profile can be listed.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;

  const parsed = await parseJson(req, ListingSchema);
  if ("response" in parsed) return parsed.response;

  const result = await setListed(id, parsed.data.listed);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actorUserId: gate.actor.user.id,
    action: parsed.data.listed ? "provider.listed" : "provider.unlisted",
    entity: "provider_profile",
    entityId: id,
  });
  invalidatePublicProviders();
  return ok({ listed: result.data.listed });
}
