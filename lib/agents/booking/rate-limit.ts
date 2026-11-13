// Ticket 034 FR-2 / FR-3: per-instance in-memory limits (same sliding window as 029/033). Keys are salted hashes of
// the client IP with a salt that lives only in this process; the IP itself is never kept.
import { createHash, randomBytes } from "node:crypto";
import { clientIp, createRateLimiter } from "@/lib/geo/rate-limit";
import { SESSIONS_PER_HOUR } from "./constants";

const SALT = randomBytes(16).toString("hex");

export function rateKey(req: Request): string {
  return createHash("sha256").update(`${SALT}:${clientIp(req)}`).digest("hex");
}

/** FR-2: 5 new voice booking sessions per IP per hour. */
export const agentSessionLimiter = createRateLimiter({ limit: SESSIONS_PER_HOUR, windowMs: 60 * 60_000 });

/** Tool endpoints: ElevenLabs calls from a few shared egress IPs, so this only caps bursts; the real limit is per session. */
export const toolBurstLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
