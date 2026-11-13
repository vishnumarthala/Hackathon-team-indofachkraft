import { requireIepPlanActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { publishPlan } from "@/lib/iep";
import { PublishSchema } from "@/lib/iep/schema";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025 FR-4: `Publish to parent` / `Publish changes` `{ version }` -> 200 { published_version, plan }.
// Makes the plan the case's active plan (archiving the previous one) and publishes a guardian-visible version.
export async function POST(req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const gate = await requireIepPlanActor(planId);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, PublishSchema);
  if ("response" in parsed) return parsed.response;

  const result = await publishPlan({ planId, actorUserId: gate.actor.user.id, version: parsed.data.version });
  if (!result.ok) return fail(result.status, result.error, result.details);
  drainSoon(result.event_ids);
  return ok({
    published_version: result.published.version,
    published_at: result.published.published_at,
    plan: result.plan,
    archived_plan_id: result.archived_plan_id,
  });
}
