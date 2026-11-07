import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AskTheCase } from "@/components/referral/AskTheCase";
import { EvidencePlayerProvider } from "@/components/referral/EvidencePlayer";
import { PacketView } from "@/components/referral/PacketView";
import { audioPlayableUntil } from "@/lib/ask/citations";
import { listQuestions } from "@/lib/ask/questions";
import { audit } from "@/lib/audit";
import { formatDate } from "@/lib/cases/format";
import { getAudioUrls, getReferralByToken, markReferralViewed } from "@/lib/queries/referrals";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Referral - CareThread",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SpecialistPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await getReferralByToken(token);
  if (!shared) notFound();
  const { referral, packet } = shared;

  if (referral.status === "sent" && (await markReferralViewed(referral.id))) {
    await audit({
      caseId: referral.case_id,
      actor: "specialist",
      action: "referral.viewed",
      entity: "referral",
      entityId: referral.id,
    });
  }

  const [audioUrls, questions] = await Promise.all([getAudioUrls(referral.case_id), listQuestions(referral.id)]);
  const audioExpiresAt = audioPlayableUntil();

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <EvidencePlayerProvider audioUrls={audioUrls}>
        <PacketView packet={packet} reason={referral.reason} sentAt={formatDate(packet.generated_at)} />
        <AskTheCase
          caseId={referral.case_id}
          shareToken={token}
          initialQuestions={questions.map(({ id, question, found, answer, citations }) => ({
            id,
            question,
            found,
            answer,
            citations,
          }))}
          audioExpiresAt={audioExpiresAt}
        />
      </EvidencePlayerProvider>
      <footer className="mt-10 border-t border-slate-200 pt-4 text-sm text-slate-600">
        Prepared with CareThread. AI documents, the clinician decides. This is not a diagnosis by AI.
      </footer>
    </div>
  );
}
