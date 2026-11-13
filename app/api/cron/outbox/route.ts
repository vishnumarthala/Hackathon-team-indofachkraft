import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/http";
import { runOutbox } from "@/lib/notify/worker";

// FR-4 outbox worker. Vercel cron calls it every minute with GET and `Authorization: Bearer <CRON_SECRET>`
// (vercel.json); POST does the same for manual runs and the pg_cron fallback. Never cached.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(req: Request) {
  if (!authorized(req)) return fail(401, "Unauthorized");
  // Returns in a few ms when nothing is due (one indexed exists query).
  return ok(await runOutbox({ timeBudgetMs: 20_000 }));
}

export { handle as GET, handle as POST };
