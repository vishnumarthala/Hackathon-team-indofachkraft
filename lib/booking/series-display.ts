// Ticket 043 display helpers (pure; server pages, client components and notification templates). FR-9: times in the
// viewer's own zone, plus the clinic's when it differs; a series keeps its local wall-clock time in the clinic's zone.
import { clinicTimeIfDifferent } from "./display";
import { HTML_LANG, type Locale } from "@/lib/i18n/config";
import { formatTime } from "@/lib/i18n/format";
import { addDays, timeToMinutes, todayIn, utcToWall, wallToUtc, weekdayOf } from "./time";

/** `Mon` / `सोम` / `సోమ` for 0 = Monday ... 6 = Sunday. 2024-01-01 was a Monday. */
export function weekdayShort(day: number, locale: Locale): string {
  return new Intl.DateTimeFormat(HTML_LANG[locale], { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + day)));
}

export function weekdayList(days: number[], locale: Locale): string {
  return [...days].sort((a, b) => a - b).map((d) => weekdayShort(d, locale)).join(", ");
}

/** The instant of the series time on `date` in `timeZone` (a time skipped by DST moves on by the gap). */
export function occurrenceInstant(date: string, startTime: string, timeZone: string): Date {
  const minutes = timeToMinutes(startTime);
  return wallToUtc(date, minutes, timeZone) ?? wallToUtc(date, minutes + 60, timeZone) ?? new Date(`${date}T00:00:00Z`);
}

type SeriesLike = { weekdays: number[]; start_time: string; time_zone: string; starts_on: string };

/**
 * "Every Mon, Wed at 10:00 am IST" as seen by the viewer: the weekdays and time of the next occurrence of each series
 * weekday in the viewer's zone, and the clinic's own time when it differs (null otherwise).
 */
export function seriesSummary(series: SeriesLike, viewerTz: string, locale: Locale, now = new Date()): { days: string; time: string; clinicTime: string | null } {
  const from = [todayIn(series.time_zone, now), series.starts_on].sort()[1];
  const instants = series.weekdays.map((wd) => {
    const offset = (wd - weekdayOf(from) + 7) % 7;
    return occurrenceInstant(addDays(from, offset), series.start_time, series.time_zone);
  });
  instants.sort((a, b) => a.getTime() - b.getTime());
  const viewerDays = [...new Set(instants.map((i) => weekdayOf(utcToWall(i, viewerTz).date)))];
  const first = instants[0].toISOString();
  return {
    days: weekdayList(viewerDays, locale),
    time: formatTime(first, locale, viewerTz),
    clinicTime: clinicTimeIfDifferent(first, locale, viewerTz, series.time_zone),
  };
}

/** FR-7: occurrences grouped by week (Monday start, in the viewer's zone), in time order. */
export function groupByWeek<T extends { starts_at: string }>(items: T[], viewerTz: string): { weekStart: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))) {
    const date = utcToWall(Date.parse(item.starts_at), viewerTz).date;
    const weekStart = addDays(date, -weekdayOf(date));
    groups.set(weekStart, [...(groups.get(weekStart) ?? []), item]);
  }
  return [...groups].map(([weekStart, list]) => ({ weekStart, items: list }));
}
