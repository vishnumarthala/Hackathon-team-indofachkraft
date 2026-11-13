import { cronAuthorized } from "@/lib/cron";
import { runFeeJobs } from "@/lib/fees/jobs";
import { fail, ok } from "@/lib/http";
import { runPaymentJobs } from "@/lib/payments/jobs";

// 031 refund job (payments in refund_pending) + 045 fee jobs (balance links, fee refunds, offer/package expiry,
// reminders). Vercel cron every minute (vercel.json) with `Authorization: Bearer <CRON_SECRET>`; POST for manual runs.
// Locally `npm run -s outbox:run` runs it too.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  const payments = await runPaymentJobs();
  const fees = await runFeeJobs();
  return ok({ ...payments, fees });
}

export { handle as GET, handle as POST };
