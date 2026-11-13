import { auditActorOf, auditFailure } from "@/lib/audit";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { isUuid } from "@/lib/cases/validation";
import { adminRevokeGuardianLink } from "@/lib/children/links";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// 020 FR-16: a platform admin revokes a guardian link (e.g. a court order); effective on the next request.
// 041 FR-2: strict audit (`guardian.link_revoked` in the same transaction; 503 when it cannot be written).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  if ((await getUserRole(user.id)) !== "platform_admin") return fail(404, "Not found");
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Not found");
  let row: { id: string; child_id: string } | null;
  try {
    row = await adminRevokeGuardianLink(id, auditActorOf(user, "platform_admin"));
  } catch (err) {
    return auditFailure(err);
  }
  if (!row) return fail(404, "Not found");
  return ok({ revoked: true });
}
