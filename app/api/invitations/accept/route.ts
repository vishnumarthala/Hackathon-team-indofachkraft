import { auditFailure, getAuditActor } from "@/lib/audit";
import { getAuthenticatedUser } from "@/lib/auth";
import { fail, ok, parseJson } from "@/lib/http";
import { acceptInvitation, InviteAcceptSchema } from "@/lib/orgs";

export const dynamic = "force-dynamic";

// Any signed-in account may accept an invitation sent to its own email; guardians become providers.
export async function POST(req: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");

  const parsed = await parseJson(req, InviteAcceptSchema);
  if ("response" in parsed) return fail(404, "This invitation is not valid");

  let result: Awaited<ReturnType<typeof acceptInvitation>>;
  try {
    result = await acceptInvitation({ id: user.id, email: user.email }, parsed.data.token, await getAuditActor());
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error);
  return ok({ org_id: result.data.orgId });
}
