import { requireCaseActor } from "@/lib/authz";
import { getConsentState, publicConsentState } from "@/lib/consent";
import { parsePaperConsentForm, removeScan, uploadScan } from "@/lib/consent/paper";
import { documentsByIds, isCurrentDocument, OUTDATED_TEXT, recordConsent, requestMeta, SAVE_FAILED } from "@/lib/consent/records";
import { fail, ok } from "@/lib/http";
import { getCase } from "@/lib/queries/cases";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// 020 FR-18c: the centre records consent the parent gave on the printed form (signed scan + attestation).
// Counts like digital consent for every gate. One strict-audited transaction; nothing is kept on failure.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) return fail(404, "Case not found");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "Invalid request", { body: "Send the form as multipart/form-data" });
  }
  const parsed = await parsePaperConsentForm(form);
  if (!parsed.ok) return fail(400, "Invalid request", parsed.details);
  const input = parsed.data;

  // The printed versions: one per ticked feature, and each must still be the current text (else 409).
  let docs;
  try {
    docs = await documentsByIds(input.documentIds);
  } catch {
    return fail(503, SAVE_FAILED);
  }
  const chosen = input.features.map((f) => docs.find((d) => d.feature === f));
  if (chosen.some((d) => !d)) {
    return fail(400, "Invalid request", { consent_document_ids: "The printed form version is required for every ticked permission" });
  }
  for (const doc of chosen) if (doc && !(await isCurrentDocument(doc))) return fail(409, OUTDATED_TEXT);

  let path: string;
  try {
    path = await uploadScan(caseRow.child_id, input.scan);
  } catch (err) {
    console.error(`paper consent scan upload failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, SAVE_FAILED);
  }

  const meta = requestMeta(req);
  const saved = await recordConsent({
    childId: caseRow.child_id,
    action: "granted",
    method: "paper",
    features: input.features,
    documentIds: chosen.map((d) => d!.id),
    caseId: caseRow.id,
    attestedBy: gate.actor.user.id,
    paperGuardianName: input.guardianName,
    paperRelationship: input.relationship,
    paperSignedOn: input.signedOn,
    paperFormPath: path,
    ipHash: meta.ip_hash,
    userAgent: meta.user_agent,
  });
  if (!saved.ok) {
    await removeScan(path);
    return fail(saved.status, saved.error);
  }
  return ok({ state: publicConsentState(await getConsentState(caseRow.child_id)) }, 201);
}
