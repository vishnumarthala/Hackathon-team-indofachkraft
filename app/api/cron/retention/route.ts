import { cronAuthorized } from "@/lib/cron";
import { fail, ok } from "@/lib/http";
import { runRetention } from "@/lib/privacy/retention";

// 041 FR-6: daily retention job (vercel.json). GET for Vercel cron, POST for manual runs; same bearer check.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  return ok({ counts: await runRetention() });
}

export { handle as GET, handle as POST };
