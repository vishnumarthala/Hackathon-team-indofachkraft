import { getAssessmentForProvider } from "@/lib/assessments";
import { MSG } from "@/lib/assessments/schemas";
import { requireAssessmentActor } from "@/lib/authz";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 024 FR-8: one questionnaire with answers, (live or stored) score, red flags and the current published summary.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAssessmentActor(id);
  if ("response" in gate) return gate.response;
  const detail = await getAssessmentForProvider(id, gate.caseId);
  if (!detail) return fail(404, MSG.notFound);
  return ok(detail);
}
