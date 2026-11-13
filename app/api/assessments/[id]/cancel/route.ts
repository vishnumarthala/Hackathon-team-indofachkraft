import { cancelAssessment } from "@/lib/assessments";
import { requireAssessmentActor } from "@/lib/authz";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 024 FR-8: cancel an open (assigned / in progress) questionnaire.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAssessmentActor(id);
  if ("response" in gate) return gate.response;
  const result = await cancelAssessment({ assessmentId: id, actorUserId: gate.actor.user.id });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ status: result.status });
}
