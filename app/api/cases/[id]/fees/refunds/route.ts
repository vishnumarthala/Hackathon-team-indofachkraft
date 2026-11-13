import { auditActorOf } from "@/lib/audit";
import { requireFeesCaseApi } from "@/lib/fees/authz";
import { runFeeJobsSoon } from "@/lib/fees/jobs";
import { runPaymentJobsSoon } from "@/lib/payments/jobs";
import { feesRouteError, RefundSchema, requestRefund } from "@/lib/fees/store";
import { ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-9 refunds (owner/admin, reason required): { kind: "package", child_package_id } refunds the unused sessions
// (price minus the used sessions' consultation amounts); { kind: "session", appointment_id } refunds a paid session.
// 201 { fee_refund_id, payment_id, amount_paise, via }. The refund job sends it to Razorpay; a `refund` ledger row is
// added when it is processed.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireFeesCaseApi(id, { manage: true });
  if ("response" in g) return g.response;
  const parsed = await parseJson(req, RefundSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const result = await requestRefund(g.scope, parsed.data, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    if (result.via === "payment") runPaymentJobsSoon([result.payment_id]);
    else runFeeJobsSoon();
    return ok(result, 201);
  } catch (err) {
    const res = await feesRouteError(err);
    if (res) return res;
    throw err;
  }
}
