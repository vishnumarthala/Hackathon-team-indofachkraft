import Link from "next/link";
import { CancelAppointmentButton } from "@/components/booking/AppointmentActions";
import { requireGuardianPage } from "@/lib/authz";
import { clinicTimeIfDifferent, guardianCanChange, splitAppointments } from "@/lib/booking/display";
import { GUARDIAN_CANCEL_WINDOW_MINUTES } from "@/lib/booking/slots";
import { listGuardianAppointments, type AppointmentView } from "@/lib/booking/store";
import { getFormatter, getT } from "@/lib/i18n/server";
import { PAYMENT_LABEL_STYLE, paymentHoldOpen, paymentLabel } from "@/lib/payments/display";
import { listPaymentsForAppointments } from "@/lib/payments/store";

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
  const { upcoming, past } = splitAppointments(all);

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
            {pay ? (
              <span data-testid="payment-label" className={`rounded-full px-3 py-1 text-xs font-semibold ${PAYMENT_LABEL_STYLE[pay]}`}>
                {tp(`labels.${pay}`)}
              </span>
            ) : null}
          </div>
        </div>
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
