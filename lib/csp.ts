// Content-Security-Policy for family/child pages (ticket 019, NFR-2). No third-party scripts: no analytics,
// ads, tag managers or social pixels, ever. Next.js reads the nonce from the request header and adds it
// to its own scripts. Approved exceptions (product owner 2026-11-12) are added per route prefix below by the
// ticket that needs them: the ElevenLabs SDK (033, 040) and Razorpay checkout (031). Nothing else.
import { isBookingPath, isFamilyPath } from "@/lib/auth-access";

type CspAllowance = { scriptSrc?: string[]; connectSrc?: string[]; frameSrc?: string[] };

// 033: the ElevenLabs SDK is bundled (no external <script>, so no script-src exception); the voice check-in needs
// its API and WebRTC (LiveKit) endpoints: US plus the data-residency hosts the SDK may pick. The SDK's audio
// worklets are loaded by bundled code, which 'strict-dynamic' allows. Vendor listed in third-party-allowlist.ts.
const ELEVENLABS_CONNECT = [
  "https://api.elevenlabs.io",
  "wss://api.elevenlabs.io",
  "https://livekit.rtc.elevenlabs.io",
  "wss://livekit.rtc.elevenlabs.io",
  "wss://api.eu.residency.elevenlabs.io",
  "wss://livekit.rtc.eu.residency.elevenlabs.io",
  "wss://api.in.residency.elevenlabs.io",
  "wss://livekit.rtc.in.residency.elevenlabs.io",
];

/**
 * Route prefix -> extra sources (approved exceptions only). A `*` segment matches one path segment (the payment page
 * key below). Every script origin must also be in lib/privacy/third-party-allowlist.ts for that route
 * (tests/no-tracking.test.ts).
 */
export const FAMILY_CSP_EXCEPTIONS: Record<string, CspAllowance> = {
  "/screen": { connectSrc: ELEVENLABS_CONNECT },
  // 034: the voice booking widget on /find (approved 2026-11-13). /find is not under the strict family policy today
  // (029 loads Google Maps there), so this applies once it is.
  "/find": { connectSrc: ELEVENLABS_CONNECT },
  // 031: Razorpay Checkout on the payment page only (script, its API iframe and telemetry endpoint).
  "/book/*/pay/*": {
    scriptSrc: ["https://checkout.razorpay.com"],
    connectSrc: ["https://api.razorpay.com", "https://lumberjack.razorpay.com"],
    frameSrc: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  },
};

function underRoutePrefix(pathname: string, prefix: string): boolean {
  if (!prefix.includes("*")) return pathname === prefix || pathname.startsWith(`${prefix}/`);
  const want = prefix.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  return have.length >= want.length && want.every((seg, i) => seg === "*" || seg === have[i]);
}

/** 033 NFR-1: the public check-in gets the same strict CSP as child pages (no analytics, ElevenLabs only). */
export function isScreenPath(pathname: string): boolean {
  return pathname === "/screen" || pathname.startsWith("/screen/");
}

export function needsFamilyCsp(pathname: string): boolean {
  // 030: the booking flow shows the guardian's children, so it gets the same no-third-party policy.
  return isFamilyPath(pathname) || isBookingPath(pathname) || isScreenPath(pathname);
}

function exceptionsFor(pathname: string): Required<CspAllowance> {
  const merged = { scriptSrc: [] as string[], connectSrc: [] as string[], frameSrc: [] as string[] };
  for (const [prefix, allowance] of Object.entries(FAMILY_CSP_EXCEPTIONS)) {
    if (!underRoutePrefix(pathname, prefix)) continue;
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
