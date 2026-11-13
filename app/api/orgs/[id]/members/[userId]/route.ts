import { auditActorOf, auditFailure } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";
import { canManage, getMembershipRole, revokeMember } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const actorId = gate.actor.user.id;

  const { id: orgId, userId } = await params;
  if (!isUuid(orgId) || !canManage(await getMembershipRole(actorId, orgId))) {
    return fail(404, "Organisation not found");
  }
  if (!isUuid(userId)) return fail(404, "Member not found");

  let result: Awaited<ReturnType<typeof revokeMember>>;
  try {
    result = await revokeMember(orgId, userId, auditActorOf(gate.actor.user, gate.actor.role));
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error);
  return ok({ revoked: true });
}
