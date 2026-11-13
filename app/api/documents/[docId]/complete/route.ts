import { requirePendingUpload } from "@/lib/documents/access";
import { completeUpload, documentJson } from "@/lib/documents/store";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// 023 FR-3 step 2 (uploader only): checks the stored object (exists, <= 20 MB, magic bytes match the declared
// type), computes its sha256 and marks it ready. A mismatch deletes the document and the object (422).
export async function POST(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const gate = await requirePendingUpload(docId);
  if (gate instanceof Response) return gate;
  const result = await completeUpload(gate.document, gate.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ document: documentJson(result.data, null, gate.user.id) });
}
