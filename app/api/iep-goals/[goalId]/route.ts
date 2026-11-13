import { requireIepGoalActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { deleteGoal, updateGoal } from "@/lib/iep";
import { GoalPatchSchema } from "@/lib/iep/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025 FR-3: edit a goal (any goal field, `status`, `sort`; plan `version` required; stale -> 409).
export async function PATCH(req: Request, { params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params;
  const gate = await requireIepGoalActor(goalId);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, GoalPatchSchema);
  if ("response" in parsed) return parsed.response;

  const result = await updateGoal({ goalId, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ goal: result.goal, plan_version: result.plan_version });
}

// 025 FR-3: draft plans delete the goal; active plans mark it `discontinued`. Optional `?version=` (plan version).
export async function DELETE(req: Request, { params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params;
  const gate = await requireIepGoalActor(goalId);
  if ("response" in gate) return gate.response;
  const raw = new URL(req.url).searchParams.get("version");
  const version = raw === null ? null : Number(raw);
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    return fail(400, "Invalid request", { version: "version must be a positive integer" });
  }

  const result = await deleteGoal({ goalId, actorUserId: gate.actor.user.id, version });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ deleted: result.deleted, goal: result.goal, plan_version: result.plan_version });
}
