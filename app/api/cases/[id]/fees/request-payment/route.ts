import { auditActorOf } from "@/lib/audit";
import { requireFeesCaseApi } from "@/lib/fees/authz";
import { feesRouteError, requestPayment } from "@/lib/fees/store";
import { ok } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-7 `Request payment` (owner/admin): one payment link for everything open on the account (replacing an older
// one), sent to the guardian. 200 { payment_id, url, amount_paise }; nothing open -> 409 `nothing_due`.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireFeesCaseApi(id, { manage: true });
  if ("response" in g) return g.response;
  try {
    const result = await requestPayment(g.scope, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    drainSoon();
    return ok(result);
  } catch (err) {
    const res = await feesRouteError(err);
    if (res) return res;
    throw err;
  }
}
