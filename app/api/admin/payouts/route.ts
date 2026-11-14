import { requirePlatformAdminApi } from "@/lib/authz";
import { ok } from "@/lib/http";
import { adminPayoutOverview } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-9: platform admins - revenue this month (fees, GST, GMV), payout accounts and fee policies per centre, failed
// and on-hold transfers. Other roles 403.
export async function GET() {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  return ok(await adminPayoutOverview());
}
