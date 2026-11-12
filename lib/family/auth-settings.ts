// Whether the Supabase project has the Google provider switched on (public `/auth/v1/settings`).
// Cached for five minutes per server instance. Locally Google is off until credentials are configured.
import { env } from "@/lib/env";

const TTL_MS = 5 * 60_000;
let cached: { at: number; google: boolean } | null = null;

export async function isGoogleAuthEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.google;
  try {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { external?: { google?: boolean } };
    cached = { at: Date.now(), google: body.external?.google === true };
  } catch {
    // Unknown: show the button and let Supabase report a problem rather than hide sign-in.
    return true;
  }
  return cached.google;
}
