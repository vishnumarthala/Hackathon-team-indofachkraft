import { AuditWriteError, auditFailure } from "@/lib/audit";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";
import { voidPrescription } from "@/lib/rx";
import { requirePrescriptionActor } from "@/lib/rx/authz";
import { RxVoidSchema } from "@/lib/rx/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-1/FR-5: `Void` `{ reason }` -> 200; no new prescription version; guardians see `Cancelled by prescriber`.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePrescriptionActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RxVoidSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof voidPrescription>>;
  try {
    result = await voidPrescription({ prescriptionId: id, actorUserId: gate.actor.user.id, reason: parsed.data.reason });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  drainSoon(result.event_ids);
  return ok({ prescription: result.prescription });
}
