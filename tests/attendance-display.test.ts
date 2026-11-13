// Ticket 044 pure helpers: outcome mapping, register counts, `Mark all remaining present` selection, the family's
// monthly line ("3 of 4 sessions attended"), the case calendar grid and the CSV export (formula cells neutralised),
// plus 047's billing_mode column and weekday numbering for 043 (extra scope).
import { describe, expect, it } from "vitest";
import {
  addMonths,
  attendanceCounts,
  attendanceCsv,
  canMarkNow,
  effectiveAttendance,
  familyAttendanceLabel,
  monthGrid,
  monthCounts,
  monthlyAttendance,
  monthOf,
  remainingToMark,
  withinMemberWindow,
} from "@/lib/booking/attendance-display";
import en from "@/messages/en.json";
import { createTranslator } from "@/lib/i18n/translate";
import { parseBillingMode, toSeriesWeekdays } from "@/lib/import/timetable";

const NOW = Date.parse("2026-11-20T06:30:00Z"); // 12:00 IST
const at = (iso: string) => new Date(iso).toISOString();

describe("attendance outcome and counts", () => {
  it("maps 030 statuses when the column is empty (legacy rows) and prefers the column", () => {
    expect(effectiveAttendance({ status: "completed", attendance: null })).toBe("present");
    expect(effectiveAttendance({ status: "no_show" })).toBe("absent");
    expect(effectiveAttendance({ status: "cancelled", attendance: "cancelled_centre" })).toBe("cancelled_centre");
    expect(effectiveAttendance({ status: "cancelled", attendance: null })).toBeNull();
    expect(effectiveAttendance({ status: "confirmed" })).toBeNull();
  });

  it("counts per outcome and the unmarked rest", () => {
    const counts = attendanceCounts([
      { status: "completed", attendance: "present" },
      { status: "completed", attendance: "present" },
      { status: "completed", attendance: "present" },
      { status: "no_show", attendance: "absent" },
      { status: "cancelled", attendance: "late_cancel_family" },
      { status: "confirmed", attendance: null },
    ]);
    expect(counts).toEqual({ present: 3, absent: 1, late_cancel_family: 1, cancelled_centre: 0, unmarked: 1, total: 6 });
  });

  it("FR-4 start rule and the member window", () => {
    const later = at("2026-11-20T08:00:00Z");
    expect(canMarkNow("present", later, NOW)).toBe(false);
    expect(canMarkNow("absent", later, NOW)).toBe(false);
    expect(canMarkNow("late_cancel_family", later, NOW)).toBe(true);
    expect(canMarkNow("cancelled_centre", later, NOW)).toBe(true);
    expect(canMarkNow("present", at("2026-11-20T06:30:00Z"), NOW)).toBe(true);
    expect(withinMemberWindow(at("2026-11-13T07:00:00Z"), NOW)).toBe(true);
    expect(withinMemberWindow(at("2026-11-13T06:00:00Z"), NOW)).toBe(false);
  });

  it("Mark all remaining present picks started, unmarked, confirmed sessions only", () => {
    const rows = [
      { id: "a", status: "confirmed", attendance: null, starts_at: at("2026-11-20T04:00:00Z") },
      { id: "b", status: "completed", attendance: "present", starts_at: at("2026-11-20T04:30:00Z") },
      { id: "c", status: "confirmed", attendance: null, starts_at: at("2026-11-20T09:00:00Z") },
      { id: "d", status: "cancelled", attendance: "cancelled_centre", starts_at: at("2026-11-20T05:00:00Z") },
    ];
    expect(remainingToMark(rows, NOW).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("family view (FR-7)", () => {
  const t = createTranslator("en", en, "attendance.family");

  it("labels past sessions Attended / Missed / Cancelled by centre", () => {
    expect(familyAttendanceLabel({ status: "completed", attendance: "present" })).toBe("attended");
    expect(familyAttendanceLabel({ status: "no_show", attendance: "absent" })).toBe("missed");
    expect(familyAttendanceLabel({ status: "cancelled", attendance: "cancelled_centre" })).toBe("cancelledByCentre");
    expect(familyAttendanceLabel({ status: "cancelled", attendance: "late_cancel_family" })).toBe("cancelledLate");
    expect(familyAttendanceLabel({ status: "cancelled", attendance: null })).toBeNull();
    expect(t("attended")).toBe("Attended");
    expect(t("missed")).toBe("Missed");
    expect(t("cancelledByCentre")).toBe("Cancelled by centre");
  });

  it("E-2: 3 present + 1 absent (+ a centre cancellation, not counted) -> '3 of 4 sessions attended in November'", () => {
    const child = { child_id: "c1", child_name: "Aarav (synthetic)" };
    const rows = [
      { status: "completed", attendance: "present", starts_at: at("2026-11-02T04:30:00Z"), ...child },
      { status: "completed", attendance: "present", starts_at: at("2026-11-04T04:30:00Z"), ...child },
      { status: "completed", attendance: "present", starts_at: at("2026-11-06T04:30:00Z"), ...child },
      { status: "no_show", attendance: "absent", starts_at: at("2026-11-09T04:30:00Z"), ...child },
      { status: "cancelled", attendance: "cancelled_centre", starts_at: at("2026-11-11T04:30:00Z"), ...child },
      { status: "confirmed", attendance: null, starts_at: at("2026-11-30T04:30:00Z"), ...child },
      { status: "completed", attendance: "present", starts_at: at("2026-10-30T04:30:00Z"), ...child },
    ];
    const lines = monthlyAttendance(rows, "Asia/Kolkata", ["2026-11"]);
    expect(lines).toEqual([{ month: "2026-11", childId: "c1", childName: "Aarav (synthetic)", attended: 3, total: 4 }]);
    expect(t("monthly", { attended: 3, count: 4, month: "November" })).toBe("3 of 4 sessions attended in November");
    expect(t("monthly", { attended: 1, count: 1, month: "November" })).toBe("1 of 1 session attended in November");
    // Month boundaries follow the viewer's zone: 30 Nov 20:00 UTC is already 1 December in IST.
    expect(monthOf("2026-11-30T20:00:00Z", "Asia/Kolkata")).toBe("2026-12");
    expect(monthOf("2026-11-30T20:00:00Z", "UTC")).toBe("2026-11");
  });
});

describe("case month (FR-6)", () => {
  it("Monday-first grid with every day once", () => {
    const weeks = monthGrid("2026-11"); // 1 Nov 2026 is a Sunday
    expect(weeks[0]).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(monthGrid("2027-02").flat().filter(Boolean)).toHaveLength(28);
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("counts attended / absent / cancelled; unmarked = started and not marked, future sessions are upcoming", () => {
    const rows = [
      { status: "completed", attendance: "present", starts_at: at("2026-11-02T04:30:00Z") },
      { status: "no_show", attendance: "absent", starts_at: at("2026-11-04T04:30:00Z") },
      { status: "cancelled", attendance: "late_cancel_family", starts_at: at("2026-11-05T04:30:00Z") },
      { status: "cancelled", attendance: "cancelled_centre", starts_at: at("2026-11-06T04:30:00Z") },
      { status: "confirmed", attendance: null, starts_at: at("2026-11-09T04:30:00Z") },
      { status: "confirmed", attendance: null, starts_at: at("2026-11-25T04:30:00Z") },
    ];
    expect(monthCounts(rows, NOW)).toEqual({ attended: 1, absent: 1, cancelled: 2, unmarked: 1, upcoming: 1 });
  });

  it("CSV: BOM, header, yes/no billable, quoted cells and neutralised formulas", () => {
    const csv = attendanceCsv([
      { date: "2026-11-02", time: "10:00", therapist: "Dr A, OT", service: "=HYPERLINK(\"x\")", attendance: "present", status: "completed", billable: true, marked_at: "2026-11-02T05:00:00.000Z" },
      { date: "2026-11-03", time: "10:00", therapist: "శ్రీజ", service: "Speech", attendance: null, status: "confirmed", billable: null, marked_at: null },
    ]);
    expect(csv.startsWith("\uFEFFdate,time,therapist,service,attendance,status,billable,marked_at\r\n")).toBe(true);
    const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[1]).toBe(`2026-11-02,10:00,"Dr A, OT","'=HYPERLINK(""x"")",present,completed,yes,2026-11-02T05:00:00.000Z`);
    expect(lines[2]).toBe("2026-11-03,10:00,శ్రీజ,Speech,not_marked,confirmed,,");
  });
});

describe("047 import timetable -> 043 series (extra scope)", () => {
  it("billing_mode column: package / per_session / free, empty = per_session", () => {
    expect(parseBillingMode("")).toBe("per_session");
    expect(parseBillingMode("Package")).toBe("package");
    expect(parseBillingMode("per session")).toBe("per_session");
    expect(parseBillingMode("per-session")).toBe("per_session");
    expect(parseBillingMode("FREE")).toBe("free");
    expect(parseBillingMode("monthly")).toBeNull();
  });

  it("047's Sunday-first days become 043's Monday-first days", () => {
    expect(toSeriesWeekdays([1, 3, 5])).toEqual([0, 2, 4]); // Mon, Wed, Fri
    expect(toSeriesWeekdays([0, 6])).toEqual([5, 6]); // Sun, Sat
  });
});
