// 044 extra scope (047 + 043): creating the weekly series of imported timetables. Server only.
//   * `defaultSeriesScheduler`: used by the import itself (lib/import/store.ts runImport), inside its transaction;
//   * `schedulePendingTimetables`: one-off, idempotent catch-up for timetables still `pending` (imports made before 043
//     was deployed, or rows whose series could not be created then). Called by the import page's
//     `Schedule saved timetables` button (owner/admin) and by `npm run import:schedule-pending`.
// Both run under the per-organisation import lock (`child_import:<org>`), the same one the import and its undo take.
import { auditStrict } from "@/lib/audit";
import { createSeries } from "@/lib/booking/series";
import { errorMessage, logger } from "@/lib/log";
import { pg, type Queryable } from "@/lib/pg";
import { toSeriesWeekdays, type ImportBillingMode, type SeriesScheduler } from "./timetable";

if (typeof window !== "undefined") {
  throw new Error("lib/import/schedule.ts is server-only");
}

const log = logger("import-schedule");

/** True when 043's table and materialiser exist in this database. */
export async function seriesTablesExist(tx: Queryable): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    select to_regclass('public.appointment_series') is not null
       and exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'series_materialize') as ok`;
  return Boolean(row?.ok);
}

/**
 * 043's `createSeries` inside the caller's transaction, in a savepoint. The series uses the therapist's own provider
 * profile and the row's service (that profile's active in-clinic/video service in the organisation), starts today in
 * the clinic's time zone, has no family account (imported children are unclaimed: nothing is messaged, 047 NFR-2) and
 * is materialized 8 weeks ahead; clashes become 043 conflicts. Any refusal (no profile, a demo profile, someone else's
 * service, an actor who is no longer owner/admin, ...) rolls back to the savepoint and returns null (`pending`).
 */
export const defaultSeriesScheduler: SeriesScheduler = {
  available: seriesTablesExist,
  async create(tx, req) {
    try {
      return await tx.savepoint(async (sp) => {
        const [svc] = await sp<{ profile_id: string; today: string }[]>`
          select p.id as profile_id, (now() at time zone coalesce(l.time_zone, p.time_zone))::date::text as today
          from public.services s
          join public.provider_profiles p on p.id = s.provider_profile_id
          left join public.practice_locations l on l.id = s.location_id
          where s.id = ${req.serviceId} and s.org_id = ${req.orgId} and p.user_id = ${req.therapistUserId}`;
        if (!svc) return null;
        const result = await createSeries(
          {
            actorUserId: req.createdBy,
            orgId: req.orgId,
            caseId: req.caseId,
            childId: req.childId,
            profileId: svc.profile_id,
            serviceId: req.serviceId,
            weekdays: toSeriesWeekdays(req.weekdays),
            startTime: req.time,
            startsOn: svc.today,
            endsOn: null,
            billingMode: req.billingMode,
            guardian: null,
          },
          sp,
        );
        return result.series_id;
      });
    } catch (err) {
      log.info("timetable kept pending", { error: errorMessage(err) });
      return null;
    }
  },
};

export type ScheduleOutcome = { imports: number; scheduled: number; pending: number };

type PendingRow = {
  row_number: number;
  child_id: string;
  case_id: string;
  therapist_user_id: string | null;
  timetable: { weekdays: number[]; time: string; service_id: string; billing_mode?: ImportBillingMode };
};

/**
 * Creates the series of `pending` timetables. `importId` = one import (the button; `actorUserId` is the clicking
 * owner/admin); neither = every import (the script; the actor is each import's creator while still owner/admin).
 * Idempotent: scheduled rows are never touched again and concurrent runs queue on the organisation's import lock.
 */
export async function schedulePendingTimetables(
  opts: { importId?: string; orgId?: string; actorUserId?: string | null; scheduler?: SeriesScheduler } = {},
): Promise<ScheduleOutcome> {
  const scheduler = opts.scheduler ?? defaultSeriesScheduler;
  const sql = await pg();
  const imports = await sql<{ id: string; org_id: string; created_by: string | null }[]>`
    select i.id, i.org_id, i.created_by from public.child_imports i
    where i.undone_at is null
      and exists (select 1 from public.child_import_rows r where r.import_id = i.id and r.timetable_status = 'pending')
      ${opts.importId ? sql`and i.id = ${opts.importId}` : sql``}
      ${opts.orgId ? sql`and i.org_id = ${opts.orgId}` : sql``}
    order by i.created_at`;
  const total: ScheduleOutcome = { imports: 0, scheduled: 0, pending: 0 };
  for (const imp of imports) {
    const actor = opts.actorUserId ?? imp.created_by;
    if (!actor) continue;
    const outcome = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`child_import:${imp.org_id}`}, 0))`;
      const [live] = await tx<{ undone: boolean }[]>`select undone_at is not null as undone from public.child_imports where id = ${imp.id} for update`;
      if (!live || live.undone || !(await scheduler.available(tx))) return null;
      const rows = await tx<PendingRow[]>`
        select row_number, child_id, case_id, therapist_user_id, timetable from public.child_import_rows
        where import_id = ${imp.id} and timetable_status = 'pending' order by row_number for update`;
      let scheduled = 0;
      for (const r of rows) {
        if (!r.therapist_user_id || !r.timetable?.service_id) continue;
        const seriesId = await scheduler.create(tx, {
          orgId: imp.org_id,
          childId: r.child_id,
          caseId: r.case_id,
          therapistUserId: r.therapist_user_id,
          serviceId: r.timetable.service_id,
          weekdays: r.timetable.weekdays,
          time: r.timetable.time,
          billingMode: r.timetable.billing_mode ?? "per_session",
          createdBy: actor,
        });
        if (!seriesId) continue;
        scheduled += 1;
        await tx`update public.child_import_rows set timetable_status = 'scheduled', series_id = ${seriesId}
                 where import_id = ${imp.id} and row_number = ${r.row_number}`;
      }
      const [counts] = await tx<{ pending: number }[]>`
        update public.child_imports
        set timetable_pending_count = (select count(*) from public.child_import_rows where import_id = ${imp.id} and timetable_status = 'pending'),
            series_created_count = series_created_count + ${scheduled}
        where id = ${imp.id}
        returning timetable_pending_count as pending`;
      if (scheduled > 0) {
        await auditStrict(
          {
            actorUserId: actor,
            actorRole: "provider",
            orgId: imp.org_id,
            action: "children.import_timetables_scheduled",
            entity: "child_import",
            entityId: imp.id,
            details: { import_id: imp.id, series_created: scheduled, timetable_pending: counts.pending },
          },
          tx,
        );
      }
      return { scheduled, pending: counts.pending };
    });
    if (!outcome) continue;
    total.imports += 1;
    total.scheduled += outcome.scheduled;
    total.pending += outcome.pending;
  }
  return total;
}
