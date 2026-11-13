import { requireIepGoalActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { listGoalProgress, recordProgress } from "@/lib/iep";
import { makeProgressSchema } from "@/lib/iep/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025: progress entries of a goal, oldest first.
export async function GET(_req: Request, { params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params;
  const gate = await requireIepGoalActor(goalId);
  if ("response" in gate) return gate.response;
  return ok({ progress: await listGoalProgress(goalId) });
}

// 025 FR-3: `{ observed_on, value, note? }` -> 201 { entry, trend }; future date or value outside the measure -> 400.
export async function POST(req: Request, { params }: { params: Promise<{ goalId: string }> }) {
  const { goalId } = await params;
  const gate = await requireIepGoalActor(goalId);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, makeProgressSchema());
  if ("response" in parsed) return parsed.response;

  const result = await recordProgress({
    goalId,
    actorUserId: gate.actor.user.id,
    observedOn: parsed.data.observed_on,
    value: parsed.data.value,
    note: parsed.data.note,
  });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ entry: result.entry, trend: result.trend }, 201);
}
