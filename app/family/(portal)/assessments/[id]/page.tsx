import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckinForm, type FormItem } from "@/components/assessments/CheckinForm";
import { isAnswerKey } from "@/components/assessments/view";
import { ReportPreview } from "@/components/report/ReportEditor";
import { getGuardianAssessment } from "@/lib/assessments";
import { requireGuardianPage } from "@/lib/authz";
import { getInstrument } from "@/lib/clinical/instruments";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 024 FR-9: fill in (one question per screen), or read back a submitted questionnaire and the shared result.
export default async function FamilyAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireGuardianPage();
  const detail = await getGuardianAssessment(id, user.id);
  if (!detail) notFound();

  const [t, ta, tc, format] = await Promise.all([
    getT("family.assessments"),
    getT("assessments.answers"),
    getT("assessments"),
    getFormatter(),
  ]);
  const { assessment, answers, summary } = detail;
  const open = assessment.status === "assigned" || assessment.status === "in_progress";
  const items: FormItem[] = (getInstrument(assessment.instrument_key)?.items ?? []).map((item) => ({
    id: item.id,
    text: item.text,
    options: item.scale.type === "choice" ? item.scale.options.map((o) => o.value) : [],
    redFlag: Boolean(item.red_flag),
  }));
  const stringAnswers = Object.fromEntries(
    Object.entries(answers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const urgent = items.some((i) => i.redFlag && answers[i.id] === "yes");

  return (
    <div className="space-y-5">
      <Link href="/family/assessments" className="inline-flex min-h-11 items-center text-sm font-medium text-slate-700 underline">
        {t("backToList")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 break-words sm:text-3xl">{assessment.title}</h1>
        <p className="text-slate-700">{t("forChild", { child: assessment.child_name })}</p>
        {assessment.due_on && open ? (
          <p className="text-sm text-slate-700">{t("due", { date: format.date(`${assessment.due_on}T12:00:00+05:30`, "long") })}</p>
        ) : null}
        <p className="text-sm font-medium text-slate-700">{tc("disclaimer")}</p>
      </header>

      {open ? (
        <CheckinForm assessmentId={assessment.id} items={items} initialAnswers={stringAnswers} initialVersion={assessment.version} />
      ) : (
        <div className="space-y-5">
          {urgent ? (
            <div role="alert" className="rounded-2xl border-2 border-red-600 bg-red-50 p-4 text-base font-semibold text-red-900">
              {tc("urgent")}
            </div>
          ) : null}
          {summary ? (
            <section className="space-y-2" aria-labelledby="result-title">
              <h2 id="result-title" className="text-lg font-semibold text-slate-900">
                {t("resultTitle")}
              </h2>
              <p className="text-sm text-slate-600">{t("englishOnlyResult")}</p>
              <div lang="en">
                <ReportPreview markdown={summary.content_md} />
              </div>
            </section>
          ) : (
            <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
              {assessment.status === "reviewed" ? t("reviewedNotShared") : t("submitted")}
            </p>
          )}
          <section className="space-y-2" aria-labelledby="your-answers">
            <h2 id="your-answers" className="text-lg font-semibold text-slate-900">
              {t("yourAnswers")}
            </h2>
            <ol className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {items.map((item, i) => {
                const value = answers[item.id];
                return (
                  <li key={item.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:justify-between">
                    <span lang="en" className="text-sm text-slate-900">
                      {i + 1}. {item.text}
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-slate-900">
                      {isAnswerKey(value) ? ta(value) : String(value ?? "")}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
