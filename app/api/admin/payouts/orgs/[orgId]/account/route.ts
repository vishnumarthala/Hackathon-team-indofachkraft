import { auditActorOf } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { AccountInputSchema, payoutsRouteError, setPayoutAccount } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-2 / FR-9: a platform admin sets a centre's Route linked account id and status by hand (KYC happens in the
// Razorpay dashboard - a human step). DEMO_MODE fakes the account id when none is given. Strict audit
// `payouts.account_changed`. Other roles 403.
export async function PUT(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  if (!isUuid(orgId)) return fail(404, "Organisation not found");
  const parsed = await parseJson(req, AccountInputSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const account = await setPayoutAccount(orgId, parsed.data, { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id });
    return ok({ account });
  } catch (err) {
    const res = await payoutsRouteError(err);
    if (res) return res;
    throw err;
  }
}
