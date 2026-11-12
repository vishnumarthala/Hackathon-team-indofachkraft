// i18n configuration shared by server and client code (ticket 018). No Node or Next imports here.

export const LOCALES = ["en", "hi", "te"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Each language in its own script, for the language switcher. */
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", hi: "हिन्दी", te: "తెలుగు" };

/** BCP 47 tags for `<html lang>` and every `Intl` formatter. */
export const HTML_LANG: Record<Locale, string> = { en: "en-IN", hi: "hi-IN", te: "te-IN" };

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export const LOCALE_COOKIE = "dnm_locale";
export const TIME_ZONE_COOKIE = "dnm_tz";
/** One year, in seconds. */
export const PREFERENCE_COOKIE_MAX_AGE = 31_536_000;

/** Request header set by proxy.ts with the request pathname (client-supplied values are overwritten). */
export const PATH_HEADER = "x-dnm-path";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** True for an IANA time zone the runtime knows (e.g. `Asia/Kolkata`). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * First supported language in an `Accept-Language` header, by q-value then order:
 * `hi*` -> hi, `te*` -> te, `en*` -> en. Returns null when nothing matches.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.tag && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}
