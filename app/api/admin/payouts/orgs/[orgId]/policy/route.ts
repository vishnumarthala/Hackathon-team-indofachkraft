import { auditActorOf } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { payoutsRouteError, PolicyInputSchema, setFeePolicy } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-9: a platform admin sets a centre's fee policy (percent in basis points 0-3000 or flat paise; min / cap paise;
// waived_until). Each change is a new version the owner accepts again (FR-8). Strict audit `payouts.fee_policy_changed`.
export async function PUT(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  if (!isUuid(orgId)) return fail(404, "Organisation not found");
  const parsed = await parseJson(req, PolicyInputSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const policy = await setFeePolicy(orgId, parsed.data, { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id });
    return ok({ policy });
  } catch (err) {
    const res = await payoutsRouteError(err);
    if (res) return res;
    throw err;
  }
}
