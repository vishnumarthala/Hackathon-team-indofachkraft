// Which sign-in methods the Supabase project has switched on (public `/auth/v1/settings`).
// Cached for five minutes per server instance. Locally Google is off until credentials are configured, and phone
// is off until an SMS provider is set up (India: DLT-registered sender and template), so the pilot can run on
// Google sign-in alone without showing a phone form that cannot deliver codes.
import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";

const TTL_MS = 5 * 60_000;
type Methods = { google: boolean; phone: boolean };
let cached: { at: number; methods: Methods } | null = null;

async function methods(): Promise<Methods | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.methods;
  try {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { external?: { google?: boolean; phone?: boolean } };
    cached = { at: Date.now(), methods: { google: body.external?.google === true, phone: body.external?.phone === true } };
    return cached.methods;
  } catch {
    return null;
  }
}

export async function isGoogleAuthEnabled(): Promise<boolean> {
  // Unknown: show the button and let Supabase report a problem rather than hide sign-in.
  return (await methods())?.google ?? true;
}

/** Phone codes: on when Supabase has an SMS provider, or in DEMO_MODE (synthetic test numbers, docs/guardian-auth.md). */
export async function isPhoneAuthEnabled(): Promise<boolean> {
  if (isDemoMode()) return true;
  return (await methods())?.phone ?? true;
}

/** Tests only. */
export function resetAuthSettingsCache(): void {
  cached = null;
}
