// Ticket 047 FR-1: optional timetable columns (`weekdays`, `time`, `service_name`, and since 044 `billing_mode`).
// Parsing is pure. The weekly series is created with 043's `createSeries` (044 extra scope); a timetable that cannot be
// scheduled (no provider profile, a demo profile, a service of another therapist, 043 not deployed) is kept on the
// import row as `pending` and can be scheduled later. Client-safe: the database side is in lib/import/schedule.ts.
import type { Queryable, Tx } from "@/lib/pg";

/** 043's `appointment_series.billing_mode` values (kept here so this file stays client-safe). */
export const IMPORT_BILLING_MODES = ["package", "per_session", "free"] as const;
export type ImportBillingMode = (typeof IMPORT_BILLING_MODES)[number];

/**
 * 0 = Sunday ... 6 = Saturday as stored on 047's import rows (043's spec draft), 1-4 days, time as HH:MM (24 h, the
 * centre's local time). 043 itself counts 0 = Monday: convert with `toSeriesWeekdays`.
 */
export type Timetable = { weekdays: number[]; time: string };

/** 047's Sunday-first day numbers -> 043's Monday-first ones (sorted). */
export function toSeriesWeekdays(days: number[]): number[] {
  return [...new Set(days.map((d) => (d + 6) % 7))].sort((a, b) => a - b);
}

/** `billing_mode` column: empty = per_session (043's default for the import); also "per session" / "per-session". */
export function parseBillingMode(value: string): ImportBillingMode | null {
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "") return "per_session";
  return (IMPORT_BILLING_MODES as readonly string[]).includes(v) ? (v as ImportBillingMode) : null;
}

export const MAX_WEEKDAYS = 4;

const DAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** `Mon;Wed;Fri` (also commas, slashes, spaces, full names). Sorted unique days, or null. */
export function parseWeekdays(value: string): number[] | null {
  const tokens = value.toLowerCase().split(/[;,/\s]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const days = new Set<number>();
  for (const token of tokens) {
    const day = DAYS[token.replace(/\.$/, "")];
    if (day === undefined) return null;
    days.add(day);
  }
  if (days.size > MAX_WEEKDAYS) return null;
  return [...days].sort((a, b) => a - b);
}

/** `10:00`, `16:30`, `4:30 pm`, `10am`, `10.30`. HH:MM or null. */
export function parseTime(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, "");
  const match = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(v);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (match[2] === undefined && !meridiem) return null;
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  } else if (hours > 23) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatWeekdays(days: number[]): string {
  return days.map((d) => WEEKDAY_SHORT[d] ?? "?").join(", ");
}

// ---------- series (043) ----------

export type SeriesRequest = {
  orgId: string;
  childId: string;
  caseId: string;
  therapistUserId: string;
  serviceId: string;
  /** 047 numbering (0 = Sunday). */
  weekdays: number[];
  time: string;
  billingMode: ImportBillingMode;
  createdBy: string;
};

/** Creates a weekly series for one imported child; returns its id, or null when it cannot (kept as `pending`). */
export type SeriesScheduler = {
  available(tx: Queryable): Promise<boolean>;
  create(tx: Tx, request: SeriesRequest): Promise<string | null>;
};
