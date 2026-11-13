import { materializeDueSeries } from "@/lib/booking/series";
import { expireStaleHolds } from "@/lib/booking/store";
import { cronAuthorized } from "@/lib/cron";
import { fail, ok } from "@/lib/http";

// FR-5 hold cleanup. Vercel cron calls it every minute (vercel.json) with `Authorization: Bearer <CRON_SECRET>`;
// POST does the same for manual runs. held / pending_payment rows past hold_expires_at -> expired (+ history row).
// Late payments after expiry are 031's concern.
// 043 FR-4: then the weekly series' rolling horizon: every live series is materialized up to 8 weeks ahead (one
// transaction per series; a series with nothing new costs one indexed lookup) and its next reminder is scheduled.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  if (!cronAuthorized(req)) return fail(401, "Unauthorized");
  const expired = await expireStaleHolds();
  return ok({ expired, series: await materializeDueSeries() });
}

export { handle as GET, handle as POST };
