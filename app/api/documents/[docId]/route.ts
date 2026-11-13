import { requireDocumentAccess } from "@/lib/documents/access";
import { VisibilitySchema } from "@/lib/documents/schemas";
import { activeShareOrgIds, deleteDocument, documentJson, setVisibility } from "@/lib/documents/store";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// 023 FR-5: document metadata for anyone who may read it (FR-4); everyone else 404.
export async function GET(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const gate = await requireDocumentAccess(docId);
  if (gate instanceof Response) return gate;
  const shared =
    gate.access.path === "guardian" && gate.document.uploader_kind === "guardian"
      ? ((await activeShareOrgIds([gate.document])).get(docId) ?? [])
      : undefined;
  const res = ok({ document: documentJson(gate.document, gate.access, gate.user.id, shared) });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

// 023 E-2: providers of the document's case change whether the parent sees it.
export async function PATCH(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const gate = await requireDocumentAccess(docId);
  if (gate instanceof Response) return gate;
  if (!gate.access.can_edit) return fail(403, "Only the case's providers can change this");
  const parsed = await parseJson(req, VisibilitySchema);
  if ("response" in parsed) return parsed.response;
  const result = await setVisibility(docId, gate.user.id, parsed.data.visible_to_guardian);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ document: documentJson(result.data, gate.access, gate.user.id) });
}

// 023 FR-6: the uploader, or an owner/admin of the org for provider uploads; guardians never delete provider
// documents (403). Soft delete + storage object removed immediately + audit `document.deleted`.
export async function DELETE(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const gate = await requireDocumentAccess(docId);
  if (gate instanceof Response) return gate;
  if (!gate.access.can_delete) return fail(403, "You cannot delete this document");
  const result = await deleteDocument(docId, gate.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ deleted: true });
}
