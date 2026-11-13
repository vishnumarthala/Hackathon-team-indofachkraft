import { cronAuthorized } from "@/lib/cron";
import { fail, ok } from "@/lib/http";
import { runPrivacyJobs } from "@/lib/privacy/jobs";

// 041 FR-7 / FR-8: builds queued exports, executes approved deletion requests and retries failed processor deletions.
// Every 5 minutes (vercel.json); requests also start their job right away with after().
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  return ok(await runPrivacyJobs());
}

export { handle as GET, handle as POST };
