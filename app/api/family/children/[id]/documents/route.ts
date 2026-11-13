import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { GuardianUploadSchema } from "@/lib/documents/schemas";
import { createUpload, documentJson, listGuardianDocuments } from "@/lib/documents/store";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// 023 FR-7: the child's documents a guardian may see (family uploads + provider uploads made visible).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const rows = await listGuardianDocuments([access.child.id]);
  return ok({
    documents: rows.map((row) => ({
      ...documentJson(row, null, session.user.id, row.uploader_kind === "guardian" ? row.shared_with_org_ids : undefined),
      org_name: row.org_name,
    })),
  });
}

// 023 FR-3: step 1 of a guardian upload -> pending document + signed upload URL into the private bucket.
// `share_with_org_ids` must be organisations with a case for the child (422 otherwise).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;

  const parsed = await parseJson(req, GuardianUploadSchema);
  if ("response" in parsed) return parsed.response;
  const result = await createUpload({ kind: "guardian", childId: access.child.id, userId: session.user.id, input: parsed.data });
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data, 201);
}
