import { requireCaseActor } from "@/lib/authz";
import { PaperWithdrawSchema } from "@/lib/children/codes";
import { getConsentState, publicConsentState } from "@/lib/consent";
import { recordConsent, requestMeta } from "@/lib/consent/records";
import { fail, ok, parseJson } from "@/lib/http";
import { getCase } from "@/lib/queries/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 020 FR-18c: the centre records a withdrawal the parent gave on paper or in person (no scan needed).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) return fail(404, "Case not found");
  const parsed = await parseJson(req, PaperWithdrawSchema);
  if ("response" in parsed) return parsed.response;

  const meta = requestMeta(req);
  const saved = await recordConsent({
    childId: caseRow.child_id,
    action: "withdrawn",
    method: "paper",
    features: [parsed.data.feature],
    locale: caseRow.language,
    caseId: caseRow.id,
    attestedBy: gate.actor.user.id,
    paperGuardianName: parsed.data.guardian_name,
    paperNote: parsed.data.note ?? null,
    ipHash: meta.ip_hash,
    userAgent: meta.user_agent,
  });
  if (!saved.ok) return fail(saved.status, saved.error);
  return ok({ state: publicConsentState(await getConsentState(caseRow.child_id)) });
}
