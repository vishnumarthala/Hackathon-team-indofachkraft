import { requireDocumentAccess } from "@/lib/documents/access";
import { downloadUrl } from "@/lib/documents/store";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

// 023 FR-5 / NFR-1: access check (FR-4), then the strict `document.downloaded` audit row, then a 302 to a
// 300 s signed URL of the private bucket. Nothing is cached and the URL is never logged.
export async function GET(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const gate = await requireDocumentAccess(docId);
  if (gate instanceof Response) return noStore(gate);
  const result = await downloadUrl(docId, gate.user.id);
  if (!result.ok) return noStore(fail(result.status, result.error));
  return new Response(null, {
    status: 302,
    headers: { Location: result.data, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}
