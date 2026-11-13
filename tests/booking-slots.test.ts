// Ticket 030 FR-2: pure slot generation (rules, overrides, buffer, lead time, horizon, time zones).
import { describe, expect, it } from "vitest";
import { formatDate, formatTime } from "@/lib/i18n/format";
import { generateSlots, type SlotInput, type SlotOverride, type SlotRule } from "@/lib/booking/slots";
import { addDays, utcToWall, wallToUtc, weekdayOf } from "@/lib/booking/time";

const IST = "Asia/Kolkata";
const LOC = "loc-1";
const MONDAY = "2026-11-16";
const SUNDAY = "2026-11-15";

// Mon-Sat 10:00-13:00 IST at one clinic (the eval setup).
const monSat: SlotRule[] = [0, 1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start_time: "10:00:00",
  end_time: "13:00:00",
  mode: "in_clinic",
  location_id: LOC,
  valid_from: "2026-01-01",
  valid_to: null,
  time_zone: IST,
}));

const clinic30 = { mode: "in_clinic" as const, location_id: LOC, duration_min: 30, buffer_min: 0 };
const EARLY = new Date("2026-11-13T00:00:00Z");

function slots(partial: Partial<SlotInput> = {}) {
  return generateSlots({ service: clinic30, rules: monSat, overrides: [], busy: [], from: MONDAY, days: 1, now: EARLY, ...partial });
}

const startsIst = (list: { start: string }[]) => list.map((s) => formatTime(s.start, "en", IST));

describe("time helpers", () => {
  it("weekday 0 = Monday, wall <-> UTC round trip in IST", () => {
    expect(weekdayOf(MONDAY)).toBe(0);
    expect(weekdayOf(SUNDAY)).toBe(6);
    expect(wallToUtc(MONDAY, 10 * 60, IST)?.toISOString()).toBe("2026-11-16T04:30:00.000Z");
    expect(utcToWall(new Date("2026-11-16T04:30:00Z"), IST)).toEqual({ date: MONDAY, minutes: 600 });
    expect(wallToUtc(MONDAY, 1440, IST)?.toISOString()).toBe("2026-11-16T18:30:00.000Z");
  });

  it("returns null for a wall time inside a DST gap", () => {
    expect(wallToUtc("2026-03-08", 2 * 60 + 30, "America/New_York")).toBeNull();
  });
});

describe("generateSlots", () => {
  it("expands weekly rules in steps of the duration (UTC ISO strings)", () => {
    const out = slots();
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ start: "2026-11-16T04:30:00.000Z", end: "2026-11-16T05:00:00.000Z" });
    expect(out[5]).toEqual({ start: "2026-11-16T07:00:00.000Z", end: "2026-11-16T07:30:00.000Z" });
    expect(slots({ from: SUNDAY })).toEqual([]);
  });

  it("45-minute services fit whole slots into the window only", () => {
    const out = slots({ service: { ...clinic30, duration_min: 45 } });
    expect(startsIst(out)).toEqual(["10:00 am IST", "10:45 am IST", "11:30 am IST", "12:15 pm IST"]);
  });

  it("matches mode and location: another clinic's or a video-only rule gives nothing", () => {
    const other = monSat.map((r) => ({ ...r, location_id: "loc-2" }));
    const video = monSat.map((r) => ({ ...r, mode: "video" as const, location_id: null }));
    expect(slots({ rules: other })).toEqual([]);
    expect(slots({ rules: video })).toEqual([]);
    expect(slots({ rules: video, service: { ...clinic30, mode: "video", location_id: null } })).toHaveLength(6);
    const both = monSat.map((r) => ({ ...r, mode: "both" as const }));
    expect(slots({ rules: both, service: { ...clinic30, mode: "video", location_id: null } })).toHaveLength(6);
  });

  it("honours valid_from / valid_to", () => {
    expect(slots({ rules: monSat.map((r) => ({ ...r, valid_from: addDays(MONDAY, 1) })) })).toEqual([]);
    expect(slots({ rules: monSat.map((r) => ({ ...r, valid_to: addDays(MONDAY, -1) })) })).toEqual([]);
    expect(slots({ rules: monSat.map((r) => ({ ...r, valid_to: MONDAY })) })).toHaveLength(6);
  });

  it("a whole-day `unavailable` override removes the day", () => {
    const block: SlotOverride = { date: MONDAY, kind: "unavailable", start_time: null, end_time: null, mode: null, location_id: null, time_zone: IST };
    expect(slots({ overrides: [block] })).toEqual([]);
    // Another location's block does not apply.
    expect(slots({ overrides: [{ ...block, location_id: "loc-2" }] })).toHaveLength(6);
    // A video-only block does not apply to an in-clinic service.
    expect(slots({ overrides: [{ ...block, mode: "video" }] })).toHaveLength(6);
  });

  it("a partial `unavailable` override removes only overlapping slots", () => {
    const block: SlotOverride = { date: MONDAY, kind: "unavailable", start_time: "11:00:00", end_time: "12:00:00", mode: null, location_id: null, time_zone: IST };
    expect(startsIst(slots({ overrides: [block] }))).toEqual(["10:00 am IST", "10:30 am IST", "12:00 pm IST", "12:30 pm IST"]);
  });

  it("`extra` hours add slots on a day without rules", () => {
    const extra: SlotOverride = { date: SUNDAY, kind: "extra", start_time: "16:00:00", end_time: "17:00:00", mode: "in_clinic", location_id: LOC, time_zone: IST };
    expect(startsIst(slots({ from: SUNDAY, overrides: [extra] }))).toEqual(["4:00 pm IST", "4:30 pm IST"]);
    expect(slots({ from: SUNDAY, overrides: [{ ...extra, location_id: "loc-2" }] })).toEqual([]);
  });

  it("blocking appointments plus buffers remove colliding slots (both sides' buffers)", () => {
    const busy = [{ start: "2026-11-16T05:00:00Z", end: "2026-11-16T05:30:00Z", buffer_min: 10 }]; // 10:30-11:00 IST + 10
    expect(startsIst(slots({ busy }))).toEqual(["10:00 am IST", "11:30 am IST", "12:00 pm IST", "12:30 pm IST"]);
    // The candidate's own 15-minute buffer also keeps 10:00-10:30 (+15) away from 10:30.
    const own = slots({ busy: [{ ...busy[0], buffer_min: 0 }], service: { ...clinic30, buffer_min: 15 } });
    expect(startsIst(own)).toEqual(["11:00 am IST", "11:30 am IST", "12:00 pm IST", "12:30 pm IST"]);
    // Back-to-back without buffers is fine (half-open ranges).
    expect(startsIst(slots({ busy: [{ ...busy[0], buffer_min: 0 }] }))).toEqual(["10:00 am IST", "11:00 am IST", "11:30 am IST", "12:00 pm IST", "12:30 pm IST"]);
  });

  it("keeps a 2-hour lead time", () => {
    const now = new Date("2026-11-16T03:30:00Z"); // 09:00 IST
    expect(startsIst(slots({ now }))).toEqual(["11:00 am IST", "11:30 am IST", "12:00 pm IST", "12:30 pm IST"]);
  });

  it("stops at the 14-day horizon", () => {
    const now = new Date("2026-11-16T00:00:00Z"); // Monday 05:30 IST
    const out = slots({ now, from: MONDAY, days: 14, leadMinutes: 0 });
    const last = out[out.length - 1];
    expect(new Date(last.start).getTime()).toBeLessThan(now.getTime() + 14 * 86_400_000);
    // Day 14 (the next Monday after next) is excluded; day 13 (Sunday) has no rules; Saturday is the last day.
    expect(formatDate(last.start, "en", "short", IST)).toBe("28 Nov 2026");
    expect(out.some((s) => formatDate(s.start, "en", "short", IST) === "30 Nov 2026")).toBe(false);
  });

  it("renders IST across midnight UTC: an early-morning IST slot is the previous day in UTC", () => {
    const early = monSat.map((r) => ({ ...r, start_time: "00:00:00", end_time: "06:00:00" }));
    const out = slots({ rules: early, service: { ...clinic30, duration_min: 60 } });
    expect(out[0].start).toBe("2026-11-15T18:30:00.000Z"); // Sunday in UTC
    expect(formatDate(out[0].start, "en", "short", IST)).toBe("16 Nov 2026");
    expect(formatTime(out[0].start, "en", IST)).toBe("12:00 am IST");
    expect(out.map((s) => s.start.slice(0, 10))).toEqual(["2026-11-15", "2026-11-15", "2026-11-15", "2026-11-15", "2026-11-15", "2026-11-15"]);
    // A rule ending at 24:00 uses the last hour of the day.
    const late = generateSlots({ service: { ...clinic30, duration_min: 60 }, rules: monSat.map((r) => ({ ...r, start_time: "23:00:00", end_time: "24:00:00" })), overrides: [], busy: [], from: MONDAY, days: 1, now: EARLY });
    expect(late).toEqual([{ start: "2026-11-16T17:30:00.000Z", end: "2026-11-16T18:30:00.000Z" }]);
  });

  it("expands rules in the rule's own time zone, DST-safe (never the server's)", () => {
    const ny: SlotRule[] = [{ weekday: 0, start_time: "09:00", end_time: "10:00", mode: "video", location_id: null, valid_from: "2026-01-01", valid_to: null, time_zone: "America/New_York" }];
    const video = { mode: "video" as const, location_id: null, duration_min: 60, buffer_min: 0 };
    const run = (from: string) => generateSlots({ service: video, rules: ny, overrides: [], busy: [], from, days: 1, now: new Date("2026-02-01T00:00:00Z"), horizonDays: 60 });
    expect(run("2026-03-02")[0].start).toBe("2026-03-02T14:00:00.000Z"); // EST (UTC-5)
    expect(run("2026-03-09")[0].start).toBe("2026-03-09T13:00:00.000Z"); // EDT (UTC-4)
  });
});
