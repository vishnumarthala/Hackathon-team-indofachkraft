// 041 FR-13 / D-6: third-party script origins allowed on child pages (`/family/**`), each scoped to the routes that
// need it. Approved by the product owner on 2026-11-12: the ElevenLabs SDK (voice agents, 033/040) and Razorpay
// checkout (031). Nothing else: analytics, ads, tag managers and social pixels are banned on every child page.
// `tests/no-tracking.test.ts` crawls the rendered `/family/**` pages and fails on any `<script src>` outside the app
// origin unless it is listed here for that route; it also checks that the CSP exceptions in lib/csp.ts
// (FAMILY_CSP_EXCEPTIONS) are a subset of this list. A ticket that adds an exception adds it in both places.

export type ThirdPartyEntry = {
  name: string;
  /** Script origins (`https://host`). */
  origins: string[];
  /** Route patterns (`*` = one path segment) where the scripts may load. */
  routes: string[];
  ticket: string;
};

export const THIRD_PARTY_ALLOWLIST: ThirdPartyEntry[] = [
  {
    name: "ElevenLabs SDK (voice agent)",
    origins: ["https://elevenlabs.io", "https://api.elevenlabs.io"],
    routes: ["/family/children/*/ask", "/family/children/*/follow-up"],
    ticket: "040",
  },
  {
    // 033 NFR-1: the public developmental check-in (a page about a child, same no-tracking rule).
    name: "ElevenLabs SDK (developmental check-in)",
    origins: ["https://elevenlabs.io", "https://api.elevenlabs.io"],
    routes: ["/screen"],
    ticket: "033",
  },
  {
    name: "Razorpay checkout",
    origins: ["https://checkout.razorpay.com"],
    routes: ["/family/appointments", "/family/appointments/*", "/family/appointments/*/pay"],
    ticket: "031",
  },
];

/** Analytics, ads, tag managers and social pixels: never allowed, not even through the allowlist. */
export const BANNED_SCRIPT_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "connect.facebook.net",
  "facebook.com",
  "fbcdn.net",
  "hotjar.com",
  "clarity.ms",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "fullstory.com",
  "mouseflow.com",
  "plausible.io",
  "posthog.com",
  "snap.licdn.com",
  "ads.linkedin.com",
  "analytics.tiktok.com",
  "static.ads-twitter.com",
  "bat.bing.com",
  "cdn.amplitude.com",
  "js.hs-scripts.com",
  "intercom.io",
];

function routeMatches(pattern: string, pathname: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const a = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  return p.length === a.length && p.every((seg, i) => seg === "*" || seg === a[i]);
}

export function isBannedHost(host: string): boolean {
  const h = host.toLowerCase();
  return BANNED_SCRIPT_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
}

/**
 * Whether a `<script src>` is acceptable on `pathname`: same origin (relative or `appOrigin`), or an allowlisted
 * origin for this route that is not a banned host.
 */
export function scriptAllowed(src: string, pathname: string, appOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(src, appOrigin);
  } catch {
    return false;
  }
  if (url.origin === new URL(appOrigin).origin) return true;
  if (isBannedHost(url.hostname)) return false;
  return THIRD_PARTY_ALLOWLIST.some((e) => e.origins.includes(url.origin) && e.routes.some((r) => routeMatches(r, pathname)));
}

export function allowedOriginsFor(pathname: string): string[] {
  return THIRD_PARTY_ALLOWLIST.filter((e) => e.routes.some((r) => routeMatches(r, pathname))).flatMap((e) => e.origins);
}
