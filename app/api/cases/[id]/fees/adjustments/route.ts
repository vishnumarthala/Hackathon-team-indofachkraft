import { auditActorOf } from "@/lib/audit";
import { requireFeesCaseApi } from "@/lib/fees/authz";
import { runFeeJobsSoon } from "@/lib/fees/jobs";
import { addAdjustment, AdjustmentSchema, feesRouteError } from "@/lib/fees/store";
import { ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-7 / FR-10 `Adjustment` (owner/admin, reason required): a signed ledger row - the ledger is never edited.
// { amount_inr: +N (the family owes more) | -N (credit), reason } -> 201 { ledger_id, balance_paise }.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireFeesCaseApi(id, { manage: true });
  if ("response" in g) return g.response;
  const parsed = await parseJson(req, AdjustmentSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const result = await addAdjustment(g.scope, parsed.data, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    runFeeJobsSoon();
    return ok(result, 201);
  } catch (err) {
    const res = await feesRouteError(err);
    if (res) return res;
    throw err;
  }
}
