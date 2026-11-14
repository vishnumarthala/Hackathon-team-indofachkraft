import { auditActorOf } from "@/lib/audit";
import { parseJson, ok } from "@/lib/http";
import { requirePayoutsOrgApi } from "@/lib/payouts/authz";
import { AcceptSchema, acceptFeePolicy, payoutsRouteError } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-8: the owner accepts the current platform-fee policy version (once per version; strict audit
// `payouts.fee_policy_accepted`). { policy_version } must be the version shown, else 409 policy_changed. Admins and
// members 403, other organisations 404.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requirePayoutsOrgApi(id, { owner: true });
  if ("response" in g) return g.response;
  const parsed = await parseJson(req, AcceptSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const readiness = await acceptFeePolicy(id, parsed.data.policy_version, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    return ok({ readiness });
  } catch (err) {
    const res = await payoutsRouteError(err);
    if (res) return res;
    throw err;
  }
}
