import { audit } from "@/lib/audit";
import { requireProviderProfileOwner } from "@/lib/authz";
import { ok, parseJson } from "@/lib/http";
import { updateProfile, withPrescriber } from "@/lib/providers";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { ProfileUpdateSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-3 owner edits. Verification status, listing, claim and prescriber flags are not fields of the schema,
// so they are ignored if sent; a provider_type change on a verified profile re-queues verification (trigger).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;

  const parsed = await parseJson(req, ProfileUpdateSchema);
  if ("response" in parsed) return parsed.response;

  const profile = await updateProfile(id, parsed.data);
  await audit({
    actorUserId: gate.actor.user.id,
    action: "provider.profile_updated",
    entity: "provider_profile",
    entityId: id,
    details: { fields: Object.keys(parsed.data), verification_status: profile.verification_status },
  });
  invalidatePublicProviders();
  return ok({ profile: withPrescriber(profile) });
}
