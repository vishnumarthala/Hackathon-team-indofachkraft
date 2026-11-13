import { requireProviderApi } from "@/lib/authz";
import { ok } from "@/lib/http";
import { pg } from "@/lib/pg";
import { checkImportManager, prepareImport, previewJson, readUpload } from "@/lib/import/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 047 FR-1/FR-2: validate an uploaded CSV for an organisation (owner/admin). Nothing is stored.
export async function POST(req: Request) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const upload = await readUpload(req);
  if ("response" in upload) return upload.response;
  const denied = await checkImportManager(gate.actor.user.id, upload.orgId);
  if (denied) return denied;

  const prepared = await prepareImport(await pg(), upload.orgId as string, upload.bytes);
  const res = ok(previewJson(prepared));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
