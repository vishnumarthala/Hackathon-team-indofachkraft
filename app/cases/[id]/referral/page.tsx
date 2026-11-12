import { notFound } from "next/navigation";
import { ReferralForm } from "@/components/referral/ReferralForm";
import { formatDate } from "@/lib/cases/format";
import { getReferralContext, listReferrals, specialistUrl } from "@/lib/queries/referrals";
import { assessReferral } from "@/lib/referral/packet";
import { formatIsaaScore, SUGGESTION_LABEL } from "@/lib/scoring";
import { requireCasePage } from "@/lib/authz";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = { sent: "Sent", viewed: "Viewed", revoked: "Revoked" };

export default async function ReferralPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const context = await getReferralContext(id);
  if (!context) notFound();
  const referrals = await listReferrals(id);
  const { caseRow, session } = context;

  const assessment = session
    ? assessReferral({
        isaaFacts: context.isaaFacts,
        facpScore: caseRow.facp_score,
        brief: context.brief,
        intakeFlags: context.intakeFlags,
      })
    : null;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Referral</h2>
        {!session || !assessment ? (
          <p className="mt-2 text-slate-700">Process and confirm a session before referring.</p>
        ) : (
          <div className="mt-3 rounded border border-sky-200 bg-sky-50 p-4 text-sky-950">
            <p className="text-sm text-sky-900">
              Session {session.session_number ?? "?"} · {formatIsaaScore(assessment.score)}
            </p>
            <p className="mt-2 font-semibold">
              {assessment.recommendation.referral_recommended ? "Referral recommended" : "No referral rule triggered"}
            </p>
            {assessment.recommendation.reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-6">
                {assessment.recommendation.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-sm">Suggested action: {assessment.recommendation.action}</p>
            <p className="mt-2 text-sm italic">{SUGGESTION_LABEL}</p>
            {assessment.decided.length === 0 && (
              <p className="mt-2 text-sm text-amber-800">
                Confirm at least one ISAA item in this session before referring.
              </p>
            )}
          </div>
        )}
      </div>

      {session && assessment && (
        <div>
          <h3 className="mb-3 font-semibold">Send to a specialist</h3>
          <ReferralForm caseId={caseRow.id} defaultReason={assessment.recommendation.reasons.join("; ")} />
        </div>
      )}

      <div>
        <h3 className="mb-2 font-semibold">Earlier referrals</h3>
        {referrals.length === 0 ? (
          <p className="text-sm text-slate-600">No referrals yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200">
            {referrals.map((r) => {
              const url = specialistUrl(r.share_token);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                  <span className="font-medium">{r.specialist_name}</span>
                  <span className="text-slate-600">{formatDate(r.created_at)}</span>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-800">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  <a href={url} target="_blank" rel="noreferrer" className="break-all underline">
                    {url}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
