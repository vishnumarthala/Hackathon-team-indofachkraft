import Link from "next/link";
import { CancelAppointmentButton } from "@/components/booking/AppointmentActions";
import { MeetPanel } from "@/components/google/MeetPanel";
import { requireGuardianPage } from "@/lib/authz";
import { clinicTimeIfDifferent, guardianCanChange, splitAppointments } from "@/lib/booking/display";
import { listGuardianSeries } from "@/lib/booking/series";
import { groupByWeek, seriesSummary } from "@/lib/booking/series-display";
import { GUARDIAN_CANCEL_WINDOW_MINUTES } from "@/lib/booking/slots";
import { listGuardianAppointments, type AppointmentView } from "@/lib/booking/store";
import { getMeetInfo } from "@/lib/google/meet";
import { formatDate } from "@/lib/i18n/format";
import { getFormatter, getT } from "@/lib/i18n/server";
import { guardianIntakeNotices, type GuardianIntakeNotice } from "@/lib/intake/attempts";
import { PAYMENT_LABEL_STYLE, paymentHoldOpen, paymentLabel } from "@/lib/payments/display";
import { listPaymentsForAppointments } from "@/lib/payments/store";
import { listGuardianRatings, listRateableAppointmentIds } from "@/lib/ratings/store";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<string, string> = {
  confirmed: "bg-teal-50 text-teal-900",
  pending_payment: "bg-amber-50 text-amber-900",
  cancelled: "bg-slate-100 text-slate-700",
  completed: "bg-slate-100 text-slate-700",
  no_show: "bg-slate-100 text-slate-700",
};

// FR-7 `/family/appointments`: the guardian's own bookings, upcoming and past, with Cancel / Reschedule (up to 2 h
// before the start) and Add to calendar (.ics). Times in the viewer's zone, plus the clinic's when it differs (NFR-2).
export default async function FamilyAppointmentsPage({ searchParams }: { searchParams: Promise<{ moved?: string }> }) {
  const { user } = await requireGuardianPage();
  const t = await getT("booking");
  const format = await getFormatter();
  const { moved } = await searchParams;
  const all = await listGuardianAppointments(user.id);
  // 031 FR-8: payment status next to the appointment status.
  const tp = await getT("payments");
  const payments = await listPaymentsForAppointments(all.map((a) => a.id));
  const split = splitAppointments(all);
  // 043 FR-7: weekly series get their own section (sessions grouped by week); cancellations made by a series change
  // (one message to the family already explained them) are not listed one by one.
  const ts = await getT("series.family");
  const series = await listGuardianSeries(user.id);
  const seriesIds = new Set(series.map((s) => s.id));
  const inSeries = (a: AppointmentView) => Boolean(a.series_id && seriesIds.has(a.series_id));
  const upcoming = split.upcoming.filter((a) => !inSeries(a));
  const seriesUpcoming = split.upcoming.filter(inSeries);
  const SERIES_CANCEL_REASONS = ["series_changed", "series_paused", "series_ended"];
  const past = split.past.filter((a) => !(a.series_id && a.status === "cancelled" && SERIES_CANCEL_REASONS.includes(a.cancel_reason ?? "")));
  // 036 FR-5: `Rate this visit` on completed visits that can still be rated; the guardian's own rating otherwise.
  const tr = await getT("ratings");
  const completedIds = all.filter((a) => a.status === "completed").map((a) => a.id);
  const [rateable, ratings] = await Promise.all([listRateableAppointmentIds(user.id, completedIds), listGuardianRatings(user.id, completedIds)]);
  // 035: the pre-consult intake of upcoming appointments (call link, consent hint or done).
  const intakes = await guardianIntakeNotices(user.id);
  const intakeNote = (notice: GuardianIntakeNotice | undefined) => {
    if (!notice) return null;
    if (notice.kind === "completed") return <p className="text-sm text-teal-900">{t("list.intake.done")}</p>;
    if (notice.kind === "link") {
      return (
        <a href={notice.path} className="inline-flex min-h-11 items-center rounded bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800" data-testid="intake-link">
          {t("list.intake.link")}
        </a>
      );
    }
    return (
      <p className="text-sm text-slate-800" data-testid="intake-consent">
        {t("list.intake.consent")}{" "}
        <Link href={`/family/children/${notice.child_id}`} className="font-semibold text-teal-800 underline">
          {t("list.intake.allow")}
        </Link>
      </p>
    );
  };
  // 037: Meet link state of the guardian's own video appointments (Join video call inside the join window).
  const meet = await getMeetInfo(split.upcoming.filter((a) => a.service_snapshot.mode === "video").map((a) => a.id));
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, format.locale, "long", "UTC");

  const card = (a: AppointmentView, actions: boolean) => {
    const snap = a.service_snapshot;
    const clinic = snap.mode === "in_clinic" ? clinicTimeIfDifferent(a.starts_at, format.locale, format.timeZone, snap.location?.time_zone ?? snap.time_zone) : null;
    const changeable = actions && guardianCanChange(a, GUARDIAN_CANCEL_WINDOW_MINUTES);
    const pay = paymentLabel(a, payments.get(a.id), "guardian");
    const payable = paymentHoldOpen(a);
    return (
      <li key={a.id} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-slate-900">
              {format.dateTime(a.starts_at)}
              {clinic ? <span className="block text-sm font-normal text-slate-600">{t("clinicTime", { time: clinic })}</span> : null}
            </p>
            <p className="text-slate-800">
              <Link href={`/p/${a.provider_slug}`} className="underline">
                {a.provider_name}
              </Link>{" "}
              · {snap.name} · {t("duration", { minutes: snap.duration_min })}
            </p>
            <p className="text-sm text-slate-700">
              {snap.mode === "video" ? t("modes.video") : [t("modes.in_clinic"), snap.location?.name, snap.location?.address].filter(Boolean).join(" · ")}
            </p>
            {a.child_name ? <p className="text-sm text-slate-700">{t("list.forChild", { child: a.child_name })}</p> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLE[a.status] ?? "bg-slate-100 text-slate-700"}`}>
              {a.status === "cancelled" && a.cancel_reason === "rescheduled"
                ? t("list.movedTo")
                : a.status === "cancelled" && a.cancelled_by
                  ? t(`list.cancelledBy.${a.cancelled_by}`)
                  : t(`status.${a.status}`)}
            </span>
            {a.is_demo ? (
              <span data-testid="demo-label" className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-900">
                {t("list.demo")}
              </span>
            ) : null}
            {pay ? (
              <span data-testid="payment-label" className={`rounded-full px-3 py-1 text-xs font-semibold ${PAYMENT_LABEL_STYLE[pay]}`}>
                {tp(`labels.${pay}`)}
              </span>
            ) : null}
          </div>
        </div>
        {actions ? intakeNote(intakes.get(a.id)) : null}
        {actions && snap.mode === "video" ? <MeetPanel appointment={a} meet={meet.get(a.id)} side="guardian" /> : null}
        {actions && (a.status === "confirmed" || a.status === "pending_payment") ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions && payable ? (
              <Link href={`/book/${a.provider_profile_id}/pay/${a.id}`} className="inline-flex min-h-11 items-center rounded bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
                {tp("list.payNow")}
              </Link>
            ) : null}
            {a.status === "confirmed" ? (
              <a href={`/api/appointments/${a.id}/ics`} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50">
                {t("list.addToCalendar")}
              </a>
            ) : null}
            {changeable && a.service_id ? (
              <Link href={`/family/appointments/${a.id}/reschedule`} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50">
                {t("list.reschedule")}
              </Link>
            ) : null}
            {changeable || a.status === "pending_payment" ? <CancelAppointmentButton appointmentId={a.id} /> : null}
            {a.status === "confirmed" && !changeable ? <p className="text-sm text-slate-600">{t("list.cancelWindow")}</p> : null}
          </div>
        ) : null}
        {rateable.has(a.id) ? (
          <Link href={`/family/appointments/${a.id}/rate`} className="inline-flex min-h-11 items-center rounded bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            {tr("family.rate")}
          </Link>
        ) : null}
        {ratings.has(a.id) ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="my-rating">
            <span>{tr("family.youRated", { stars: ratings.get(a.id)!.stars })}</span>
            {ratings.get(a.id)!.status === "pending_review" ? <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">{tr("family.underReview")}</span> : null}
            {ratings.get(a.id)!.status === "hidden" ? <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{tr("family.hidden")}</span> : null}
            {ratings.get(a.id)!.editable ? (
              <Link href={`/family/appointments/${a.id}/rate`} className="inline-flex min-h-11 items-center font-medium text-teal-800 underline">
                {tr("family.edit")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("list.title")}</h1>
      {moved ? (
        <p role="status" className="rounded border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">
          {t("list.rescheduled")}
        </p>
      ) : null}
      {series.length ? (
        <section aria-labelledby="timetable" className="space-y-3" data-testid="family-timetable">
          <h2 id="timetable" className="text-lg font-semibold text-slate-900">
            {ts("title")}
          </h2>
          {series.map((s) => {
            const summary = seriesSummary(s, format.timeZone, format.locale);
            const weeks = groupByWeek(seriesUpcoming.filter((a) => a.series_id === s.id), format.timeZone);
            return (
              <div key={s.id} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" data-testid="family-series">
                <div>
                  <p className="font-semibold text-slate-900">{ts("every", { days: summary.days, time: summary.time, therapist: s.provider_name })}</p>
                  {summary.clinicTime ? <p className="text-sm text-slate-600">{ts("clinicTime", { time: summary.clinicTime })}</p> : null}
                  <p className="text-sm text-slate-700">
                    {[s.service_name, s.mode === "video" ? t("modes.video") : [t("modes.in_clinic"), s.location_name].filter(Boolean).join(" · ")].join(" · ")}
                  </p>
                  {s.child_name ? <p className="text-sm text-slate-700">{ts("forChild", { child: s.child_name })}</p> : null}
                  {s.status === "paused" && s.paused_from && s.paused_until ? (
                    <p className="text-sm text-amber-900">{ts("pausedRange", { from: day(s.paused_from), to: day(s.paused_until) })}</p>
                  ) : null}
                </div>
                {weeks.length === 0 ? <p className="text-sm text-slate-600">{ts("noUpcoming")}</p> : null}
                {weeks.map((w) => (
                  <div key={w.weekStart} className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-700">{ts("weekOf", { date: day(w.weekStart) })}</h3>
                    <ul className="divide-y divide-slate-100 text-sm">
                      {w.items.map((a) => {
                        const clinic = clinicTimeIfDifferent(a.starts_at, format.locale, format.timeZone, a.service_snapshot.location?.time_zone ?? a.service_snapshot.time_zone);
                        return (
                          <li key={a.id} className="space-y-2 py-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-slate-900">
                                {format.dateTime(a.starts_at)}
                                {clinic ? <span className="text-slate-600"> · {t("clinicTime", { time: clinic })}</span> : null}
                              </span>
                              {guardianCanChange(a, GUARDIAN_CANCEL_WINDOW_MINUTES) ? <CancelAppointmentButton appointmentId={a.id} /> : null}
                            </div>
                            {a.service_snapshot.mode === "video" ? <MeetPanel appointment={a} meet={meet.get(a.id)} side="guardian" /> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                <p className="text-sm text-slate-600">{ts("cancelOnly")}</p>
              </div>
            );
          })}
        </section>
      ) : null}
      {upcoming.length || series.length === 0 ? (
        <section aria-labelledby="upcoming" className="space-y-3">
          <h2 id="upcoming" className="text-lg font-semibold text-slate-900">
            {t("list.upcoming")}
          </h2>
          {upcoming.length ? (
            <>
              <ul className="space-y-3">{upcoming.map((a) => card(a, true))}</ul>
              <p className="text-sm text-slate-600">{t("list.cancelWindow")}</p>
            </>
          ) : (
            <div className="space-y-3 rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">
              <p>{t("list.none")}</p>
              <Link href="/find" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
                {t("list.findProvider")}
              </Link>
            </div>
          )}
        </section>
      ) : null}
      {past.length ? (
        <section aria-labelledby="past" className="space-y-3">
          <h2 id="past" className="text-lg font-semibold text-slate-900">
            {t("list.past")}
          </h2>
          <ul className="space-y-3">{past.map((a) => card(a, false))}</ul>
        </section>
      ) : null}
    </div>
  );
}
