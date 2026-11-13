import { auditFailure } from "@/lib/audit";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";
import { signPrescription } from "@/lib/rx";
import { requirePrescriptionActor } from "@/lib/rx/authz";
import { RxSignSchema } from "@/lib/rx/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-4: `{ confirm: true, allergy_override_reason? }` -> 200 { version, published_version }. The prescriber rule is
// checked by the gate AND again inside the signing transaction. 403 not a prescriber (also when suspended since the
// draft), 409 already signed, 422 incomplete items / allergy match without a reason (`details.matches`), 503 when the
// strict audit row, the published version or the PDF cannot be written (nothing is signed).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePrescriptionActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RxSignSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof signPrescription>>;
  try {
    result = await signPrescription({
      prescriptionId: id,
      actorUserId: gate.actor.user.id,
      allergyOverrideReason: parsed.data.allergy_override_reason,
    });
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  drainSoon(result.event_ids);
  return ok({ version: result.version, published_version: result.published_version, allergy_matches: result.matches });
}
