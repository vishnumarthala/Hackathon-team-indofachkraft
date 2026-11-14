// Ticket 052 FR-6: "What happens next" - the visit's four steps with their live status and the action that is due.
// Server component (used on the booking confirmation and /family/appointments/<id>).
import Link from "next/link";
import { journeySteps, type JourneyInput, type JourneyStatus, type JourneyStep } from "@/lib/family/journey";
import { getFormatter, getT } from "@/lib/i18n/server";
import { primaryAction, secondaryAction } from "./NextStepCard";

const DOT: Record<JourneyStatus, string> = {
  done: "border-emerald-600 bg-emerald-600 text-white",
  due: "border-teal-700 bg-teal-700 text-white",
  waiting: "border-amber-500 bg-amber-50 text-amber-900",
  upcoming: "border-slate-300 bg-white text-slate-600",
  skipped: "border-slate-300 bg-slate-100 text-slate-500",
};

const BADGE: Record<JourneyStatus, string> = {
  done: "bg-emerald-50 text-emerald-800",
  due: "bg-teal-700 text-white",
  waiting: "bg-amber-50 text-amber-900",
  upcoming: "bg-slate-100 text-slate-700",
  skipped: "bg-slate-100 text-slate-600",
};

export async function JourneyTimeline({ input, now = new Date() }: { input: JourneyInput; now?: Date }) {
  const t = await getT("family.journey");
  const format = await getFormatter();
  const steps = journeySteps(input, now);
  const a = input.appointment;

  const detail = (s: JourneyStep): string => {
    switch (s.key) {
      case "permissions":
        return t(`steps.permissions.${s.detail as "needed" | "given" | "notNeeded"}`);
      case "intake":
        return t(`steps.intake.${s.detail as "done" | "ready" | "afterPermission" | "linkSoon" | "skipped"}`);
      case "visit":
        if (s.detail === "scheduled") return format.dateTime(a.starts_at);
        if (s.detail === "today" || s.detail === "tomorrow") return t(`steps.visit.${s.detail}`, { time: format.time(a.starts_at) });
        return t(`steps.visit.${s.detail as "now" | "attended" | "missed" | "cancelled" | "awaitingCentre" | "payToConfirm"}`);
      default:
        return t(`steps.home.${s.detail as "ready" | "afterVisit"}`);
    }
  };
  const actionLabel = (s: JourneyStep): string => {
    const label = s.action?.label ?? "";
    switch (s.key) {
      case "permissions":
        return t(`steps.permissions.${label as "give" | "review"}`);
      case "intake":
        return t("steps.intake.start");
      case "visit":
        return t("steps.visit.pay");
      default:
        return t("steps.home.open");
    }
  };

  return (
    <section aria-labelledby="journey-title" className="space-y-3" data-testid="journey">
      <h2 id="journey-title" className="text-lg font-semibold text-slate-900">
        {t("title")}
      </h2>
      <ol className="space-y-0">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0" data-step={s.key} data-status={s.status}>
            {i < steps.length - 1 ? <span aria-hidden="true" className="absolute left-4 top-9 bottom-0 w-0.5 -translate-x-1/2 bg-slate-200" /> : null}
            <span aria-hidden="true" className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${DOT[s.status]}`}>
              {s.status === "done" ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">{t(`steps.${s.key}.title`)}</h3>
                <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${BADGE[s.status]}`}>{t(`status.${s.status}`)}</span>
              </div>
              <p className="text-sm text-slate-700">{detail(s)}</p>
              {s.action ? (
                s.action.href.startsWith("/intake/") ? (
                  <a href={s.action.href} className={s.status === "due" ? primaryAction : secondaryAction}>
                    {actionLabel(s)}
                  </a>
                ) : (
                  <Link href={s.action.href} className={s.status === "due" ? primaryAction : secondaryAction}>
                    {actionLabel(s)}
                  </Link>
                )
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
