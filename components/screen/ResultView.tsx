"use client";

import { useT } from "@/lib/i18n/client";
import type { ScreenResult } from "@/lib/screen/questions";
import { NearbyProviders, type LocalityOption } from "./NearbyProviders";
import { SaveResult, type SaveViewer } from "./SaveResult";
import { HEADLINE_KEYS, LEVEL_KEYS, secondaryButton } from "./view";

// Ticket 033 FR-6: band headline, plain text per domain, the "not a diagnosis" line, nearby specialists (029) and
// saving to a child (FR-8). Never rendered for a red flag (FR-7: UrgentNotice only).
export function ResultView({
  sessionId,
  result,
  localities,
  viewer,
  onSaved,
  onRestart,
}: {
  sessionId: string;
  result: ScreenResult;
  localities: LocalityOption[];
  viewer: SaveViewer;
  onSaved: () => void;
  onRestart: () => void;
}) {
  const t = useT("screen.result");
  if (!result.result_band) return null;
  return (
    <div className="space-y-6" data-testid="screen-result" data-band={result.result_band}>
      <section aria-labelledby="screen-result-headline" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <p className="text-sm font-semibold text-teal-800">{t("label")}</p>
        <h2 id="screen-result-headline" className="text-2xl font-bold text-slate-900">
          {t(`headlines.${HEADLINE_KEYS[result.result_band]}`)}
        </h2>
        <p className="font-medium text-slate-900">{t("notDiagnosis")}</p>
        <h3 className="pt-2 font-semibold text-slate-900">{t("domainsTitle")}</h3>
        <dl className="space-y-2">
          {result.domains.map((d) => (
            <div key={d.domain} className="rounded-xl bg-slate-50 px-3 py-2" data-domain={d.domain} data-level={d.level}>
              <dt className="font-medium text-slate-900">{t(`domains.${d.domain}`)}</dt>
              <dd className="text-slate-700">{t(`levels.${LEVEL_KEYS[d.level]}`)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <NearbyProviders localities={localities} />
      <SaveResult sessionId={sessionId} viewer={viewer} onSaved={onSaved} />
      <button type="button" className={secondaryButton} onClick={onRestart}>
        {t("startAgain")}
      </button>
    </div>
  );
}
