import { cronAuthorized } from "@/lib/cron";
import { fail, ok } from "@/lib/http";
import { runPaymentJobs } from "@/lib/payments/jobs";

// 031 refund job (payments in refund_pending). Vercel cron every minute (vercel.json) with
// `Authorization: Bearer <CRON_SECRET>`; POST for manual runs. Locally `npm run -s outbox:run` runs it too.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  return ok(await runPaymentJobs());
}

export { handle as GET, handle as POST };
