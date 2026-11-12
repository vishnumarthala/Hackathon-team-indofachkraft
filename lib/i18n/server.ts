// Server-side locale and time zone resolution (ticket 018). Use from Server Components, Route Handlers
// and server utilities. Client components use lib/i18n/client.tsx instead.
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getAuthenticatedUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/db";
import { getCaseByToken } from "@/lib/queries/intake";
import {
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  isLocale,
  isValidTimeZone,
  LOCALE_COOKIE,
  localeFromAcceptLanguage,
  PATH_HEADER,
  TIME_ZONE_COOKIE,
  type Locale,
} from "./config";
import { createFormatter, type Formatter } from "./format";
import type { Namespace, TFunction } from "./keys";
import { getMessages } from "./messages";
import { createTranslator } from "./translate";

if (typeof window !== "undefined") {
  throw new Error("lib/i18n/server.ts is server-only");
}

export type LocaleSources = {
  cookie?: string | null;
  profileLocale?: string | null;
  caseLanguage?: string | null;
  acceptLanguage?: string | null;
};

/** FR-3 order: cookie > profile > intake case language > Accept-Language > en. Invalid values are skipped. */
export function resolveLocale(sources: LocaleSources): Locale {
  if (isLocale(sources.cookie)) return sources.cookie;
  if (isLocale(sources.profileLocale)) return sources.profileLocale;
  if (isLocale(sources.caseLanguage)) return sources.caseLanguage;
  return localeFromAcceptLanguage(sources.acceptLanguage) ?? DEFAULT_LOCALE;
}

/** FR-5a order: cookie > profile > Asia/Kolkata. Invalid zones are skipped. */
export function resolveTimeZone(sources: { cookie?: string | null; profileTimeZone?: string | null }): string {
  if (isValidTimeZone(sources.cookie)) return sources.cookie;
  if (isValidTimeZone(sources.profileTimeZone)) return sources.profileTimeZone;
  return DEFAULT_TIME_ZONE;
}

type ViewerPreferences = { preferred_locale: string | null; time_zone: string | null };

// NFR-3: anonymous requests (no Supabase auth cookie) never touch the network; signed-in requests read
// user_profiles at most once per request (React cache), and only when a preference cookie is missing.
const getViewerPreferences = cache(async (): Promise<ViewerPreferences | null> => {
  const store = await cookies();
  if (!store.getAll().some((c) => c.name.startsWith("sb-"))) return null;
  let user: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    user = await getAuthenticatedUser();
  } catch (error) {
    // Preferences are cosmetic: fall back to the anonymous order instead of failing the page.
    console.error(`[i18n] Could not verify session for preferences: ${(error as Error).message}`);
    return null;
  }
  if (!user) return null;
  const { data, error } = await supabaseAdmin()
    .from("user_profiles")
    .select("preferred_locale, time_zone")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    console.error(`[i18n] Could not load viewer preferences: ${error.message}`);
    return null;
  }
  return (data as ViewerPreferences | null) ?? null;
});

const INTAKE_PATH = /^\/intake\/([^/?#]+)\/?$/;

// FR-3 step 2b: the public intake page defaults to the case language when no cookie is set.
const getIntakeCaseLanguage = cache(async (): Promise<string | null> => {
  const match = INTAKE_PATH.exec((await headers()).get(PATH_HEADER) ?? "");
  if (!match) return null;
  try {
    return (await getCaseByToken(decodeURIComponent(match[1])))?.language ?? null;
  } catch (error) {
    console.error(`[i18n] Could not load intake case language: ${(error as Error).message}`);
    return null;
  }
});

/** The viewer's UI locale for this request. */
export const getLocale = cache(async (): Promise<Locale> => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;
  const profileLocale = (await getViewerPreferences())?.preferred_locale;
  if (isLocale(profileLocale)) return profileLocale;
  const caseLanguage = await getIntakeCaseLanguage();
  return resolveLocale({ caseLanguage, acceptLanguage: (await headers()).get("accept-language") });
});

/** The viewer's IANA time zone for this request (browser zone via the dnm_tz cookie; fallback Asia/Kolkata). */
export const getTimeZone = cache(async (): Promise<string> => {
  const cookie = (await cookies()).get(TIME_ZONE_COOKIE)?.value;
  if (isValidTimeZone(cookie)) return cookie;
  return resolveTimeZone({ profileTimeZone: (await getViewerPreferences())?.time_zone });
});

/** `t(key, values?)` for the viewer's locale. With a namespace, keys are relative: `getT("login")` -> `t("title")`. */
export async function getT<N extends Namespace | undefined = undefined>(namespace?: N): Promise<TFunction<N>> {
  const locale = await getLocale();
  return createTranslator(locale, getMessages(locale), namespace);
}

/** Date, time, number and INR formatters bound to the viewer's locale and time zone. */
export async function getFormatter(): Promise<Formatter> {
  return createFormatter(await getLocale(), await getTimeZone());
}
