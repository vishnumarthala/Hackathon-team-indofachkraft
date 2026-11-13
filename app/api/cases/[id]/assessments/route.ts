import { createAssessment, listCaseAssessments } from "@/lib/assessments";
import { makeAssignSchema } from "@/lib/assessments/schemas";
import { requireCaseActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 024 FR-8: questionnaires of the case (anyone with case access).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  return ok({ assessments: await listCaseAssessments(id) });
}

// 024 FR-8: send a questionnaire to a guardian with an active link to the case's child.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, makeAssignSchema());
  if ("response" in parsed) return parsed.response;

  const result = await createAssessment({ caseId: id, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  drainSoon(result.event_ids);
  return ok({ assessment: result.assessment }, 201);
}
