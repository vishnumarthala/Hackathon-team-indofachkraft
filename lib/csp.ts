// Content-Security-Policy for family/child pages (ticket 019, NFR-2). No third-party scripts: no analytics,
// ads, tag managers or social pixels, ever. Next.js reads the nonce from the request header and adds it
// to its own scripts. Approved exceptions (product owner 2026-11-12) are added per route prefix below by the
// ticket that needs them: the ElevenLabs SDK (033, 040) and Razorpay checkout (031). Nothing else.
import { isBookingPath, isFamilyPath } from "@/lib/auth-access";

type CspAllowance = { scriptSrc?: string[]; connectSrc?: string[]; frameSrc?: string[] };

/** Route prefix -> extra sources. Empty until a later ticket adds an approved exception. */
export const FAMILY_CSP_EXCEPTIONS: Record<string, CspAllowance> = {};

export function needsFamilyCsp(pathname: string): boolean {
  // 030: the booking flow shows the guardian's children, so it gets the same no-third-party policy.
  return isFamilyPath(pathname) || isBookingPath(pathname);
}

function exceptionsFor(pathname: string): Required<CspAllowance> {
  const merged = { scriptSrc: [] as string[], connectSrc: [] as string[], frameSrc: [] as string[] };
  for (const [prefix, allowance] of Object.entries(FAMILY_CSP_EXCEPTIONS)) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    merged.scriptSrc.push(...(allowance.scriptSrc ?? []));
    merged.connectSrc.push(...(allowance.connectSrc ?? []));
    merged.frameSrc.push(...(allowance.frameSrc ?? []));
  }
  return merged;
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function familyCsp(options: { pathname: string; nonce: string; supabaseUrl?: string; isDev: boolean }): string {
  const extra = exceptionsFor(options.pathname);
  let supabaseOrigin = "";
  try {
    if (options.supabaseUrl) supabaseOrigin = new URL(options.supabaseUrl).origin;
  } catch {
    supabaseOrigin = "";
  }
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", `'nonce-${options.nonce}'`, "'strict-dynamic'", ...(options.isDev ? ["'unsafe-eval'"] : []), ...extra.scriptSrc],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    // 027: Supabase Realtime (messaging) connects over ws(s):// to the same Supabase host.
    ["connect-src", ["'self'", ...(supabaseOrigin ? [supabaseOrigin, supabaseOrigin.replace(/^http/, "ws")] : []), ...extra.connectSrc]],
    ["frame-src", extra.frameSrc.length ? extra.frameSrc : ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
