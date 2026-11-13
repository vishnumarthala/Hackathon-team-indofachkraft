import { requireFeesCaseApi } from "@/lib/fees/authz";
import { listOpenLinks, listPackages, loadAccount } from "@/lib/fees/store";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-7: the case's family account (balance, packages, ledger, open links). Anyone with case access (022) reads;
// other organisations 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireFeesCaseApi(id);
  if ("response" in g) return g.response;
  const [account, links, packages] = await Promise.all([
    loadAccount(g.scope.orgId, g.scope.childId),
    listOpenLinks(g.scope.orgId, g.scope.childId),
    listPackages(g.scope.orgId, { activeOnly: true }),
  ]);
  return ok({ account, open_links: links, packages, can_manage: g.scope.access === "manage" });
}
