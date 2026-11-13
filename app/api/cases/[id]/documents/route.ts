import { requireCaseActor } from "@/lib/authz";
import { ProviderUploadSchema } from "@/lib/documents/schemas";
import { createUpload, documentJson, listCaseDocuments } from "@/lib/documents/store";
import { fail, ok, parseJson } from "@/lib/http";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 023 FR-8: the case's documents and the family uploads shared with the case's organisation.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const rows = await listCaseDocuments(id);
  return ok({
    documents: rows.map((row) => ({
      ...documentJson(row, null, gate.actor.user.id),
      case_id: row.case_id,
      org_name: row.org_name,
      uploader_name: row.uploader_name,
    })),
  });
}

// 023 FR-3: step 1 of a provider upload to this case (org = the case's org) -> signed upload URL.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const kase = await getCase(id);
  if (!kase?.child_id) return fail(404, "Case not found");

  const parsed = await parseJson(req, ProviderUploadSchema);
  if ("response" in parsed) return parsed.response;
  const result = await createUpload({
    kind: "provider",
    childId: kase.child_id,
    caseId: kase.id,
    orgId: kase.org_id,
    userId: gate.actor.user.id,
    input: parsed.data,
  });
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data, 201);
}
