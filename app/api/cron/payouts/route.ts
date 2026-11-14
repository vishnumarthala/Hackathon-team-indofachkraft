import { cronAuthorized } from "@/lib/cron";
import { fail, ok } from "@/lib/http";
import { runDailyPayoutJobs } from "@/lib/payouts/jobs";

// 046 FR-7 / FR-10: daily at 01:00 IST (vercel.json, `Authorization: Bearer <CRON_SECRET>`): reconciliation of captured
// payments against transfers, refunds and the platform share (admins alerted through the outbox), and last month's
// platform-fee tax invoices (issued by the 1st's run; idempotent). Transfers themselves run every minute with
// /api/cron/payments.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  return ok(await runDailyPayoutJobs());
}

export { handle as GET, handle as POST };
