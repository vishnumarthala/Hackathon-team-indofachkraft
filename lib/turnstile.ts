// Ticket 051 FR-8: Cloudflare Turnstile bot check on cheap-to-abuse endpoints (voice starts on /screen and /find, the
// phone sign-in code). On only when both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set; local and DEMO_MODE
// setups leave them empty and nothing is checked. Anti-abuse service, not analytics (docs/privacy/processors.md).
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { TURNSTILE_HEADER } from "@/lib/voice/client";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

const log = logger("turnstile");

export function turnstileEnabled(): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/** The public site key for pages that render the widget, or null when the check is off. */
export function turnstileSiteKey(): string | null {
  return turnstileEnabled() ? (env.TURNSTILE_SITE_KEY ?? null) : null;
}

function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || null;
}

/**
 * True when the check is off, or the request's `X-Turnstile-Token` is valid for our secret. Fails closed on a missing
 * or malformed token, a network error or an unexpected answer.
 */
export async function verifyTurnstile(req: Request, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!turnstileEnabled()) return true;
  const token = req.headers.get(TURNSTILE_HEADER);
  if (!token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY as string, response: token });
  const ip = clientIp(req);
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetchFn(TURNSTILE_VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as { success?: unknown } | null;
    return json?.success === true;
  } catch (err) {
    log.warn("verification failed", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
