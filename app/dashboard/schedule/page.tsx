import type { Metadata } from "next";
import Link from "next/link";
import { CancelAppointmentButton, CompleteButtons } from "@/components/booking/AppointmentActions";
import { HoursEditor, OverridesEditor, ServicesEditor } from "@/components/booking/ScheduleEditors";
import { AtClinicNotice } from "@/components/fees/AtClinicNotice";
import { PayoutSetupNotice } from "@/components/payouts/PayoutSetupNotice";
import { MeetPanel } from "@/components/google/MeetPanel";
import { ConflictList } from "@/components/series/TimetableCard";
import { requireProviderPage } from "@/lib/authz";
import { hasStarted } from "@/lib/booking/display";
import { listManageableConflicts } from "@/lib/booking/series";
import { atClinicNoticeDue, getProviderContext, listAgenda, listOverrides, listRules, listServices } from "@/lib/booking/store";
import { addDays, isValidDate, todayIn, wallToUtc, weekdayOf } from "@/lib/booking/time";
import { getMeetInfo } from "@/lib/google/meet";
import { ageLabel } from "@/lib/children/age";
import { agendaIntakeStatus } from "@/lib/intake/attempts";
import { defaultIntakeKind } from "@/lib/booking/intake-defaults";
import { createFormatter } from "@/lib/i18n/format";
import { getLocale, getT } from "@/lib/i18n/server";
import { PAYMENT_LABEL_STYLE, paymentLabel } from "@/lib/payments/display";
import { listPaymentsForAppointments } from "@/lib/payments/store";
import { Alert } from "@/components/ui/Alert";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("booking.schedule");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

type Props = { searchParams: Promise<{ view?: string; date?: string }> };

// FR-8 provider schedule: agenda (day/week, in the profile's time zone) with Mark completed / No-show / Cancel, the
// services editor, weekly hours and date overrides. Only the caller's own profile (resolved server-side).
export default async function SchedulePage({ searchParams }: Props) {
  const actor = await requireProviderPage();
  const t = await getT("booking");
  const tc = await getT("family.children");
  const ts = await getT("series");
  const ctx = await getProviderContext(actor.user.id);
  if (!ctx) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
        <h1 className="text-2xl font-semibold text-slate-900">{t("schedule.title")}</h1>
        <p className="text-slate-700">{t("schedule.noProfile")}</p>
        <Link href="/dashboard/profile" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
          {t("schedule.openProfile")}
        </Link>
      </div>
    );
  }

  const tz = ctx.profile.time_zone;
  const format = createFormatter(await getLocale(), tz);
  const sp = await searchParams;
  const view = sp.view === "day" ? "day" : "week";
  const today = todayIn(tz);
  const anchor = sp.date && isValidDate(sp.date) ? sp.date : today;
  const first = view === "day" ? anchor : addDays(anchor, -weekdayOf(anchor));
  const span = view === "day" ? 1 : 7;
  const from = wallToUtc(first, 0, tz) ?? new Date(`${first}T00:00:00Z`);
  const to = wallToUtc(addDays(first, span), 0, tz) ?? new Date(`${addDays(first, span)}T00:00:00Z`);

  const [services, rules, overrides, agenda, conflicts] = await Promise.all([
    listServices(ctx.profile.id),
    listRules(ctx.profile.id),
    listOverrides(ctx.profile.id, addDays(today, -1)),
    listAgenda(ctx.profile.id, from, to),
    // 043 FR-6: open conflicts of the weekly series this user manages.
    listManageableConflicts(actor.user.id),
  ]);
  // 035 FR-6: intake status per appointment, linking to the brief in the case.
  const intakes = await agendaIntakeStatus(agenda.map((a) => a.id));
  // 037: Meet link state of the video appointments on the agenda (Join video call / Add a video link).
  const meet = await getMeetInfo(agenda.filter((a) => a.service_snapshot.mode === "video").map((a) => a.id));
  // 031 FR-8: `Paid online` / `Pay at clinic` on the agenda.
  const tpay = await getT("payments");
  const payments = await listPaymentsForAppointments(agenda.map((a) => a.id));
  const days = Array.from({ length: span }, (_, i) => addDays(first, i));
  const dayOf = (iso: string) => todayIn(tz, new Date(iso));
  const nav = (date: string, v = view) => `/dashboard/schedule?view=${v}&date=${date}`;
  const h2 = "text-xl font-semibold text-slate-900";
  const locations = ctx.locations.map((l) => ({ id: l.id, name: l.name }));

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">{t("schedule.title")}</h1>
        <p className="text-slate-700">{t("schedule.intro")}</p>
        {ctx.profile.verification_status !== "verified" || !ctx.profile.listed ? (
          <Alert as="p" tone="warning" role="note">{t("schedule.notListed")}</Alert>
        ) : null}
        <p className="text-sm text-slate-600">{t("schedule.timeZone", { zone: tz })}</p>
      </header>

      <section aria-labelledby="agenda" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="agenda" className={h2}>{t("schedule.agenda.title")}</h2>
          <nav className="flex flex-wrap gap-2 text-sm" aria-label={t("schedule.agenda.title")}>
            <Link className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3" href={nav(addDays(first, -span))}>{t("schedule.agenda.previous")}</Link>
            <Link className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3" href={nav(today)}>{t("schedule.agenda.today")}</Link>
            <Link className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3" href={nav(addDays(first, span))}>{t("schedule.agenda.next")}</Link>
            <Link aria-current={view === "day" ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded px-3 ${view === "day" ? "bg-teal-700 text-white" : "border border-slate-300 bg-white"}`} href={nav(anchor, "day")}>{t("schedule.agenda.day")}</Link>
            <Link aria-current={view === "week" ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded px-3 ${view === "week" ? "bg-teal-700 text-white" : "border border-slate-300 bg-white"}`} href={nav(anchor, "week")}>{t("schedule.agenda.week")}</Link>
          </nav>
        </div>
        <div className="space-y-4">
          {days.map((d) => {
            const items = agenda.filter((a) => dayOf(a.starts_at) === d);
            return (
              <div key={d}>
                <h3 className="text-sm font-semibold text-slate-700">{format.date(`${d}T12:00:00Z`, "long")}</h3>
                {items.length === 0 ? (
                  <p className="text-sm text-slate-500">{t("schedule.agenda.none")}</p>
                ) : (
                  <ul className="mt-1 space-y-2">
                    {items.map((a) => (
                      <li key={a.id} className="space-y-2 rounded border border-slate-200 bg-white p-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-900">
                              {format.time(a.starts_at)} - {format.time(a.ends_at)} · {a.service_snapshot.name}
                            </p>
                            <p className="text-slate-700">
                              {a.service_snapshot.mode === "video" ? t("modes.video") : [t("modes.in_clinic"), a.service_snapshot.location?.name].filter(Boolean).join(" · ")}
                            </p>
                            <p className="text-slate-700">
                              {a.child_name ? t("schedule.agenda.child", { child: a.child_name, age: ageLabel(tc, a.child_date_of_birth) }) : t("schedule.agenda.noChild")}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800">{t(`status.${a.status}`)}</span>
                            {a.series_id ? (
                              <span data-testid="repeats-label" className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-900">
                                {ts("schedule.repeats")}
                              </span>
                            ) : null}
                            {(() => {
                              const pay = paymentLabel(a, payments.get(a.id), "provider");
                              return pay ? (
                                <span data-testid="payment-label" className={`rounded-full px-3 py-1 text-xs font-semibold ${PAYMENT_LABEL_STYLE[pay]}`}>
                                  {tpay(`labels.${pay}`)}
                                </span>
                              ) : null;
                            })()}
                          </div>
                        </div>
                        {intakes.get(a.id) ? (
                          <p className="flex flex-wrap items-center gap-2 text-slate-800" data-testid="agenda-intake">
                            <span>{t(`schedule.agenda.intake.${intakes.get(a.id)!.status}`)}</span>
                            <Link
                              href={`/cases/${intakes.get(a.id)!.case_id}/brief#appointment-${a.id}`}
                              className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
                            >
                              {t("schedule.agenda.intake.openBrief")}
                            </Link>
                          </p>
                        ) : null}
                        {a.outside_availability ? (
                          <Alert as="p" tone="warning" role="note">{t("schedule.agenda.warning")}</Alert>
                        ) : null}
                        {a.service_snapshot.mode === "video" ? <MeetPanel appointment={a} meet={meet.get(a.id)} side="provider" /> : null}
                        {a.status === "confirmed" ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <CompleteButtons appointmentId={a.id} started={hasStarted(a.starts_at)} />
                            {!hasStarted(a.starts_at) ? <CancelAppointmentButton appointmentId={a.id} side="provider" /> : null}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="series-conflicts" className="space-y-3">
        <h2 id="series-conflicts" className={h2}>{ts("conflicts.title")}</h2>
        <p className="text-sm text-slate-700">{ts("conflicts.intro")}</p>
        <ConflictList conflicts={conflicts} showCase />
      </section>

      <section aria-labelledby="services" className="space-y-3">
        <h2 id="services" className={h2}>{t("schedule.services.title")}</h2>
        {(await atClinicNoticeDue(ctx.profile.id)) ? <AtClinicNotice /> : null}
        <PayoutSetupNotice userId={actor.user.id} orgIds={ctx.orgs.map((o) => o.id)} />
        {locations.length === 0 ? <p className="text-sm text-slate-600">{t("schedule.noLocations")}</p> : null}
        <ServicesEditor services={services} locations={locations} orgs={ctx.orgs} defaultIntakeKind={defaultIntakeKind(ctx.profile.provider_type)} />
      </section>

      <section aria-labelledby="hours" className="space-y-3">
        <h2 id="hours" className={h2}>{t("schedule.hours.title")}</h2>
        <HoursEditor rules={rules} locations={locations} />
      </section>

      <section aria-labelledby="overrides" className="space-y-3">
        <h2 id="overrides" className={h2}>{t("schedule.overrides.title")}</h2>
        <OverridesEditor overrides={overrides} locations={locations} today={today} />
      </section>
    </div>
  );
}
