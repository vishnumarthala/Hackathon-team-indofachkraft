"use client";

import { useT } from "@/lib/i18n/client";
import type { ScreenResult } from "@/lib/screen/questions";
import { FollowUp } from "./FollowUp";
import { FreeOptions } from "./FreeOptions";
import { NearbyProviders, type LocalityOption } from "./NearbyProviders";
import { Recommendation } from "./Recommendation";
import { SaveResult, type SaveViewer } from "./SaveResult";
import { HEADLINE_KEYS, LEVEL_KEYS, secondaryButton } from "./view";

// Ticket 033 FR-6: band headline, plain text per domain, the "not a diagnosis" line, nearby specialists (029) and
// saving to a child (FR-8). Never rendered for a red flag (FR-7: UrgentNotice only).
// Ticket 048: then the optional M-CHAT-R/F Follow-Up (moderate), who can help first (FR-6), up to 3 bookable
// providers with free times (FR-10) and the free government options (FR-7).
export function ResultView({
  sessionId,
  result,
  localities,
  viewer,
  onSaved,
  onRestart,
  onUpdated,
  onExpired,
}: {
  sessionId: string;
  result: ScreenResult;
  localities: LocalityOption[];
  viewer: SaveViewer;
  onSaved: () => void;
  onRestart: () => void;
  /** 048: the result after the M-CHAT-R/F Follow-Up. */
  onUpdated?: (result: ScreenResult) => void;
  onExpired?: () => void;
}) {
  const t = useT("screen.result");
  if (!result.result_band || result.red_flag) return null;
  const followUp = result.mchat?.follow_up;
  return (
    <div className="space-y-6" data-testid="screen-result" data-band={result.result_band} data-instrument={result.instrument}>
      <section aria-labelledby="screen-result-headline" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <p className="text-sm font-semibold text-teal-800">{t("label")}</p>
        <h2 id="screen-result-headline" className="text-2xl font-bold text-slate-900">
          {t(`headlines.${HEADLINE_KEYS[result.result_band]}`)}
        </h2>
        <p className="font-medium text-slate-900">{t("notDiagnosis")}</p>
        {result.mchat?.risk === "low" && !followUp?.result ? <p className="text-slate-800">{t("mchat.rescreen")}</p> : null}
        {followUp?.result ? <p className="text-slate-800">{t("mchat.done")}</p> : null}
        {result.domains.length > 0 ? (
          <>
            <h3 className="pt-2 font-semibold text-slate-900">{t("domainsTitle")}</h3>
            <dl className="space-y-2">
              {result.domains.map((d) => (
                <div key={d.domain} className="rounded-xl bg-slate-50 px-3 py-2" data-domain={d.domain} data-level={d.level}>
                  <dt className="font-medium text-slate-900">{t(`domains.${d.domain}`)}</dt>
                  <dd className="text-slate-700">{t(`levels.${LEVEL_KEYS[d.level]}`)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </section>
      {followUp?.offered && !followUp.result && followUp.questions.length > 0 && onUpdated ? (
        <FollowUp sessionId={sessionId} questions={followUp.questions} onResult={onUpdated} onExpired={onExpired ?? onRestart} />
      ) : null}
      {result.recommendation ? <Recommendation recommendation={result.recommendation} /> : null}
      <NearbyProviders key={`${sessionId}:${result.result_band}`} sessionId={sessionId} localities={localities} />
      <FreeOptions />
      <SaveResult sessionId={sessionId} viewer={viewer} onSaved={onSaved} />
      <button type="button" className={secondaryButton} onClick={onRestart}>
        {t("startAgain")}
      </button>
    </div>
  );
}
