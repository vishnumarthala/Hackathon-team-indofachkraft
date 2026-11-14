import Link from "next/link";
import { notFound } from "next/navigation";
import { CancelAppointmentButton } from "@/components/booking/AppointmentActions";
import { JourneyTimeline } from "@/components/family/home/JourneyTimeline";
import { secondaryAction } from "@/components/family/home/NextStepCard";
import { MeetPanel } from "@/components/google/MeetPanel";
import { requireGuardianPage } from "@/lib/authz";
import { clinicTimeIfDifferent, guardianCanChange } from "@/lib/booking/display";
import { GUARDIAN_CANCEL_WINDOW_MINUTES } from "@/lib/booking/slots";
import { loadAppointmentJourney, visitStillAhead } from "@/lib/family/journey";
import { directionsUrl } from "@/lib/family/next-step";
import type { MeetStatus } from "@/lib/google/meet";
import { getFormatter, getT, getTimeZone } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 052 FR-6: one visit with "What happens next" (Permissions -> Intake call -> Visit -> Home program). Also the booking
// confirmation (`?booked=1`, from the booking flow and the payment page). Only the booking guardian with an active
// link to the child; everyone else 404.
export default async function FamilyAppointmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ booked?: string }> }) {
  const { user } = await requireGuardianPage();
  const { id } = await params;
  const { booked } = await searchParams;
  const timeZone = await getTimeZone();
  const journey = await loadAppointmentJourney(user.id, id, timeZone);
  if (!journey) notFound();
  const { appointment: a, meet } = journey;
  const [t, tb, format] = [await getT("family.journey"), await getT("booking"), await getFormatter()];
  const snap = a.service_snapshot;
  const clinic = snap.mode === "in_clinic" ? clinicTimeIfDifferent(a.starts_at, format.locale, format.timeZone, snap.location?.time_zone ?? snap.time_zone) : null;
  const directions = directionsUrl({
    mode: snap.mode === "video" ? "video" : "in_clinic",
    lat: snap.location?.lat ?? null,
    lng: snap.location?.lng ?? null,
    location_name: snap.location?.name ?? null,
    location_address: snap.location?.address ?? null,
  });
  const upcoming = visitStillAhead(a);
  const changeable = guardianCanChange(a, GUARDIAN_CANCEL_WINDOW_MINUTES);

  return (
    <div className="space-y-6">
      <Link href="/family/appointments" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back")}
      </Link>
      {booked ? (
        <p role="status" className="rounded-2xl border border-teal-200 bg-teal-50 p-4 font-semibold text-teal-900" data-testid="booked-notice">
          {a.status === "pending_payment" ? tb("status.pending_payment") : t("booked")}
        </p>
      ) : null}
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("heading", { provider: a.provider_name })}</h1>
        {a.child_name ? <p className="text-slate-700">{tb("list.forChild", { child: a.child_name })}</p> : null}
      </header>

      <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" aria-label={t("summary")}>
        <p className="font-semibold text-slate-900">
          {format.dateTime(a.starts_at)}
          {clinic ? <span className="block text-sm font-normal text-slate-600">{tb("clinicTime", { time: clinic })}</span> : null}
        </p>
        <p className="text-slate-800">
          {snap.name} · {tb("duration", { minutes: snap.duration_min })}
        </p>
        <p className="text-sm text-slate-700">
          {snap.mode === "video" ? tb("modes.video") : [tb("modes.in_clinic"), snap.location?.name, snap.location?.address].filter(Boolean).join(" · ")}
        </p>
        {a.status !== "confirmed" && a.status !== "pending_payment" ? (
          <p className="text-sm font-semibold text-slate-700">{tb(`status.${a.status}`)}</p>
        ) : null}
        {upcoming && snap.mode === "video" ? (
          <MeetPanel appointment={a} meet={{ meet_url: meet.meet_url, meet_status: meet.meet_status as MeetStatus | null }} side="guardian" />
        ) : null}
        {upcoming ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {directions ? (
              <a href={directions} target="_blank" rel="noopener noreferrer" className={secondaryAction}>
                {t("directions")}
              </a>
            ) : null}
            <a href={`/api/appointments/${a.id}/ics`} className={secondaryAction}>
              {tb("list.addToCalendar")}
            </a>
            {changeable && a.service_id ? (
              <Link href={`/family/appointments/${a.id}/reschedule`} className={secondaryAction}>
                {tb("list.reschedule")}
              </Link>
            ) : null}
            {changeable ? <CancelAppointmentButton appointmentId={a.id} /> : null}
          </div>
        ) : null}
      </section>

      <JourneyTimeline input={journey.input} />
    </div>
  );
}
