import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Cron routes: `Authorization: Bearer <CRON_SECRET>` (Vercel cron sends it). Unset secret = refuse everything. */
export function cronAuthorized(req: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
