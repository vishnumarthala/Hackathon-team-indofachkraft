import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PayPanel, type PayState } from "@/components/payments/PayPanel";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { FAMILY_LOGIN_PATH } from "@/lib/auth-access";
import { clinicTimeIfDifferent } from "@/lib/booking/display";
import { getAppointment, type AppointmentView } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { env } from "@/lib/env";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getPaymentForAppointment, type PaymentRow } from "@/lib/payments/store";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ profileId: string; appointmentId: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("payments.pay");
  return { title: `${t("metaTitle")} | DoctorNearMe`, robots: { index: false, follow: false } };
}

function stateOf(a: AppointmentView, payment: PaymentRow | null): PayState {
  if (payment && (payment.status === "refund_pending" || payment.status === "refunded")) return "refunded";
  if (payment?.status === "captured" && ["confirmed", "completed", "no_show"].includes(a.status)) return "paid";
  if (a.service_snapshot.payment_mode !== "online" || !(a.service_snapshot.fee_inr > 0)) return "nothing";
  if (a.status === "cancelled") return "cancelled";
  if (a.status === "pending_payment" && a.hold_expires_at && Date.parse(a.hold_expires_at) > Date.now()) return "payable";
  if (a.status === "confirmed" || a.status === "completed" || a.status === "no_show") return "paid";
  return "expired";
}

// 031 FR-4 checkout page (`Continue to payment` in the booking flow, `Pay now` in /family/appointments). Only the
// guardian who booked the appointment (anyone else 404). Shows the amount, the time left on the 15-minute hold and the
// cancellation/refund policy before payment (FR-7). The Razorpay checkout script is allowed on this route only
// (lib/csp.ts); DEMO_MODE simulates the payment instead.
export default async function PayPage({ params }: Props) {
  const { profileId, appointmentId } = await params;
  if (!isUuid(profileId) || !isUuid(appointmentId)) notFound();
  const user = await getAuthenticatedUser();
  if (!user) redirect(`${FAMILY_LOGIN_PATH}?next=${encodeURIComponent(`/book/${profileId}/pay/${appointmentId}`)}`);
  if ((await getUserRole(user.id)) !== "guardian") notFound();
  const appointment = await getAppointment(appointmentId);
  if (!appointment || appointment.guardian_user_id !== user.id || appointment.provider_profile_id !== profileId) notFound();

  const payment = await getPaymentForAppointment(appointment.id);
  const t = await getT("payments.pay");
  const tb = await getT("booking");
  const format = await getFormatter();
  const snap = appointment.service_snapshot;
  const clinic =
    snap.mode === "in_clinic" ? clinicTimeIfDifferent(appointment.starts_at, format.locale, format.timeZone, snap.location?.time_zone ?? snap.time_zone) : null;
  const where = snap.mode === "video" ? tb("modes.video") : [tb("modes.in_clinic"), snap.location?.name].filter(Boolean).join(" · ");
  const state = stateOf(appointment, payment);
  const amountPaise = payment?.amount_paise ?? snap.fee_inr * 100;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:py-8">
      <Link href="/family/appointments" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("viewAppointments")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-lg text-slate-700">{t("with", { name: appointment.provider_name })}</p>
      </header>

      <dl className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-900">{t("service")}</dt>
          <dd className="text-slate-700">
            {snap.name} · {tb("duration", { minutes: snap.duration_min })}
            <span className="block">{where}</span>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">{t("when")}</dt>
          <dd className="text-slate-700">
            {format.dateTime(appointment.starts_at)}
            {clinic ? <span className="block">{tb("clinicTime", { time: clinic })}</span> : null}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">{t("amount")}</dt>
          <dd className="text-lg font-semibold text-slate-900" data-testid="pay-amount">
            {format.inr(amountPaise)}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="refund-policy" className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
        <h2 id="refund-policy" className="font-semibold text-slate-900">
          {t("policyTitle")}
        </h2>
        <p data-testid="refund-policy">{t("policy")}</p>
        <p className="text-slate-600">{t("secure")}</p>
        <p className="text-slate-600">{t("testMode")}</p>
      </section>

      <PayPanel
        appointmentId={appointment.id}
        profileId={profileId}
        initialState={state}
        expiresAt={appointment.hold_expires_at}
        demo={env.DEMO_MODE}
        description={snap.name}
      />
    </div>
  );
}
