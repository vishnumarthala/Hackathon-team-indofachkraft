import { ok } from "@/lib/http";
import { getImport, listImportedChildren, requireImportAccess } from "@/lib/import/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 047 FR-4: one import (counts, undo window) and the children it created (owner/admin of its organisation).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireImportAccess(id);
  if ("response" in gate) return gate.response;
  const [record, children] = await Promise.all([getImport(id), listImportedChildren(id)]);
  const res = ok({ import: record, children });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
