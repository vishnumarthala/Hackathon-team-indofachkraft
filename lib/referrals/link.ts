// Ticket 054: the paediatrician referral link printed on a provider's waiting-room poster (`/screen?ref=<slug>`).
// Pure; safe in client and server code. (Not to be confused with lib/referral, the 012 specialist packet.)
import { isPublicSlug } from "@/lib/providers/constants";

export const REF_PARAM = "ref";
/** FR-4: the poster page shows check-ins started from the poster in this window (= the unsaved check-in retention). */
export const REFERRAL_WINDOW_DAYS = 30;

/** A `?ref=` value (string, repeated param or anything a client sent) -> a well-formed slug, or null. Never throws. */
export function parseRef(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string" || first.length > 200) return null;
  const slug = first.trim().toLowerCase();
  return isPublicSlug(slug) ? slug : null;
}

export function referralPath(slug: string): string {
  if (!isPublicSlug(slug)) throw new Error("not a public profile slug");
  return `/screen?${REF_PARAM}=${slug}`;
}

/** Absolute link for the QR code: the app's base URL (scheme + host, no path) + `/screen?ref=<slug>`. */
export function referralUrl(appUrl: string, slug: string): string {
  const base = appUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(base)) throw new Error("not an app base URL");
  return `${base}${referralPath(slug)}`;
}

/** The link as printed under the QR code, without the scheme (`doctornearme.in/screen?ref=...`). */
export function shortReferralUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
