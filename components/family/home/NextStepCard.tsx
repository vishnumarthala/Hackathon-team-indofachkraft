// Ticket 052 FR-1: the family home's single "Next step" card (Figma /family — Home 15:11). Server component.
import Link from "next/link";
import type { ReactNode } from "react";
import { MeetPanel } from "@/components/google/MeetPanel";
import { clinicTimeIfDifferent } from "@/lib/booking/display";
import type { MeetStatus } from "@/lib/google/meet";
import { appointmentHref, directionsUrl, type NextStep, type VisitFact } from "@/lib/family/next-step";
import { getFormatter, getT } from "@/lib/i18n/server";

export const primaryAction =
  "inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-teal-700 px-5 py-3 text-center text-base font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 sm:w-auto";
export const secondaryAction =
  "inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-3 text-center text-base font-semibold text-slate-900 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 sm:w-auto";

const TONE: Record<NextStep["rule"], string> = {
  add_child: "border-teal-200 bg-teal-50",
  permission: "border-amber-200 bg-amber-50",
  intake: "border-teal-200 bg-teal-50",
  pay: "border-amber-200 bg-amber-50",
  visit: "border-teal-200 bg-teal-50",
  practice: "border-teal-200 bg-teal-50",
  message: "border-sky-200 bg-sky-50",
  all_set: "border-emerald-200 bg-emerald-50",
};

/** When and where of a visit: date and time (plus clinic time when it differs), provider and service, place or video. */
export async function VisitWhere({ visit }: { visit: VisitFact }) {
  const t = await getT("booking");
  const format = await getFormatter();
  const clinic = visit.mode === "in_clinic" ? clinicTimeIfDifferent(visit.starts_at, format.locale, format.timeZone, visit.clinic_time_zone) : null;
  return (
    <div className="text-sm text-slate-800">
      <p className="font-semibold text-slate-900">
        {format.dateTime(visit.starts_at)}
        {clinic ? <span className="block font-normal text-slate-600">{t("clinicTime", { time: clinic })}</span> : null}
      </p>
      <p className="break-words">
        {visit.provider_name}
        {visit.service_name ? ` · ${visit.service_name}` : ""}
      </p>
      <p className="break-words text-slate-700">
        {visit.mode === "video" ? t("modes.video") : [t("modes.in_clinic"), visit.location_name, visit.location_address].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

export async function NextStepCard({ step }: { step: NextStep }) {
  const t = await getT("family.home.steps");
  const th = await getT("family.home");
  const format = await getFormatter();
  const when = (v: VisitFact) => format.dateTime(v.starts_at);

  let title: string;
  let body: ReactNode = null;
  let actions: ReactNode = null;

  switch (step.rule) {
    case "add_child":
      title = t("addChild.title");
      body = <p>{t("addChild.text")}</p>;
      actions = (
        <>
          <Link href="/family/children/claim" className={primaryAction} data-testid="next-step-action">
            {t("addChild.code")}
          </Link>
          <Link href="/find" className={secondaryAction}>
            {t("addChild.find")}
          </Link>
        </>
      );
      break;
    case "permission":
      title = t("permission.title", { child: step.child_name });
      body = <p>{t("permission.text", { when: when(step.visit), provider: step.visit.provider_name })}</p>;
      actions = (
        <Link href={step.href} className={primaryAction} data-testid="next-step-action">
          {t("permission.action")}
        </Link>
      );
      break;
    case "intake":
      title = t("intake.title");
      body = (
        <>
          <p>{t("intake.text", { child: step.child_name, provider: step.visit.provider_name, when: when(step.visit) })}</p>
          {step.ready ? null : <p className="mt-1">{t("intake.linkSoon")}</p>}
        </>
      );
      actions = step.ready ? (
        <a href={step.href} className={primaryAction} data-testid="next-step-action">
          {t("intake.action")}
        </a>
      ) : (
        <Link href={step.href} className={primaryAction} data-testid="next-step-action">
          {t("intake.openVisit")}
        </Link>
      );
      break;
    case "pay": {
      const amount = format.inr(step.payment.amount_paise);
      title = t("pay.title", { child: step.payment.child_name });
      body = (
        <p>
          {step.payment.kind === "appointment"
            ? t("pay.textAppointment")
            : step.payment.kind === "package"
              ? t("pay.textPackage", { centre: step.payment.org_name ?? "", amount })
              : t("pay.textBalance", { centre: step.payment.org_name ?? "", amount })}
        </p>
      );
      actions = (
        <Link href={step.payment.href} className={primaryAction} data-testid="next-step-action">
          {t("pay.action", { amount })}
        </Link>
      );
      break;
    }
    case "visit": {
      const v = step.visit;
      const directions = directionsUrl(v);
      title = step.day === "now" ? t("visit.titleNow") : step.day === "today" ? t("visit.titleToday") : t("visit.titleTomorrow");
      body = (
        <>
          <p className="mb-2">{t("visit.text", { child: v.child_name })}</p>
          <VisitWhere visit={v} />
        </>
      );
      actions = (
        <>
          {v.mode === "video" ? (
            <MeetPanel
              appointment={{ id: v.id, status: v.status, starts_at: v.starts_at, ends_at: v.ends_at }}
              meet={{ meet_url: v.meet_url, meet_status: v.meet_status as MeetStatus | null }}
              side="guardian"
            />
          ) : null}
          {directions ? (
            <a href={directions} target="_blank" rel="noopener noreferrer" className={primaryAction} data-testid="next-step-action">
              {t("visit.directions")}
            </a>
          ) : null}
          <Link href={appointmentHref(v.id)} className={secondaryAction}>
            {t("visit.details")}
          </Link>
        </>
      );
      break;
    }
    case "practice":
      title = t("practice.title");
      body = <p>{t("practice.text", { child: step.child_name })}</p>;
      actions = (
        <Link href={step.href} className={primaryAction} data-testid="next-step-action">
          {t("practice.action")}
        </Link>
      );
      break;
    case "message":
      title = t("message.title");
      body = <p>{t("message.text", { count: step.unread })}</p>;
      actions = (
        <Link href={step.href} className={primaryAction} data-testid="next-step-action">
          {step.from ? t("message.action", { name: step.from }) : t("message.actionNoName")}
        </Link>
      );
      break;
    default: {
      title = t("allSet.title");
      const v = step.next_visit;
      body = v ? (
        <>
          <p className="mb-2">{t("allSet.next")}</p>
          <VisitWhere visit={v} />
        </>
      ) : (
        <p>{t("allSet.none")}</p>
      );
      actions = v ? (
        <Link href={appointmentHref(v.id)} className={secondaryAction} data-testid="next-step-action">
          {t("visit.details")}
        </Link>
      ) : (
        <Link href="/find" className={primaryAction} data-testid="next-step-action">
          {t("allSet.find")}
        </Link>
      );
    }
  }

  return (
    <section
      aria-labelledby="next-step-title"
      data-testid="next-step"
      data-rule={step.rule}
      className={`space-y-3 rounded-2xl border p-5 shadow-sm ${TONE[step.rule]}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-teal-900">{th("nextStep")}</p>
      <h2 id="next-step-title" className="text-xl font-bold break-words text-slate-900">
        {title}
      </h2>
      <div className="space-y-1 text-base text-slate-800">{body}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">{actions}</div>
    </section>
  );
}
