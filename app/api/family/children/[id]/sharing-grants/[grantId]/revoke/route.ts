import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { fail, ok } from "@/lib/http";
import { revokeSharingGrant } from "@/lib/sharing/grants";

export const dynamic = "force-dynamic";

// 022 FR-5/FR-7: `Stop sharing`. Shared access ends on the grantee's next request.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; grantId: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id, grantId } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;

  const result = await revokeSharingGrant(access.child.id, grantId, session.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ grant: result.data });
}
