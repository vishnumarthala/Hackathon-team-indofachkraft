import { cronAuthorized } from "@/lib/cron";
import { runFeeJobs } from "@/lib/fees/jobs";
import { fail, ok } from "@/lib/http";
import { runPaymentJobs } from "@/lib/payments/jobs";
import { paymentsEnabled } from "@/lib/payments/mode";
import { runPayoutJobs } from "@/lib/payouts/jobs";

// 031 refund job (payments in refund_pending) + 045 fee jobs (balance links, fee refunds, offer/package expiry,
// reminders) + 046 payout jobs (payout items, Route transfers, reversals, package expiry payouts). Vercel cron every
// minute (vercel.json) with `Authorization: Bearer <CRON_SECRET>`; POST for manual runs. Locally `npm run -s outbox:run` runs it too.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  // 055: free pilot (PAYMENTS_ENABLED is not "true"): no refunds, fee links, reminders or payouts run.
  if (!paymentsEnabled()) return ok({ skipped: "payments_disabled" });
  const payments = await runPaymentJobs();
  const fees = await runFeeJobs();
  const payouts = await runPayoutJobs();
  return ok({ ...payments, fees, payouts });
}

export { handle as GET, handle as POST };
