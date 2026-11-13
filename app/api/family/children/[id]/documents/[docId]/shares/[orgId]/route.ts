import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { DOCUMENT_NOT_FOUND } from "@/lib/documents/constants";
import { unshareDocument } from "@/lib/documents/store";
import { getDocumentAccess, loadDocument } from "@/lib/documents/access";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// 023 FR-7: stop sharing a family upload with an organisation.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; docId: string; orgId: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id, docId, orgId } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const [document, docAccess] = await Promise.all([loadDocument(docId), getDocumentAccess(session.user.id, docId)]);
  if (!document || document.child_id !== access.child.id || docAccess?.path !== "guardian") return fail(404, DOCUMENT_NOT_FOUND);
  if (!isUuid(orgId)) return fail(404, "Sharing not found");

  const result = await unshareDocument(docId, orgId, session.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ revoked: true });
}
