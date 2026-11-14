import { ok } from "@/lib/http";
import { requirePayoutsOrgApi } from "@/lib/payouts/authz";
import { listInvoices, listPayoutItems, payoutReadiness, payoutStatement } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-7: the centre's payout statement. Owner/admin of the organisation (members 403, other organisations 404).
// Families never reach this (D-4: the fee is shown to centres only).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requirePayoutsOrgApi(id);
  if ("response" in g) return g.response;
  const [readiness, statement, items, invoices] = await Promise.all([
    payoutReadiness(id),
    payoutStatement(id),
    listPayoutItems(id, { limit: 100 }),
    listInvoices(id),
  ]);
  return ok({ readiness, statement, items, invoices });
}
