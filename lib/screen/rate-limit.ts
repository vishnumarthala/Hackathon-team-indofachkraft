// Ticket 033 FR-4 / FR-5: 5 new check-in sessions per IP per hour. Same in-memory sliding window as the voice demo
// and the directory (lib/geo/rate-limit.ts), per server instance. The key is a salted hash of the IP with a salt
// that lives only in this process, so the IP itself is never kept (not in memory, not in the database).
import { createHash, randomBytes } from "node:crypto";
import { clientIp, createRateLimiter } from "@/lib/geo/rate-limit";
import { SESSIONS_PER_HOUR } from "./questions";

const SALT = randomBytes(16).toString("hex");

export const screenSessionLimiter = createRateLimiter({ limit: SESSIONS_PER_HOUR, windowMs: 60 * 60_000 });

export function rateKey(req: Request): string {
  return createHash("sha256").update(`${SALT}:${clientIp(req)}`).digest("hex");
}

export function allowScreenSession(req: Request, now = Date.now()): boolean {
  return screenSessionLimiter.allow(rateKey(req), now);
}

/** 048 FR-10: provider matches below a result (a few directory and slot queries each): 30 per minute per IP. */
export const screenMatchesLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

export function allowScreenMatches(req: Request, now = Date.now()): boolean {
  return screenMatchesLimiter.allow(rateKey(req), now);
}
