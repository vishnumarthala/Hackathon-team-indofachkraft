import { cookies } from "next/headers";
import { getAuthenticatedUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok } from "@/lib/http";
import {
  isLocale,
  isValidTimeZone,
  LOCALE_COOKIE,
  PREFERENCE_COOKIE_MAX_AGE,
  TIME_ZONE_COOKIE,
  type Locale,
} from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

const LOCALE_ERROR = "Choose English, Hindi or Telugu";
const TIME_ZONE_ERROR = "Use an IANA time zone such as Asia/Kolkata";

// Public (ticket 018, FR-8/FR-5a): sets the UI language and/or viewer time zone cookies and, for a
// signed-in user, saves them on their own profile. Not a clinical mutation, so no audit event.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Invalid request", { body: "Body must be JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "Invalid request", { body: "Body must be a JSON object" });
  }

  const { locale, time_zone: timeZone } = body as { locale?: unknown; time_zone?: unknown };
  const details: Record<string, string> = {};
  if ((locale !== undefined || timeZone === undefined) && !isLocale(locale)) details.locale = LOCALE_ERROR;
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) details.time_zone = TIME_ZONE_ERROR;
  if (Object.keys(details).length > 0) return fail(400, "Invalid request", details);

  const update: { preferred_locale?: Locale; time_zone?: string } = {};
  if (isLocale(locale)) update.preferred_locale = locale;
  if (typeof timeZone === "string") {
    // Canonical spelling, e.g. "asia/kolkata" -> "Asia/Kolkata".
    update.time_zone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
  }

  // Anonymous callers (no Supabase auth cookie) only get cookies; no auth round trip.
  const signedIn = (await cookies()).getAll().some((c) => c.name.startsWith("sb-"));
  const user = signedIn ? await getAuthenticatedUser() : null;
  if (user) {
    const { error } = await supabaseAdmin().from("user_profiles").update(update).eq("id", user.id);
    if (error) return fail(500, "Could not save your preference");
  }

  const response = ok({
    ...(update.preferred_locale ? { locale: update.preferred_locale } : {}),
    ...(update.time_zone ? { time_zone: update.time_zone } : {}),
  });
  const options = {
    path: "/",
    sameSite: "lax" as const,
    maxAge: PREFERENCE_COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  };
  if (update.preferred_locale) response.cookies.set(LOCALE_COOKIE, update.preferred_locale, options);
  if (update.time_zone) response.cookies.set(TIME_ZONE_COOKIE, update.time_zone, options);
  return response;
}
