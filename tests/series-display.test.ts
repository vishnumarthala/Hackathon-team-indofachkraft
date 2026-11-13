// Ticket 043 pure helpers: FR-7 summary line and week grouping, FR-9 viewer/clinic time zones and DST, FR-8 change
// templates (one message per change kind, no child data), and the request schemas.
import { describe, expect, it } from "vitest";
import { groupByWeek, occurrenceInstant, seriesSummary, weekdayList } from "@/lib/booking/series-display";
import { ConflictResolveSchema, SeriesChangeSchema, SeriesCreateSchema } from "@/lib/booking/series";
import { TEMPLATES } from "@/lib/notify/templates";

const ID = "33333333-3333-4333-8333-333333333333";

describe("series summary (FR-7, FR-9)", () => {
  const series = { weekdays: [0, 2, 4], start_time: "10:00", time_zone: "Asia/Kolkata", starts_on: "2026-11-16" };
  const now = new Date("2026-11-13T12:00:00Z");

  it("reads 'Mon, Wed, Fri' at the clinic time for a viewer in the clinic's zone", () => {
    const s = seriesSummary(series, "Asia/Kolkata", "en", now);
    expect(s.days).toBe("Mon, Wed, Fri");
    expect(s.time).toMatch(/^10:00\sam IST$/i);
    expect(s.clinicTime).toBeNull();
  });

  it("shows the viewer's own days and time, plus the clinic time, in another zone", () => {
    // 10:00 IST = 23:30 the previous day in New York (EST): Sun, Tue, Thu.
    const s = seriesSummary(series, "America/New_York", "en", now);
    expect(s.days).toBe("Tue, Thu, Sun");
    expect(s.time).toMatch(/^11:30\spm (EST|GMT-5)$/i);
    expect(s.clinicTime).toMatch(/^10:00\sam IST$/i);
  });

  it("translates weekday names (hi/te) without changing digits", () => {
    expect(weekdayList([0, 2], "hi")).toBe("सोम, बुध");
    expect(weekdayList([0, 2], "te")).toMatch(/^సోమ/);
  });

  it("keeps the local wall-clock time across a DST change in the clinic's zone", () => {
    expect(occurrenceInstant("2027-03-26", "10:00", "Europe/London").toISOString()).toBe("2027-03-26T10:00:00.000Z");
    expect(occurrenceInstant("2027-03-29", "10:00", "Europe/London").toISOString()).toBe("2027-03-29T09:00:00.000Z");
    // A wall time skipped by DST moves on by the gap instead of failing.
    expect(occurrenceInstant("2027-03-28", "01:30", "Europe/London").toISOString()).toBe("2027-03-28T01:30:00.000Z");
  });

  it("groups sessions by Monday-start week in the viewer's zone", () => {
    const weeks = groupByWeek(
      [
        { starts_at: "2026-11-25T04:30:00Z" },
        { starts_at: "2026-11-16T04:30:00Z" },
        { starts_at: "2026-11-23T04:30:00Z" },
        { starts_at: "2026-11-18T04:30:00Z" },
      ],
      "Asia/Kolkata",
    );
    expect(weeks.map((w) => [w.weekStart, w.items.length])).toEqual([
      ["2026-11-16", 2],
      ["2026-11-23", 2],
    ]);
  });
});

describe("series change templates (FR-8)", () => {
  const base = {
    series_id: ID,
    provider_name: "Dr Synthetic Rao",
    mode: "in_clinic" as const,
    time_zone: "Asia/Kolkata",
    weekdays: [0, 2],
    start_time: "11:00",
    starts_on: "2026-11-30",
    ends_on: null,
    location: "Synthetic Clinic",
  };
  const render = (payload: Record<string, unknown>, locale: "en" | "hi" | "te" = "en") =>
    TEMPLATES.series_changed.render({
      payload: { ...base, ...payload } as never,
      locale,
      role: "guardian",
      appUrl: "https://app.test",
      event: { id: "1", aggregate_type: "appointment_series", aggregate_id: ID },
    });

  it("says what changed, one sentence per change kind", () => {
    expect(render({ change: "time_changed", date: "2026-11-30" }).body).toBe(
      "From 30 November 2026, sessions with Dr Synthetic Rao are every Mon, Wed at 11:00 am IST. In clinic: Synthetic Clinic.",
    );
    expect(render({ change: "paused", date: "2026-12-07", until: "2026-12-13" }).body).toContain("paused from 7 December 2026 to 13 December 2026");
    expect(render({ change: "ended", date: "2027-01-31" }).body).toContain("end after 31 January 2027");
    expect(render({ change: "skipped", date: "2026-12-02" }).body).toContain("no session with Dr Synthetic Rao on 2 December 2026");
    expect(render({ change: "moved", date: "2026-12-02", new_start: "2026-12-02T06:30:00Z" }).body).toContain("moved to 2 Dec 2026, 12:00 pm IST");
    for (const change of ["time_changed", "paused", "ended", "skipped", "moved"]) {
      const out = render({ change, date: "2026-12-02", until: "2026-12-09", new_start: "2026-12-02T06:30:00Z" }, "te");
      expect(out.body).not.toContain("undefined");
      expect(out.link).toBe("/family/appointments");
    }
  });
});

describe("request schemas", () => {
  const ok = {
    case_id: ID,
    provider_profile_id: ID,
    service_id: ID,
    weekdays: [4, 0, 2],
    start_time: "10:00",
    starts_on: "2026-11-16",
    billing_mode: "per_session",
  };

  it("accepts 1-4 distinct weekdays (sorted) and defaults notify_family to true", () => {
    const parsed = SeriesCreateSchema.parse(ok);
    expect(parsed.weekdays).toEqual([0, 2, 4]);
    expect(parsed.notify_family).toBe(true);
  });

  it("rejects duplicate, too many or out-of-range weekdays, bad times and an end before the start", () => {
    for (const bad of [
      { weekdays: [0, 0] },
      { weekdays: [0, 1, 2, 3, 4] },
      { weekdays: [] },
      { weekdays: [7] },
      { start_time: "25:00" },
      { ends_on: "2026-11-01" },
      { billing_mode: "at_clinic" },
    ]) {
      expect(SeriesCreateSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("change: a new therapist needs their service; conflicts: skip or reschedule with a time", () => {
    expect(SeriesChangeSchema.safeParse({ from: "2026-11-30", start_time: "11:00" }).success).toBe(true);
    expect(SeriesChangeSchema.safeParse({ from: "2026-11-30", provider_profile_id: ID }).success).toBe(false);
    expect(ConflictResolveSchema.safeParse({ action: "skip" }).success).toBe(true);
    expect(ConflictResolveSchema.safeParse({ action: "reschedule" }).success).toBe(false);
    expect(ConflictResolveSchema.safeParse({ action: "reschedule", start: "2026-12-02T06:30:00Z" }).success).toBe(true);
  });
});
