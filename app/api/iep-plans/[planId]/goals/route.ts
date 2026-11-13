import { requireIepPlanActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { addGoal, listPlanGoals } from "@/lib/iep";
import { GoalCreateSchema } from "@/lib/iep/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025: goals of a plan (ordered), without progress.
export async function GET(_req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const gate = await requireIepPlanActor(planId);
  if ("response" in gate) return gate.response;
  return ok({ goals: await listPlanGoals(planId) });
}

// 025 FR-3: add a SMART goal (all five SMART fields, measure, baseline, target, target date, plan `version`).
export async function POST(req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const gate = await requireIepPlanActor(planId);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, GoalCreateSchema);
  if ("response" in parsed) return parsed.response;

  const result = await addGoal({ planId, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ goal: result.goal, plan_version: result.plan_version }, 201);
}
