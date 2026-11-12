import { BulkActionSchema, bulkUpdate } from "@/lib/facts";
import { requireRecordingAccess } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireRecordingAccess(id);
  if (denied) return denied;
  const parsed = await parseJson(req, BulkActionSchema);
  if ("response" in parsed) return parsed.response;

  const result = await bulkUpdate(id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data);
}
