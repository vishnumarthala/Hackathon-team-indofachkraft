import { requireIepPlanActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { getPlanDetail, updatePlan } from "@/lib/iep";
import { MSG, PlanPatchSchema } from "@/lib/iep/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025 FR-3: one plan with goals, progress and trends (case access, else 404).
export async function GET(_req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const gate = await requireIepPlanActor(planId);
  if ("response" in gate) return gate.response;
  const detail = await getPlanDetail(planId, gate.caseId);
  if (!detail) return fail(404, MSG.planNotFound);
  return ok(detail);
}

// 025 FR-3: `{ title?, start_date?, review_date?, status?: "completed" | "archived", version }`; stale -> 409.
export async function PATCH(req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const gate = await requireIepPlanActor(planId);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, PlanPatchSchema);
  if ("response" in parsed) return parsed.response;

  const result = await updatePlan({ planId, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ plan: result.plan });
}
