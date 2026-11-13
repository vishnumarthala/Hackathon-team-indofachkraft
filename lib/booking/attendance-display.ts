// Ticket 044: pure attendance helpers (safe in client components and tests): the outcome of an appointment, register
// counts, the family's monthly line, the case calendar's month grid and the staff CSV export.
import { addDays, epochDay, weekdayOf } from "./time";

export const ATTENDANCE_VALUES = ["present", "absent", "late_cancel_family", "cancelled_centre"] as const;
export type Attendance = (typeof ATTENDANCE_VALUES)[number];

export function isAttendance(value: unknown): value is Attendance {
  return typeof value === "string" && (ATTENDANCE_VALUES as readonly string[]).includes(value);
}

/** Members mark and correct sessions of the last 7 days; older ones need an owner/admin (D-3). Mirrors attendance_mark. */
export const MEMBER_WINDOW_DAYS = 7;
/** FR-4: unmarked sessions this long after their start appear under `Needs attention`. */
export const NEEDS_ATTENTION_HOURS = 24;

/** The outcome of an appointment: its attendance, or the one implied by 030's status (completed / no-show). */
export function effectiveAttendance(a: { status: string; attendance?: string | null }): Attendance | null {
  if (isAttendance(a.attendance)) return a.attendance;
  if (a.status === "completed") return "present";
  if (a.status === "no_show") return "absent";
  return null;
}

/** Present / absent can be marked from the start time; the cancel types any time (FR-4). */
export function canMarkNow(attendance: Attendance, startsAt: string, now = Date.now()): boolean {
  return attendance === "late_cancel_family" || attendance === "cancelled_centre" || new Date(startsAt).getTime() <= now;
}

export function withinMemberWindow(startsAt: string, now = Date.now()): boolean {
  return new Date(startsAt).getTime() >= now - MEMBER_WINDOW_DAYS * 86_400_000;
}

export type AttendanceCounts = { present: number; absent: number; late_cancel_family: number; cancelled_centre: number; unmarked: number; total: number };

export function attendanceCounts(rows: { status: string; attendance?: string | null }[]): AttendanceCounts {
  const counts: AttendanceCounts = { present: 0, absent: 0, late_cancel_family: 0, cancelled_centre: 0, unmarked: 0, total: rows.length };
  for (const r of rows) {
    const a = effectiveAttendance(r);
    if (a) counts[a] += 1;
    else counts.unmarked += 1;
  }
  return counts;
}

/** `Mark all remaining present`: unmarked, confirmed sessions that have started. */
export function remainingToMark<T extends { status: string; attendance?: string | null; starts_at: string }>(rows: T[], now = Date.now()): T[] {
  return rows.filter((r) => r.status === "confirmed" && !effectiveAttendance(r) && new Date(r.starts_at).getTime() <= now);
}

/** Family label of a past session (FR-7), or null when there is nothing to say beyond 030's status. */
export type FamilyAttendanceLabel = "attended" | "missed" | "cancelledByCentre" | "cancelledLate";

export function familyAttendanceLabel(a: { status: string; attendance?: string | null }): FamilyAttendanceLabel | null {
  switch (effectiveAttendance(a)) {
    case "present":
      return "attended";
    case "absent":
      return "missed";
    case "cancelled_centre":
      return "cancelledByCentre";
    case "late_cancel_family":
      return "cancelledLate";
    default:
      return null;
  }
}

/**
 * FR-7 monthly line ("8 of 10 sessions attended in November") per child and month, newest month first. Sessions the
 * centre cancelled do not count; a late family cancellation counts as not attended. `month` = YYYY-MM in `timeZone`.
 */
export type MonthlyLine = { month: string; childId: string | null; childName: string | null; attended: number; total: number };

export function monthlyAttendance(
  rows: { status: string; attendance?: string | null; starts_at: string; child_id: string | null; child_name: string | null }[],
  timeZone: string,
  months: string[],
): MonthlyLine[] {
  const lines = new Map<string, MonthlyLine>();
  for (const r of rows) {
    const a = effectiveAttendance(r);
    if (!a || a === "cancelled_centre") continue;
    const month = monthOf(r.starts_at, timeZone);
    if (!months.includes(month)) continue;
    const key = `${month}|${r.child_id ?? ""}`;
    const line = lines.get(key) ?? { month, childId: r.child_id, childName: r.child_name, attended: 0, total: 0 };
    line.total += 1;
    if (a === "present") line.attended += 1;
    lines.set(key, line);
  }
  return [...lines.values()].sort((x, y) => y.month.localeCompare(x.month) || (x.childName ?? "").localeCompare(y.childName ?? ""));
}

/** YYYY-MM of an instant in `timeZone`. */
export function monthOf(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(instant));
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

export function isValidMonth(value: string | undefined | null): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 2100;
}

export function addMonths(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  return epochDay(`${addMonths(month, 1)}-01`) - epochDay(`${month}-01`);
}

/** Monday-first weeks of the month; days outside the month are null. */
export function monthGrid(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const days = daysInMonth(month);
  const cells: (string | null)[] = Array.from({ length: weekdayOf(first) }, () => null);
  for (let i = 0; i < days; i++) cells.push(addDays(first, i));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export type MonthCounts = { attended: number; absent: number; cancelled: number; unmarked: number; upcoming: number };

/** FR-6 counts: attended / absent / cancelled (late family + centre) / started but not marked / still to come. */
export function monthCounts(rows: { status: string; attendance?: string | null; starts_at: string }[], now = Date.now()): MonthCounts {
  const c = attendanceCounts(rows);
  const upcoming = rows.filter((r) => !effectiveAttendance(r) && new Date(r.starts_at).getTime() > now).length;
  return { attended: c.present, absent: c.absent, cancelled: c.late_cancel_family + c.cancelled_centre, unmarked: c.unmarked - upcoming, upcoming };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 cell; formula-looking cells are prefixed with `'` so spreadsheets never evaluate them. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type AttendanceCsvRow = {
  date: string;
  time: string;
  therapist: string;
  service: string;
  attendance: Attendance | null;
  status: string;
  billable: boolean | null;
  marked_at: string | null;
};

export const ATTENDANCE_CSV_HEADER = ["date", "time", "therapist", "service", "attendance", "status", "billable", "marked_at"] as const;

export function attendanceCsv(rows: AttendanceCsvRow[]): string {
  const lines = [ATTENDANCE_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [r.date, r.time, r.therapist, r.service, r.attendance ?? "not_marked", r.status, r.billable === null ? "" : r.billable ? "yes" : "no", r.marked_at]
        .map(csvCell)
        .join(","),
    );
  }
  // UTF-8 BOM so Excel shows Telugu/Hindi names (same as 047's template).
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
