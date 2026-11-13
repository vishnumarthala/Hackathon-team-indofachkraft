import { CancelAppointmentButton } from "@/components/booking/AppointmentActions";
import { ConflictActions, MoveSessionForm, NewSeriesForm, SeriesActions } from "@/components/series/SeriesForms";
import { clinicTimeIfDifferent } from "@/lib/booking/display";
import { listCaseSeries, seriesFormOptions, type ConflictRow } from "@/lib/booking/series";
import { seriesSummary } from "@/lib/booking/series-display";
import { minutesToTime, todayIn, utcToWall } from "@/lib/booking/time";
import { formatDate } from "@/lib/i18n/format";
import { getFormatter, getT } from "@/lib/i18n/server";

/** Next sessions listed openly per series; the rest of the 8 weeks sit behind `Show all`. */
const VISIBLE_SESSIONS = 6;
const STATUS_STYLE = { active: "bg-teal-50 text-teal-900", paused: "bg-amber-50 text-amber-900", ended: "bg-slate-100 text-slate-700" } as const;

/** Clinic-clock date and HH:MM of an instant (form defaults for Move / Pick another time). */
function clinicWall(iso: string, timeZone: string) {
  const wall = utcToWall(Date.parse(iso), timeZone);
  return { date: wall.date, time: minutesToTime(wall.minutes) };
}

/** FR-6 Conflicts rows (case Timetable card and /dashboard/schedule). */
export async function ConflictList({ conflicts, showCase = false }: { conflicts: ConflictRow[]; showCase?: boolean }) {
  const t = await getT("series.conflicts");
  const format = await getFormatter();
  if (conflicts.length === 0) return <p className="text-sm text-slate-600">{t("none")}</p>;
  return (
    <ul className="space-y-2" data-testid="series-conflicts">
      {conflicts.map((c) => {
        const wall = clinicWall(c.usual_start, c.time_zone);
        return (
          <li key={c.id} className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="font-semibold text-slate-900">
              {formatDate(`${c.occurrence_date}T12:00:00Z`, format.locale, "long", "UTC")} · {format.time(c.usual_start)}
            </p>
            <p className="text-slate-800">
              {[t(`reasons.${c.reason}`), c.provider_name, c.service_name, showCase ? c.child_name : null].filter(Boolean).join(" · ")}
              {showCase && c.case_id ? (
                <>
                  {" · "}
                  <a href={`/cases/${c.case_id}`} className="font-semibold text-teal-800 underline">{t("openCase")}</a>
                </>
              ) : null}
            </p>
            <ConflictActions conflictId={c.id} date={wall.date} time={wall.time} timeZone={c.time_zone} />
          </li>
        );
      })}
    </ul>
  );
}

// 043 FR-6: the case page's `Timetable` card - the child's weekly series with their next sessions ("This session only":
// Move / Cancel), series actions ("This and future sessions", Pause, End), open conflicts, and the new-series form.
// Only staff who may manage a series (org owner/admin, or the therapist bound to the profile) get its actions.
export async function TimetableCard({ caseId, userId }: { caseId: string; userId: string }) {
  const t = await getT("series.timetable");
  const tc = await getT("series.conflicts");
  const tb = await getT("booking");
  const format = await getFormatter();
  const [options, series] = await Promise.all([seriesFormOptions(caseId, userId), listCaseSeries(caseId, userId)]);
  if (!options) return null;
  const zone = options.timeZone;
  const today = todayIn(zone);
  // Dates (no time) are calendar days: formatted at noon UTC so no viewer zone shifts them.
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, format.locale, "long", "UTC");

  return (
    <section aria-labelledby="timetable" className="space-y-4 rounded border border-slate-200 bg-white p-4" data-testid="timetable-card">
      <div className="space-y-1">
        <h2 id="timetable" className="text-lg font-semibold text-slate-900">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>
      {series.length === 0 ? <p className="text-sm text-slate-600">{t("none")}</p> : null}
      <ul className="space-y-4">
        {series.map((s) => {
          const summary = seriesSummary(s, format.timeZone, format.locale);
          const row = (o: (typeof s.upcoming)[number]) => {
            const wall = clinicWall(o.starts_at, s.time_zone);
            const clinic = clinicTimeIfDifferent(o.starts_at, format.locale, format.timeZone, s.time_zone);
            return (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-slate-900">
                  {format.dateTime(o.starts_at)}
                  {clinic ? <span className="text-slate-600"> · {tb("clinicTime", { time: clinic })}</span> : null}
                  {o.occurrence_date === null ? (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{t("moved")}</span>
                  ) : null}
                </span>
                {s.can_manage ? (
                  <span className="flex flex-wrap items-center gap-2" role="group" aria-label={t("thisSession")}>
                    <MoveSessionForm appointmentId={o.id} date={wall.date} time={wall.time} timeZone={s.time_zone} />
                    <CancelAppointmentButton appointmentId={o.id} side="provider" />
                  </span>
                ) : null}
              </li>
            );
          };
          return (
            <li key={s.id} className="space-y-3 rounded border border-slate-200 p-3" data-testid="series-item">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">
                    {t("every", { days: summary.days, time: summary.time })} {t("with", { therapist: s.provider_name })}
                  </p>
                  {summary.clinicTime ? <p className="text-sm text-slate-600">{tb("clinicTime", { time: summary.clinicTime })}</p> : null}
                  <p className="text-sm text-slate-700">
                    {[
                      s.service_name,
                      s.mode === "video" ? tb("modes.video") : [tb("modes.in_clinic"), s.location_name].filter(Boolean).join(" · "),
                      t("billingLabel", { mode: t(`billingModes.${s.billing_mode}`) }),
                    ].join(" · ")}
                  </p>
                  <p className="text-sm text-slate-700">
                    {[t("fromDate", { date: day(s.starts_on) }), s.ends_on ? t("endsOnLabel", { date: day(s.ends_on) }) : null].filter(Boolean).join(" · ")}
                  </p>
                  {s.paused_from && s.paused_until && s.paused_until >= today ? (
                    <p className="text-sm text-amber-900">{t("pausedRange", { from: day(s.paused_from), to: day(s.paused_until) })}</p>
                  ) : null}
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLE[s.status]}`}>{t(`status.${s.status}`)}</span>
              </div>

              {s.status !== "ended" ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-800">{t("upcoming")}</h3>
                  {s.upcoming.length === 0 ? (
                    <p className="text-sm text-slate-600">{t("noUpcoming")}</p>
                  ) : (
                    <>
                      <ul className="divide-y divide-slate-100 text-sm" data-testid="series-occurrences">
                        {s.upcoming.slice(0, VISIBLE_SESSIONS).map(row)}
                      </ul>
                      {s.upcoming.length > VISIBLE_SESSIONS ? (
                        <details className="text-sm">
                          <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-teal-800 underline">
                            {t("showAll", { count: s.upcoming.length })}
                          </summary>
                          <ul className="divide-y divide-slate-100">{s.upcoming.slice(VISIBLE_SESSIONS).map(row)}</ul>
                        </details>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {s.conflicts.length ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-slate-800">{tc("title")}</h3>
                  <p className="text-sm text-slate-700">{tc("intro")}</p>
                  {s.can_manage ? (
                    <ConflictList conflicts={s.conflicts} />
                  ) : (
                    <ul className="text-sm text-slate-800">
                      {s.conflicts.map((c) => (
                        <li key={c.id}>{day(c.occurrence_date)} · {tc(`reasons.${c.reason}`)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {s.can_manage && s.status !== "ended" ? (
                <SeriesActions
                  seriesId={s.id}
                  therapists={options.therapists}
                  current={{ profile_id: s.provider_profile_id, service_id: s.service_id, weekdays: s.weekdays, start_time: s.start_time }}
                  today={todayIn(s.time_zone)}
                  timeZone={s.time_zone}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {options.therapists.length ? (
        <NewSeriesForm caseId={caseId} therapists={options.therapists} hasGuardian={options.hasGuardian} today={today} timeZone={zone} />
      ) : (
        <p className="text-sm text-slate-600">{t("noTherapists")}</p>
      )}
    </section>
  );
}
