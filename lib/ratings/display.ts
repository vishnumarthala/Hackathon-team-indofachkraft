// 036 FR-5 display rules (pure). The average appears only from DISPLAY_THRESHOLD published ratings (D-2); below that
// the profile says `New on DoctorNearMe`. Public comments show `Verified booking` and the month/year only.
import { HTML_LANG, type Locale } from "@/lib/i18n/config";
import { DISPLAY_THRESHOLD } from "./rules";

export type RatingSummary = { rating_avg: number | string | null; rating_count: number | null };

export type RatingBadge = { kind: "average"; average: string; count: number } | { kind: "new" };

export function ratingBadge(summary: RatingSummary | null | undefined): RatingBadge {
  const count = Number(summary?.rating_count ?? 0);
  const avg = summary?.rating_avg === null || summary?.rating_avg === undefined ? NaN : Number(summary.rating_avg);
  if (count < DISPLAY_THRESHOLD || Number.isNaN(avg)) return { kind: "new" };
  return { kind: "average", average: avg.toFixed(1), count };
}

/** `Nov 2026` in the viewer's locale and zone (no day, no time: comments must not identify a visit). */
export function monthYear(value: string | Date, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(HTML_LANG[locale], { month: "short", year: "numeric", timeZone, numberingSystem: "latn" }).format(new Date(value));
}
