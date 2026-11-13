import { auditActorOf } from "@/lib/audit";
import { requireFeesCaseApi } from "@/lib/fees/authz";
import { feesRouteError, OfferSchema, offerPackage } from "@/lib/fees/store";
import { ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-3 `Offer package` (owner/admin; members 403, other organisations 404): a pending package + a Razorpay payment
// link (test mode / demo gateway), sent to the guardian (in-app + WhatsApp `payment_request`). 201 { child_package_id,
// payment_id, url, amount_paise }. Unpaid offers expire after 7 days.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireFeesCaseApi(id, { manage: true });
  if ("response" in g) return g.response;
  const parsed = await parseJson(req, OfferSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const result = await offerPackage(g.scope, parsed.data.package_id, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    return ok(result, 201);
  } catch (err) {
    const res = await feesRouteError(err);
    if (res) return res;
    throw err;
  }
}
