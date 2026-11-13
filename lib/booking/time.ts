// Wall-clock <-> UTC conversion in an IANA time zone with Intl only (DST-safe, never the server's zone). Pure.
// A "wall index" is minutes since 1970-01-01 00:00 local time, so dates and times compare as numbers.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export type Wall = { date: string; minutes: number };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Days since 1970-01-01 for `YYYY-MM-DD`. */
export function epochDay(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

export function dateOfEpochDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateOfEpochDay(epochDay(date) + days);
}

/** 0 = Monday ... 6 = Sunday (the availability_rules convention). */
export function weekdayOf(date: string): number {
  return (new Date(epochDay(date) * 86_400_000).getUTCDay() + 6) % 7;
}

/** `HH:MM` or `HH:MM:SS` (Postgres `time`, `24:00` allowed) -> minutes since midnight. */
export function timeToMinutes(value: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) throw new Error(`Invalid time: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function wallParts(instant: number, timeZone: string) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** The local wall clock of an instant in `timeZone`. */
export function utcToWall(instant: Date | number, timeZone: string): Wall {
  const p = wallParts(new Date(instant).getTime(), timeZone);
  return {
    date: `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    minutes: p.hour * 60 + p.minute,
  };
}

export function wallIndex(wall: Wall): number {
  return epochDay(wall.date) * 1440 + wall.minutes;
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (IST = +330). */
export function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const p = wallParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/**
 * The instant at which the wall clock in `timeZone` shows `date` + `minutes` (minutes may be 1440 = next midnight).
 * Returns null for a wall time that does not exist (DST gap).
 */
export function wallToUtc(date: string, minutes: number, timeZone: string): Date | null {
  const naive = epochDay(date) * 86_400_000 + minutes * 60_000;
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const next = naive - zoneOffsetMinutes(guess, timeZone) * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return wallIndex(utcToWall(guess, timeZone)) === epochDay(date) * 1440 + minutes ? new Date(guess) : null;
}

/** Today's date in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return utcToWall(now, timeZone).date;
}

export function isValidTimeZoneName(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
