// FR-2 slot generation (pure, no I/O). Mirrors the SQL check `booking_slot_valid` + `booking_conflicts`
// (supabase/migrations/20261113003000_booking.sql); tests/booking-state-machine.test.ts checks that every generated
// slot is accepted by the database.
//
// For each local date in the window: weekly rules (weekday, validity, mode/location) and `extra` overrides give
// windows; candidates step by the service duration from the window start; a candidate must end inside the window,
// must not touch an `unavailable` override, must start at least LEAD_MINUTES from now and before the horizon, and must
// not collide with a blocking appointment (each side's buffer added after its end). Rules and overrides are expanded
// in their own time zone (location, else the provider profile), never the server's. Output: UTC ISO strings.
import { addDays, epochDay, timeToMinutes, utcToWall, wallIndex, wallToUtc, weekdayOf } from "./time";

export const LEAD_MINUTES = 120;
export const HORIZON_DAYS = 14;
export const HOLD_MINUTES = 10;
export const PAYMENT_HOLD_MINUTES = 15;
export const GUARDIAN_CANCEL_WINDOW_MINUTES = 120;

export type ServiceMode = "in_clinic" | "video";
export type RuleMode = ServiceMode | "both";

export type SlotService = {
  mode: ServiceMode;
  location_id: string | null;
  duration_min: number;
  buffer_min: number;
};

export type SlotRule = {
  weekday: number;
  start_time: string;
  end_time: string;
  mode: RuleMode;
  location_id: string | null;
  valid_from: string;
  valid_to: string | null;
  /** The location's time zone, or the provider profile's for location-less (video) rules. */
  time_zone: string;
};

export type SlotOverride = {
  date: string;
  kind: "unavailable" | "extra";
  start_time: string | null;
  end_time: string | null;
  mode: RuleMode | null;
  location_id: string | null;
  time_zone: string;
};

/** A blocking appointment (confirmed, or held / pending payment with an unexpired hold). */
export type BusyRange = { start: string; end: string; buffer_min: number };

export type Slot = { start: string; end: string };

export type SlotInput = {
  service: SlotService;
  rules: SlotRule[];
  overrides: SlotOverride[];
  busy: BusyRange[];
  /** First local date (`YYYY-MM-DD`). */
  from: string;
  days: number;
  now: Date;
  leadMinutes?: number;
  horizonDays?: number;
};

function modeMatches(service: SlotService, mode: RuleMode | null, locationId: string | null): boolean {
  const m = mode ?? "both";
  if (service.mode === "in_clinic") return (m === "in_clinic" || m === "both") && locationId === service.location_id;
  return m === "video" || m === "both";
}

type Window = { date: string; start: number; end: number; timeZone: string };

function windowsFor(input: SlotInput): Window[] {
  const out: Window[] = [];
  for (let i = 0; i < input.days; i++) {
    const date = addDays(input.from, i);
    for (const r of input.rules) {
      if (!modeMatches(input.service, r.mode, r.location_id)) continue;
      if (weekdayOf(date) !== r.weekday) continue;
      if (date < r.valid_from || (r.valid_to !== null && date > r.valid_to)) continue;
      out.push({ date, start: timeToMinutes(r.start_time), end: timeToMinutes(r.end_time), timeZone: r.time_zone });
    }
    for (const o of input.overrides) {
      if (o.kind !== "extra" || o.date !== date || !o.start_time || !o.end_time) continue;
      if (!modeMatches(input.service, o.mode, o.location_id)) continue;
      out.push({ date, start: timeToMinutes(o.start_time), end: timeToMinutes(o.end_time), timeZone: o.time_zone });
    }
  }
  return out;
}

function blockedByOverride(input: SlotInput, start: Date, end: Date): boolean {
  for (const o of input.overrides) {
    if (o.kind !== "unavailable") continue;
    if (o.location_id !== null && o.location_id !== input.service.location_id) continue;
    if (o.mode !== null && o.mode !== "both" && o.mode !== input.service.mode) continue;
    const day = epochDay(o.date) * 1440;
    const blockStart = day + (o.start_time ? timeToMinutes(o.start_time) : 0);
    const blockEnd = day + (o.end_time ? timeToMinutes(o.end_time) : 1440);
    const s = wallIndex(utcToWall(start, o.time_zone));
    const e = wallIndex(utcToWall(end, o.time_zone));
    if (s < blockEnd && blockStart < e) return true;
  }
  return false;
}

function busyConflict(input: SlotInput, start: number, end: number): boolean {
  const ownBuffer = input.service.buffer_min * 60_000;
  return input.busy.some((b) => {
    const bs = Date.parse(b.start);
    const be = Date.parse(b.end) + b.buffer_min * 60_000;
    return start < be && bs < end + ownBuffer;
  });
}

export function generateSlots(input: SlotInput): Slot[] {
  const duration = input.service.duration_min;
  const earliest = input.now.getTime() + (input.leadMinutes ?? LEAD_MINUTES) * 60_000;
  const latest = input.now.getTime() + (input.horizonDays ?? HORIZON_DAYS) * 86_400_000;
  const seen = new Map<number, Slot>();

  for (const w of windowsFor(input)) {
    const windowEnd = epochDay(w.date) * 1440 + w.end;
    for (let m = w.start; m + duration <= w.end; m += duration) {
      const start = wallToUtc(w.date, m, w.timeZone);
      if (!start) continue; // DST gap
      const startMs = start.getTime();
      const endMs = startMs + duration * 60_000;
      if (wallIndex(utcToWall(endMs, w.timeZone)) > windowEnd) continue;
      if (startMs < earliest || startMs >= latest || seen.has(startMs)) continue;
      const end = new Date(endMs);
      if (blockedByOverride(input, start, end)) continue;
      if (busyConflict(input, startMs, endMs)) continue;
      seen.set(startMs, { start: start.toISOString(), end: end.toISOString() });
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot);
}
