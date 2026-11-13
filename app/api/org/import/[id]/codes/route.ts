import { fail, ok } from "@/lib/http";
import { getImport, regenerateCodes, requireImportAccess } from "@/lib/import/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// 047 FR-3/FR-4: new claim codes (72 h) for the import's children that no family has linked yet. Shown once; older
// unused codes stop working (020 FR-12). Nothing is sent: the centre shares the list.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireImportAccess(id);
  if ("response" in gate) return gate.response;
  const record = await getImport(id);
  if (!record) return fail(404, "Import not found");
  if (record.undone_at) return fail(409, "This import was undone");
  let items;
  try {
    items = await regenerateCodes(id, gate.actor.user.id);
  } catch (err) {
    console.error(`import codes failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not create the codes. Please try again.");
  }
  const res = ok({ items }, 201);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
