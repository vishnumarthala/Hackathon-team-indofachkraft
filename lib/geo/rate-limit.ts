// Ticket 029 FR-3: in-memory sliding-window rate limit per key (client IP). Per server instance, like the
// /api/providers/join limit; a shared store can replace it when the app runs on several instances.
export function createRateLimiter(options: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, number[]>();
  const maxKeys = options.maxKeys ?? 10_000;

  function allow(key: string, now = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
    if (recent.length >= options.limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.delete(key);
    hits.set(key, recent);
    // Bound memory: drop the least recently used keys.
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value as string);
    return true;
  }

  return { allow, reset: () => hits.clear() };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

/** FR-3: GET /api/public/providers allows 60 requests per minute per IP. */
export const directorySearchLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
