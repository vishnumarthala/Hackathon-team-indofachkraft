import { auditActorOf } from "@/lib/audit";
import { ok, parseJson } from "@/lib/http";
import { requirePayoutsOrgApi } from "@/lib/payouts/authz";
import { payoutsRouteError, setPayoutSettings, SettingsSchema } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-6 / FR-7: owner/admin set the package expiry policy (`pay_centre` | `refund_family`) and the centre's GSTIN
// for the platform-fee invoice. Strict audit `payouts.settings_changed`. Members 403, other organisations 404.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requirePayoutsOrgApi(id);
  if ("response" in g) return g.response;
  const parsed = await parseJson(req, SettingsSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const readiness = await setPayoutSettings(id, parsed.data, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    return ok({ readiness });
  } catch (err) {
    const res = await payoutsRouteError(err);
    if (res) return res;
    throw err;
  }
}
