import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";
import { canManage, getMembershipRole } from "@/lib/orgs";
import { updateOrgPublic } from "@/lib/providers";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { OrgPublicSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

async function hasVerifiedProvider(orgId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("provider_locations")
    .select("provider_profiles!inner(verification_status)")
    .eq("org_id", orgId)
    .eq("provider_profiles.verification_status", "verified")
    .limit(1);
  if (error) throw new Error(`Could not check providers: ${error.message}`);
  return (data ?? []).length > 0;
}

// Public organisation fields (ticket 028 FR-1) for /c/<slug>; owners and admins only, other orgs -> 404.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const userId = gate.actor.user.id;
  const { id: orgId } = await params;
  if (!isUuid(orgId) || !canManage(await getMembershipRole(userId, orgId))) return fail(404, "Organisation not found");

  const parsed = await parseJson(req, OrgPublicSchema);
  if ("response" in parsed) return parsed.response;
  if (parsed.data.listed && !(await hasVerifiedProvider(orgId))) {
    return fail(409, "An organisation can be listed once one of its providers is verified");
  }

  const org = await updateOrgPublic(orgId, parsed.data);
  await audit({
    actor: "therapist",
    actorUserId: userId,
    action: "org.public_updated",
    entity: "organization",
    entityId: orgId,
    details: { fields: Object.keys(parsed.data) },
  });
  invalidatePublicProviders();
  return ok({ org });
}
