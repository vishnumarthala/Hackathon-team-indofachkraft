import Link from "next/link";
import { notFound } from "next/navigation";
import { AssessmentReviewForm } from "@/components/assessments/AssessmentReviewForm";
import { BAND_KEYS, RED_FLAG_KEYS, STATUS_KEYS, STATUS_TONES, isAnswerKey } from "@/components/assessments/view";
import { ReportPreview } from "@/components/report/ReportEditor";
import { getAssessmentForProvider } from "@/lib/assessments";
import { requireCasePage } from "@/lib/authz";
import type { RedFlagCode } from "@/lib/clinical/checkin";
import { getInstrument } from "@/lib/clinical/instruments";
import { getFormatter, getT } from "@/lib/i18n/server";
import { Badge } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

// 024 FR-8: one questionnaire: answers, computed score/band, red-flag answers highlighted, `Mark reviewed`.
export default async function CaseAssessmentPage({ params }: { params: Promise<{ id: string; assessmentId: string }> }) {
  const { id, assessmentId } = await params;
  await requireCasePage(id);
  const detail = await getAssessmentForProvider(assessmentId, id);
  if (!detail) notFound();

  const [t, ts, tb, tf, ta, tc, format] = await Promise.all([
    getT("assessments.provider"),
    getT("assessments.status"),
    getT("assessments.bands"),
    getT("assessments.redFlags"),
    getT("assessments.answers"),
    getT("assessments"),
    getFormatter(),
  ]);
  const { assessment, answers, score, red_flags: redFlags, published } = detail;
  const items = getInstrument(assessment.instrument_key)?.items ?? [];
  const questions = items.filter((i) => !i.red_flag);
  const safety = items.filter((i) => i.red_flag);
  const answerText = (value: unknown) => (value === undefined ? t("notAnswered") : isAnswerKey(value) ? ta(value) : String(value));

  const itemRow = (item: (typeof items)[number], index: number) => {
    const value = answers[item.id];
    const flagged = Boolean(item.red_flag) && value === "yes";
    return (
      <li
        key={item.id}
        data-item={item.id}
        data-red-flag={flagged ? "true" : undefined}
        className={`flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:justify-between ${flagged ? "border-l-4 border-red-600 bg-red-50" : ""}`}
      >
        <span lang="en" className="text-sm text-slate-900">
          {index + 1}. {item.text}
        </span>
        <span className={`shrink-0 text-sm font-semibold ${flagged ? "text-red-800" : value === undefined ? "text-slate-500" : "text-slate-900"}`}>
          {answerText(value)}
        </span>
      </li>
    );
  };

  return (
    <div className="space-y-5">
      <Link href={`/cases/${id}/assessments`} className="text-sm font-medium text-slate-700 underline">
        {t("back")}
      </Link>
      <header className="space-y-1">
        <h2 className="text-lg font-semibold break-words">{assessment.title}</h2>
        <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
          <Badge tone={STATUS_TONES[assessment.status]}>{ts(STATUS_KEYS[assessment.status])}</Badge>
          {assessment.submitted_at ? <span>{t("submittedOn", { date: format.dateTime(assessment.submitted_at) })}</span> : null}
          {assessment.reviewed_at ? <span>{t("reviewedOn", { date: format.dateTime(assessment.reviewed_at) })}</span> : null}
        </p>
      </header>

      <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800">{tc("disclaimer")}</p>

      {redFlags.length > 0 ? (
        <section role="alert" className="rounded border-2 border-red-600 bg-red-50 p-3 text-red-900" aria-labelledby="red-flags">
          <h3 id="red-flags" className="font-semibold">
            {t("redFlagTitle")}
          </h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {redFlags.map((code) => (
              <li key={code}>{code in RED_FLAG_KEYS ? tf(RED_FLAG_KEYS[code as RedFlagCode]) : code}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {score ? (
        <section className="space-y-1 rounded border border-slate-200 bg-white p-4" aria-labelledby="score-title" data-testid="assessment-score">
          <h3 id="score-title" className="font-semibold">
            {t("scoreTitle")}
          </h3>
          {!score.complete ? <p className="text-sm text-slate-700">{t("partial", { answered: score.answered, total: questions.length })}</p> : null}
          <p className="text-sm text-slate-900">{t("scoreValue", { total: score.total, max: score.max_total })}</p>
          {score.band ? (
            <>
              <p className="text-base font-semibold text-slate-900" data-band={score.band}>
                {tb(BAND_KEYS[score.band])}
              </p>
              <p lang="en" className="text-sm text-slate-700">
                {score.result_text}
              </p>
            </>
          ) : null}
          <ul className="grid gap-1 pt-2 text-xs text-slate-700 sm:grid-cols-3">
            {score.by_domain.map((d) => (
              <li key={d.domain}>{t(`domains.${d.domain}`, { points: d.points, max: d.max })}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2" aria-labelledby="answers-title">
        <h3 id="answers-title" className="font-semibold">
          {t("answersTitle")}
        </h3>
        <ol className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">{questions.map(itemRow)}</ol>
        {safety.length > 0 ? (
          <>
            <h4 className="pt-2 text-sm font-semibold">{t("safetyTitle")}</h4>
            <ol className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
              {safety.map((item, i) => itemRow(item, questions.length + i))}
            </ol>
          </>
        ) : null}
      </section>

      {assessment.status === "submitted" ? <AssessmentReviewForm assessmentId={assessment.id} /> : null}

      {assessment.status === "reviewed" ? (
        <section className="space-y-2" aria-labelledby="review-done">
          <h3 id="review-done" className="font-semibold">
            {t("reviewDone")}
          </h3>
          {assessment.reviewer_note ? (
            <p className="text-sm text-slate-800">
              <span className="font-medium">{t("reviewerNote")}</span> {assessment.reviewer_note}
            </p>
          ) : null}
          <p className="text-sm text-slate-800">{published?.visible_to_guardian ? t("sharedYes") : t("sharedNo")}</p>
          {published ? (
            <>
              <p className="text-xs text-slate-600">{t("summaryTitle", { version: published.version })}</p>
              <ReportPreview markdown={published.content_md} />
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
