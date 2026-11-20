// Ticket 054: server side of the referral kit. A `?ref=<slug>` only counts when the slug is a verified + listed public
// profile, with demo profiles following SHOW_SYNTHETIC_LISTINGS exactly as `/p/<slug>` does (same loader). Anything
// else (unknown, unlisted, suspended, malformed, a lookup error) is silently ignored: the check-in works as usual.
import { env } from "@/lib/env";
import { pg } from "@/lib/pg";
import type { ProviderType } from "@/lib/providers/constants";
import { getPublicProfile, loadPublicProfile, type PublicProvider } from "@/lib/providers/public";
import { parseRef, REFERRAL_WINDOW_DAYS } from "./link";

if (typeof window !== "undefined") {
  throw new Error("lib/referrals/index.ts is server-only");
}

export type Referrer = { profileId: string; slug: string; displayName: string; providerType: ProviderType };
export type ReferrerLoader = (slug: string) => Promise<{ provider: Pick<PublicProvider, "id" | "slug" | "display_name" | "provider_type"> } | null>;

/** Uncached: session creation and the poster page see a suspended or unlisted profile at once. */
export const loadReferrerFresh: ReferrerLoader = (slug) => loadPublicProfile(slug, env.SHOW_SYNTHETIC_LISTINGS);

/** `/screen` uses the public profile cache (as `/p/<slug>`), dropped on every profile change. */
export async function resolveReferrer(ref: unknown, load: ReferrerLoader = getPublicProfile): Promise<Referrer | null> {
  const slug = parseRef(ref);
  if (!slug) return null;
  try {
    const data = await load(slug);
    if (!data) return null;
    const { id, display_name, provider_type } = data.provider;
    return { profileId: id, slug: data.provider.slug, displayName: display_name, providerType: provider_type };
  } catch (err) {
    console.error(`referral lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** FR-4 pilot metric: check-ins started from this provider's poster in the last 30 days (aggregate only). */
export async function countReferredCheckins(profileId: string, days = REFERRAL_WINDOW_DAYS): Promise<number> {
  const sql = await pg();
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.screen_sessions
    where referred_by_profile_id = ${profileId} and created_at >= now() - ${`${days} days`}::interval`;
  return row?.n ?? 0;
}
