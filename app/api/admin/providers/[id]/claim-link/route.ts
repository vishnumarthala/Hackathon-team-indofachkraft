import { audit } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/http";
import { claimUrl, createClaimLink } from "@/lib/providers/claims";

export const dynamic = "force-dynamic";

// FR-5: 201 { url, expires_at }; a new link invalidates every earlier one for the profile.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Profile not found");

  const result = await createClaimLink(id, gate.actor.user.id);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actorUserId: gate.actor.user.id,
    action: "provider.claim_link_created",
    entity: "provider_profile",
    entityId: id,
    details: { expires_at: result.data.expiresAt },
  });
  return ok({ url: claimUrl(env.NEXT_PUBLIC_APP_URL, result.data.token), expires_at: result.data.expiresAt }, 201);
}
