import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";
import { canManage, getMembershipRole, revokeInvitation } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; invitationId: string }> }) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const userId = gate.actor.user.id;

  const { id: orgId, invitationId } = await params;
  if (!isUuid(orgId) || !canManage(await getMembershipRole(userId, orgId))) {
    return fail(404, "Organisation not found");
  }
  if (!isUuid(invitationId) || !(await revokeInvitation(orgId, invitationId))) {
    return fail(404, "Invitation not found");
  }

  await audit({
    actor: "therapist",
    actorUserId: userId,
    action: "org.invitation_revoked",
    entity: "org_invitation",
    entityId: invitationId,
    details: { org_id: orgId },
  });
  return ok({ revoked: true });
}
