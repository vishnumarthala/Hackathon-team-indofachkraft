// Ticket 047 FR-1: optional timetable columns (`weekdays`, `time`, `service_name`). Parsing is pure. Creating the
// weekly series needs ticket 043 (`appointment_series` + `series_materialize`); until that is deployed the
// validated timetable is kept on the import row as `pending` and the screen says so (degrades gracefully).
import type { Queryable, Tx } from "@/lib/pg";

/** 0 = Sunday ... 6 = Saturday (043 FR-1), 1-4 days, time as HH:MM (24 h, the centre's local time). */
export type Timetable = { weekdays: number[]; time: string };

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
  weekdays: number[];
  time: string;
  createdBy: string;
};

/** Creates a weekly series for one imported child; returns its id, or null when it cannot (kept as `pending`). */
export type SeriesScheduler = {
  available(tx: Queryable): Promise<boolean>;
  create(tx: Tx, request: SeriesRequest): Promise<string | null>;
};

/** True when 043's table and materialiser exist in this database. */
export async function seriesTablesExist(tx: Queryable): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    select to_regclass('public.appointment_series') is not null
       and exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'series_materialize') as ok`;
  return Boolean(row?.ok);
}

/**
 * Default scheduler: follows 043 FR-1/FR-3/FR-4 (insert an `active` series starting today, then materialise
 * 8 weeks). Written against 043's spec, before 043 was merged; any failure (schema drift, a provider without a
 * profile, a clash) rolls back to a savepoint and leaves the timetable `pending`, so the import itself never fails.
 */
export const defaultSeriesScheduler: SeriesScheduler = {
  available: seriesTablesExist,
  async create(tx, req) {
    try {
      return await tx.savepoint(async (sp) => {
        const [profile] = await sp<{ id: string; time_zone: string }[]>`
          select id, time_zone from public.provider_profiles where user_id = ${req.therapistUserId}`;
        if (!profile) return null;
        const [series] = await sp<{ id: string }[]>`
          insert into public.appointment_series
            (org_id, provider_profile_id, service_id, child_id, case_id, weekdays, start_time, time_zone, starts_on,
             status, billing_mode, created_by)
          values (${req.orgId}, ${profile.id}, ${req.serviceId}, ${req.childId}, ${req.caseId},
                  ${req.weekdays}::smallint[], ${req.time}::time, ${profile.time_zone}, current_date,
                  'active', 'per_session', ${req.createdBy})
          returning id`;
        await sp`select public.series_materialize(${series.id}::uuid, (current_date + 56)::date)`;
        return series.id;
      });
    } catch {
      return null;
    }
  },
};
