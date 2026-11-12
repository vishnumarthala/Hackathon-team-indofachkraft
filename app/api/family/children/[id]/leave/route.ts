import { audit } from "@/lib/audit";
import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { revokeGuardianLink } from "@/lib/children";
import { ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// 020 FR-16: the guardian stops being linked to the child; every later request for it is a 404.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  await revokeGuardianLink(access.child.id, session.user.id, session.user.id);
  await audit({
    actor: "parent",
    actorUserId: session.user.id,
    action: "guardian.left_child",
    entity: "child",
    entityId: access.child.id,
  });
  return ok({ left: true });
}
