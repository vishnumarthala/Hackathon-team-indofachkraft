import { getAuditActor } from "@/lib/audit";
import { FactActionSchema, updateFact } from "@/lib/facts";
import { requireFactAccess } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireFactAccess(id);
  if (denied) return denied;
  const parsed = await parseJson(req, FactActionSchema);
  if ("response" in parsed) return parsed.response;

  const result = await updateFact(id, parsed.data, await getAuditActor());
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data);
}
