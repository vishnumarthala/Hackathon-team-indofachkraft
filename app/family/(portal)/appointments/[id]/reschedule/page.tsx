import Link from "next/link";
import { notFound } from "next/navigation";
import { RescheduleForm } from "@/components/booking/RescheduleForm";
import { requireGuardianPage } from "@/lib/authz";
import { getAppointment, getService } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// FR-7 `Reschedule`: only the booking guardian, only a confirmed appointment whose service is still offered.
export default async function ReschedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireGuardianPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const appointment = await getAppointment(id);
  if (!appointment || appointment.guardian_user_id !== user.id) notFound();
  const t = await getT("booking");
  const format = await getFormatter();
  const service = appointment.service_id ? await getService(appointment.service_id) : null;
  const usable = appointment.status === "confirmed" && service?.active;

  return (
    <div className="space-y-6">
      <Link href="/family/appointments" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("list.back")}
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("list.rescheduleTitle")}</h1>
      <p className="text-slate-700">
        {appointment.provider_name} · {appointment.service_snapshot.name}
        <br />
        {t("list.currentTime", { time: format.dateTime(appointment.starts_at) })}
      </p>
      {usable && service ? (
        <RescheduleForm
          appointmentId={appointment.id}
          profileId={appointment.provider_profile_id}
          serviceId={service.id}
          clinicTimeZone={service.mode === "in_clinic" ? service.time_zone : null}
          currentStart={appointment.starts_at}
        />
      ) : (
        <p role="alert" className="rounded border border-slate-200 bg-white p-4 text-slate-800">
          {t("errors.invalid_transition")}
        </p>
      )}
    </div>
  );
}
