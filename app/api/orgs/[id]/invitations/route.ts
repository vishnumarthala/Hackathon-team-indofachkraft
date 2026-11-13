import { auditActorOf, auditFailure } from "@/lib/audit";
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

  let created: Awaited<ReturnType<typeof createInvitation>>;
  try {
    created = await createInvitation(orgId, userId, parsed.data, new Date(), auditActorOf(gate.actor.user, gate.actor.role));
  } catch (err) {
    return auditFailure(err);
  }
  const { token, orgName } = created;
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

  return ok({ url, emailed }, 201);
}
