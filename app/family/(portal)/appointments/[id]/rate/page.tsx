import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RatingForm } from "@/components/ratings/RatingForm";
import { requireGuardianPage } from "@/lib/authz";
import { getAppointment } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { getFormatter, getT } from "@/lib/i18n/server";
import { rateState } from "@/lib/ratings/store";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("ratings.form");
  return { title: t("metaTitle") };
}

// 036 FR-2/FR-5: rate a completed visit (booking guardian only, within 30 days), or change the rating within 7 days.
// Other guardians' and unknown appointments 404.
export default async function RateVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireGuardianPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const appointment = await getAppointment(id);
  if (!appointment || appointment.guardian_user_id !== user.id) notFound();
  const t = await getT("ratings.form");
  const format = await getFormatter();
  const state = await rateState(id, user.id);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Link href="/family/appointments" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back")}
      </Link>
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-700">{t("subtitle", { provider: appointment.provider_name, date: format.date(appointment.starts_at) })}</p>
      </div>
      {state.kind === "eligible" ? (
        <RatingForm appointmentId={id} mode="create" />
      ) : state.kind === "rated" && state.editable ? (
        <RatingForm appointmentId={id} mode="edit" initialStars={state.rating.stars} initialComment={state.rating.comment ?? ""} />
      ) : (
        <p role="status" className="rounded border border-slate-200 bg-white p-4 text-slate-800">
          {state.kind === "rated" ? t("editClosed") : t("notEligible")}
        </p>
      )}
    </div>
  );
}
