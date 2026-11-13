import { AuditWriteError, auditFailure } from "@/lib/audit";
import { fail, ok, parseJson } from "@/lib/http";
import { getPrescriptionDetail, updateDraft } from "@/lib/rx";
import { requirePrescriptionActor } from "@/lib/rx/authz";
import { MSG, RxPatchSchema } from "@/lib/rx/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-3: one prescription with its current version (draft or signed).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePrescriptionActor(id);
  if ("response" in gate) return gate.response;
  const detail = await getPrescriptionDetail(id, gate.caseId);
  if (!detail) return fail(404, MSG.notFound);
  return ok(detail);
}

// 039 FR-3: save the draft `{ items, advice, follow_up, version }`; stale `version` -> 409; signed/void -> 409.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePrescriptionActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RxPatchSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof updateDraft>>;
  try {
    result = await updateDraft({ prescriptionId: id, actorUserId: gate.actor.user.id, body: parsed.data });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok(await getPrescriptionDetail(id, gate.caseId));
}
