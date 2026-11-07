import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EvidencePlayerProvider } from "@/components/referral/EvidencePlayer";
import { PacketView } from "@/components/referral/PacketView";
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

  const audioUrls = await getAudioUrls(referral.case_id);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <EvidencePlayerProvider audioUrls={audioUrls}>
        <PacketView packet={packet} reason={referral.reason} sentAt={formatDate(packet.generated_at)} />
      </EvidencePlayerProvider>
      <footer className="mt-10 border-t border-slate-200 pt-4 text-sm text-slate-600">
        Prepared with CareThread. AI documents, the clinician decides. This is not a diagnosis by AI.
      </footer>
    </div>
  );
}
