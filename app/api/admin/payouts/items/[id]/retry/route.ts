import { auditActorOf } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";
import { runPayoutJobsSoon } from "@/lib/payouts/jobs";
import { payoutsRouteError, retryPayoutItem } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-3 / FR-9 `Retry`: a failed transfer (or one waiting for the payout account) is tried again now with fresh
// retries (strict audit `payouts.transfer_retried`); the transfer runs right after the response.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  if (!isUuid(id)) return fail(404, "Payout not found");
  try {
    const item = await retryPayoutItem(id, { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id });
    runPayoutJobsSoon();
    return ok({ item });
  } catch (err) {
    const res = await payoutsRouteError(err);
    if (res) return res;
    throw err;
  }
}
