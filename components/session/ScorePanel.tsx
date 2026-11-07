import facpSchema from "@/schemas/facp.json";
import { SUGGESTION_LABEL, formatIsaaScore, type IsaaScore, type Recommendation } from "@/lib/scoring";

const FACP_LABELS: Record<string, string> = Object.fromEntries(facpSchema.bands.map((b) => [b.id, b.label]));

export function ScorePanel({
  score,
  facpScore,
  recommendation,
}: {
  score: IsaaScore;
  facpScore: number | null;
  recommendation: Recommendation;
}) {
  return (
    <section aria-label="Score" className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <p className="font-semibold text-slate-900">{formatIsaaScore(score, { showSuggested: true })}</p>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm text-slate-700 sm:grid-cols-2">
        {score.by_domain.map((d) => (
          <li key={d.domain_id}>
            {d.name}: {d.score} / {d.max}
          </li>
        ))}
      </ul>
      {facpScore !== null && recommendation.facp_band && (
        <p className="text-sm text-slate-800">
          FACP {facpScore}: {FACP_LABELS[recommendation.facp_band]}
        </p>
      )}
      <div className="rounded bg-slate-50 p-3 text-sm">
        {recommendation.referral_recommended ? (
          <>
            <p className="font-semibold text-red-800">Referral recommended</p>
            <ul className="mt-1 list-disc pl-5 text-slate-800">
              {recommendation.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="font-semibold text-slate-800">No referral rule triggered</p>
        )}
        <p className="mt-2 text-slate-800">{recommendation.action}</p>
        <p className="mt-2 text-xs text-slate-600">{SUGGESTION_LABEL}</p>
      </div>
    </section>
  );
}
