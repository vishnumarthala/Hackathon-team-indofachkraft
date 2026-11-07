import type { ReactNode } from "react";
import { EvidenceTimestamp } from "@/components/referral/EvidencePlayer";
import { ratingLabel } from "@/lib/isaa";
import { redFlagText, scoreFromPacket, sessionLabel, type ReferralPacket } from "@/lib/referral/packet";
import { formatIsaaScore, SUGGESTION_LABEL, type FacpBand } from "@/lib/scoring";

const FACP_BAND_LABELS: Record<FacpBand, string> = {
  typical: "Typical",
  borderline: "Borderline",
  moderate: "Moderate",
  severe: "Severe",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

/** Read-only referral packet for the specialist page. Only confirmed/edited facts are in a packet. */
export function PacketView({ packet, reason, sentAt }: { packet: ReferralPacket; reason: string; sentAt: string }) {
  const { isaa, facp, recommendation } = packet;
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold break-words">Referral: {packet.child_alias}</h1>
        <p className="text-sm text-slate-700">
          From {packet.therapist} · {sentAt}
          {packet.child_age_months != null && <> · Child age {packet.child_age_months} months</>}
        </p>
      </header>

      <Section title="Reason">
        <p className="whitespace-pre-wrap text-slate-900">{reason}</p>
        <p className="text-slate-800">{packet.summary.reason_for_referral}</p>
      </Section>

      <Section title="Summary">
        <p className="text-slate-900">{packet.summary.summary}</p>
      </Section>

      {packet.summary.questions_for_specialist.length > 0 && (
        <Section title="Questions for the specialist">
          <ol className="list-decimal space-y-1 pl-6 text-slate-900">
            {packet.summary.questions_for_specialist.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </Section>
      )}

      <Section title="ISAA">
        <p className="font-medium text-slate-900">{formatIsaaScore(scoreFromPacket(isaa))}</p>
        <table className="w-full max-w-lg border-collapse text-sm">
          <caption className="pb-1 text-left text-slate-600">Domain scores are sums of items confirmed by the therapist.</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="py-1 pr-4 font-medium">Domain</th>
              <th scope="col" className="py-1 pr-4 font-medium">Confirmed sum</th>
              <th scope="col" className="py-1 font-medium">Max</th>
            </tr>
          </thead>
          <tbody>
            {isaa.by_domain.map((d) => (
              <tr key={d.domain_id} className="border-b border-slate-100">
                <td className="py-1 pr-4">{d.name}</td>
                <td className="py-1 pr-4">{d.score}</td>
                <td className="py-1">{d.max}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {facp.score !== null && (
        <Section title="FACP">
          <p className="text-slate-900">
            FACP score: {facp.score}
            {facp.band && <> · {FACP_BAND_LABELS[facp.band]}</>}
          </p>
        </Section>
      )}

      <Section title="Red flags">
        {packet.red_flags.length === 0 ? (
          <p className="text-slate-700">No red flags documented.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-6 text-red-800">
            {packet.red_flags.map((flag) => (
              <li key={flag.type}>{redFlagText(flag)}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recommendation">
        <div className="rounded border border-sky-200 bg-sky-50 p-4 text-sky-950">
          <p className="font-medium">
            {recommendation.referral_recommended ? "Referral recommended" : "No referral rule triggered"}
          </p>
          {recommendation.reasons.length > 0 && (
            <ul className="mt-1 list-disc pl-6">
              {recommendation.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className="mt-2">Suggested action: {recommendation.action}</p>
          <p className="mt-2 text-sm italic">{SUGGESTION_LABEL}</p>
        </div>
      </Section>

      <Section title="Key evidence">
        {packet.key_evidence.length === 0 ? (
          <p className="text-slate-700">No verified quotes among the confirmed items.</p>
        ) : (
          <ul className="space-y-4">
            {packet.key_evidence.map((ev) => (
              <li key={ev.fact_id} className="rounded border border-slate-200 p-3">
                <p className="font-medium text-slate-900">
                  {ev.item_id}. {ev.item_text} - {ratingLabel(ev.rating)}
                </p>
                <blockquote className="mt-1 border-l-4 border-slate-300 pl-3 text-slate-800">
                  &ldquo;{ev.quote}&rdquo;
                </blockquote>
                <div className="mt-2">
                  <EvidenceTimestamp
                    recordingId={ev.recording_id}
                    startSec={ev.start_sec}
                    label={sessionLabel(ev.session_number, ev.start_sec)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Parent-reported at intake">
        {packet.intake_highlights.length === 0 ? (
          <p className="text-slate-700">No intake answers recorded.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-6 text-slate-900">
            {packet.intake_highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
