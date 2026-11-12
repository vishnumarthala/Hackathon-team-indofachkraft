import { audit } from "@/lib/audit";
import { getAuthenticatedUser } from "@/lib/auth";
import { fail, ok } from "@/lib/http";
import { claimProfile } from "@/lib/providers/claims";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { ClaimTokenSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-6: binds the signed-in user to the seeded profile, makes them owner of the seeded organisation and
// sets role `provider` server-side. A user who already has a profile gets 409.
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const { token } = await params;
  if (!ClaimTokenSchema.safeParse(token).success) return fail(404, "This link is not valid.");

  const result = await claimProfile(token, user.id);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actor: "therapist",
    actorUserId: user.id,
    action: "provider.claimed",
    entity: "provider_profile",
    entityId: result.data.profileId,
  });
  invalidatePublicProviders();
  return ok({ profile_id: result.data.profileId, redirect: "/dashboard/profile" });
}
