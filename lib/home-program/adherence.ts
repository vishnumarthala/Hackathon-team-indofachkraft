// Ticket 026 FR-6: adherence maths for the home program. Pure and safe in the browser.
// Dates are ISO calendar dates (YYYY-MM-DD) as the guardian saw them. Weeks start on Monday in the guardian's time
// zone (018 `getTimeZone`): `weekStartFor(now, timeZone)` turns an instant into that Monday, so Sunday 23:30 IST and
// Monday 00:30 IST fall into different weeks even though both are Sunday in UTC.

export type AdherenceLog = { activity_id: string; done_on: string };
export type AdherenceActivity = { id: string; frequency_per_week: number };

export type Adherence = {
  /** Monday of the week (inclusive). */
  week_start: string;
  /** Sunday of the week (inclusive). */
  week_end: string;
  /** Logs of this activity in the week (one per guardian and day; two guardians can both log a day). */
  done: number;
  expected: number;
  /** done / expected in percent, rounded, capped at 100. */
  percent: number;
  met: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** `isoDate` plus `days` calendar days (negative to go back). */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar date of `now` in `timeZone` (YYYY-MM-DD). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Monday on or before `isoDate`. */
export function mondayOf(isoDate: string): string {
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((dow + 6) % 7));
}

/** Monday of the week containing `now` in `timeZone`. */
export function weekStartFor(now: Date, timeZone: string): string {
  return mondayOf(todayIn(timeZone, now));
}

function count(logs: AdherenceLog[], activityId: string, from: string, to: string): number {
  return logs.filter((l) => l.activity_id === activityId && l.done_on >= from && l.done_on <= to).length;
}

function summary(done: number, expected: number) {
  return { done, expected, percent: Math.min(100, Math.round((done / expected) * 100)), met: done >= expected };
}

/** FR-6: how often `activity` was done in the Monday-start week beginning `weekStart` (normalised to its Monday). */
export function adherence(logs: AdherenceLog[], activity: AdherenceActivity, weekStart: string): Adherence {
  const start = mondayOf(weekStart);
  const end = addDays(start, 6);
  return { week_start: start, week_end: end, ...summary(count(logs, activity.id, start, end), activity.frequency_per_week) };
}

/** Provider panel: `done <n> of <expected> times in the last 7 days` (today and the 6 days before). */
export function lastSevenDays(logs: AdherenceLog[], activity: AdherenceActivity, today: string) {
  const from = addDays(today, -6);
  return { from, to: today, ...summary(count(logs, activity.id, from, today), activity.frequency_per_week) };
}

/** The last `weeks` Monday-start weeks, oldest first, ending with the week of `today` (sparkline). */
export function weeklySeries(logs: AdherenceLog[], activity: AdherenceActivity, today: string, weeks = 4): Adherence[] {
  const current = mondayOf(today);
  return Array.from({ length: weeks }, (_, i) => adherence(logs, activity, addDays(current, -7 * (weeks - 1 - i))));
}
