import Link from "next/link";
import { ProgressChart } from "@/components/iep/ProgressChart";
import { formatValue, trendLines } from "@/components/iep/view";
import { ReportPreview } from "@/components/report/ReportEditor";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getGuardianPlans } from "@/lib/iep";

export const dynamic = "force-dynamic";

// 025 FR-6: the latest published plan per organisation (published_versions.content_md) and, per published goal,
// its live progress chart (D-3). Never draft text (NFR-1); progress notes stay with the care team.
export default async function ChildPlanPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const [plans, t, tc, tt, tv, format] = await Promise.all([
    getGuardianPlans(child.id),
    getT("iep.family"),
    getT("iep.chart"),
    getT("iep.trend"),
    getT("iep.values"),
    getFormatter(),
  ]);
  const day = (d: string) => format.date(`${d}T12:00:00+05:30`, "short");

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title", { name: child.display_name })}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>

      {plans.length === 0 ? (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
          {t("empty")}
        </p>
      ) : (
        plans.map((plan) => (
          <section key={plan.plan_id} aria-labelledby={`plan-${plan.plan_id}`} className="space-y-4" data-plan={plan.plan_id}>
            <div className="space-y-1">
              <h2 id={`plan-${plan.plan_id}`} className="text-xl font-semibold break-words text-slate-900">
                {t("from", { org: plan.org_name })}
              </h2>
              <p className="text-sm text-slate-600">{t("sharedOn", { date: format.date(plan.published_at, "long") })}</p>
            </div>
            <ReportPreview markdown={plan.content_md} />
            {plan.goals.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-lg font-semibold text-slate-900">{t("progressTitle")}</h3>
                <p className="text-sm text-slate-700">{t("progressIntro")}</p>
                <ol className="space-y-4">
                  {plan.goals.map((goal) => {
                    const value = (n: number) => formatValue(tv, format, goal.measure_type, n);
                    return (
                      <li key={goal.id} className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4" data-goal={goal.id}>
                        <h4 className="font-semibold break-words text-slate-900">{goal.statement}</h4>
                        <ul className="space-y-1 text-sm text-slate-800" aria-label={tt("label")} data-trend={goal.id}>
                          {trendLines(tt, value, format, goal.trend).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                        <ProgressChart
                          id={`chart-${plan.plan_id}-${goal.id}`}
                          measure={goal.measure_type}
                          baseline={goal.baseline_value}
                          target={goal.target_value}
                          baselineLabel={value(goal.baseline_value)}
                          targetLabel={value(goal.target_value)}
                          points={goal.points.map((p) => ({
                            observed_on: p.observed_on,
                            value: p.value,
                            dateLabel: day(p.observed_on),
                            valueLabel: value(p.value),
                          }))}
                          labels={{
                            title: tc("title", { goal: goal.statement }),
                            baseline: tc("baseline"),
                            target: tc("target"),
                            showData: tc("showData"),
                            date: tc("date"),
                            value: tc("value"),
                            noData: tc("noData"),
                          }}
                        />
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}
