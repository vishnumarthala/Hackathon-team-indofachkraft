import { requireCaseActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { createPlan, listCasePlans } from "@/lib/iep";
import { PlanCreateSchema } from "@/lib/iep/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025 FR-3: IEP plans of the case (anyone with case access), newest first with publish state.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  return ok({ plans: await listCasePlans(id) });
}

// 025 FR-3: create a draft plan `{ title, start_date, review_date }` -> 201 { plan }.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, PlanCreateSchema);
  if ("response" in parsed) return parsed.response;

  const result = await createPlan({ caseId: id, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ plan: result.plan }, 201);
}
