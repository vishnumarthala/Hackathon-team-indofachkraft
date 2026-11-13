// Per-IP limits for the public booking endpoints (in-memory per instance, like 029's directory search).
import { createRateLimiter } from "@/lib/geo/rate-limit";

/** GET /api/public/providers/:id/slots: 120 requests per minute. */
export const slotsLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

/** POST /api/appointments/hold: 30 holds per 10 minutes (anonymous holds block a slot for 10 minutes each). */
export const holdLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });
