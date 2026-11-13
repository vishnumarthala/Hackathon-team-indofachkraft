import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { DOCUMENT_NOT_FOUND } from "@/lib/documents/constants";
import { ShareSchema } from "@/lib/documents/schemas";
import { shareDocument } from "@/lib/documents/store";
import { getDocumentAccess, loadDocument } from "@/lib/documents/access";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// 023 FR-7: share a family upload with one organisation treating the child (read only, revocable).
export async function POST(req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id, docId } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const [document, docAccess] = await Promise.all([loadDocument(docId), getDocumentAccess(session.user.id, docId)]);
  if (!document || document.child_id !== access.child.id || docAccess?.path !== "guardian") return fail(404, DOCUMENT_NOT_FOUND);

  const parsed = await parseJson(req, ShareSchema);
  if ("response" in parsed) return parsed.response;
  const result = await shareDocument(docId, parsed.data.org_id, session.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ shared: true }, 201);
}
