import { AuditWriteError, auditFailure } from "@/lib/audit";
import { requireCaseActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { createPrescription, getPrescriptionDetail, listCasePrescriptions } from "@/lib/rx";
import { requirePrescriber } from "@/lib/rx/authz";
import { RxCreateSchema } from "@/lib/rx/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-3: prescriptions of the case. Case access (022, else 404) AND a verified prescriber (028, else 403).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireCaseActor(id);
  if ("response" in access) return access.response;
  const gate = await requirePrescriber(access.actor, id);
  if ("response" in gate) return gate.response;
  return ok({ prescriptions: await listCasePrescriptions(id) }, 200);
}

// 039 FR-3: `{ from_report_id? }` -> 201 draft (prefilled from the 038 rx_draft of this case); the same AI draft again
// -> 200 with the prescription already started from it.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireCaseActor(id);
  if ("response" in access) return access.response;
  const gate = await requirePrescriber(access.actor, id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RxCreateSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof createPrescription>>;
  try {
    result = await createPrescription({
      caseId: id,
      actorUserId: gate.actor.user.id,
      profileId: gate.profile.id,
      fromReportId: parsed.data.from_report_id,
    });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ created: result.created, ...(await getPrescriptionDetail(result.id, id)) }, result.created ? 201 : 200);
}
