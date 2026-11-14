import { audit, auditActorOf } from "@/lib/audit";
import { fail } from "@/lib/http";
import { requirePayoutsOrgApi } from "@/lib/payouts/authz";
import { payoutCsv } from "@/lib/payouts/csv";
import { listPayoutItems } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// 046 FR-7: the payout items as CSV (owner/admin; members 403, other organisations 404). ?from=&to= (YYYY-MM-DD,
// session dates). Formula-like cells are neutralised.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requirePayoutsOrgApi(id);
  if ("response" in g) return g.response;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) return fail(400, "Invalid request", { from: "Use YYYY-MM-DD" });
  const items = await listPayoutItems(id, { from, to, limit: 5000 });
  await audit({ ...auditActorOf(g.actor.user, g.actor.role), orgId: id, action: "payouts.exported", entity: "organization", entityId: id, details: { rows: items.length, from: from ?? null, to: to ?? null } });
  return new Response(payoutCsv(items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payouts-${from ?? "all"}-${to ?? "now"}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
