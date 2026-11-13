import { auditActorOf, auditFailure } from "@/lib/audit";
import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { leaveChild } from "@/lib/children/links";
import { ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// 020 FR-16: the guardian stops being linked to the child; every later request for it is a 404.
// 041 FR-2: strict audit (`guardian.left_child` in the same transaction; 503 when it cannot be written).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  try {
    await leaveChild(access.child.id, session.user.id, auditActorOf(session.user, "guardian"));
  } catch (err) {
    return auditFailure(err);
  }
  return ok({ left: true });
}
