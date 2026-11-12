import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { fail, ok, parseJson } from "@/lib/http";
import { canManage, createInvitation, getMembershipRole, InviteCreateSchema, inviteUrl } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const userId = gate.actor.user.id;

  const { id: orgId } = await params;
  if (!isUuid(orgId) || !canManage(await getMembershipRole(userId, orgId))) {
    return fail(404, "Organisation not found");
  }

  const parsed = await parseJson(req, InviteCreateSchema);
  if ("response" in parsed) return parsed.response;

  const { token, invitationId, orgName } = await createInvitation(orgId, userId, parsed.data);
  const url = inviteUrl(env.NEXT_PUBLIC_APP_URL, token);

  let emailed = false;
  try {
    emailed = (
      await sendEmail({
        to: parsed.data.email,
        subject: `You're invited to ${orgName} on DoctorNearMe`,
        text:
          `You have been invited to join ${orgName} on DoctorNearMe as ${parsed.data.org_role}. ` +
          `Sign in with this email address and open the link to accept (valid for 7 days): ${url}`,
      })
    ).delivered;
  } catch (err) {
    console.error(`invitation email failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await audit({
    actor: "therapist",
    actorUserId: userId,
    action: "org.invitation_created",
    entity: "org_invitation",
    entityId: invitationId,
    details: { org_id: orgId, org_role: parsed.data.org_role, emailed },
  });
  return ok({ url, emailed }, 201);
}
