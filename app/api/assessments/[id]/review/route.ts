import { reviewAssessment } from "@/lib/assessments";
import { ReviewSchema } from "@/lib/assessments/schemas";
import { requireAssessmentActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 024 FR-8: `Mark reviewed` (+ note) publishes the summary (published_versions, entity_type 'assessment');
// `share_with_parent` makes that version visible in the family portal.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAssessmentActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, ReviewSchema);
  if ("response" in parsed) return parsed.response;

  const result = await reviewAssessment({ assessmentId: id, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ assessment: result.assessment, published: result.published });
}
