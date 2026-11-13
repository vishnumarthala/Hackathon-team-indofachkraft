import { audit } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { withProviderInput } from "@/lib/booking/provider-routes";
import { RuleCreateSchema } from "@/lib/booking/schemas";
import { createRule, listRules } from "@/lib/booking/store";
import { ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-8 weekly hours of the caller's own profile (`Add hours`). Times are wall-clock in the location's time zone
// (video-only hours: the profile's).
export async function GET() {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  return ok({ rules: await listRules(gate.ctx.profile.id) });
}

export async function POST(req: Request) {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RuleCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withProviderInput(() => createRule(gate.ctx, parsed.data));
  if ("response" in result) return result.response;
  await audit({ actorUserId: gate.actor.user.id, action: "booking.hours_added", entity: "availability_rule", entityId: result.data.id });
  return ok({ rule: result.data }, 201);
}
