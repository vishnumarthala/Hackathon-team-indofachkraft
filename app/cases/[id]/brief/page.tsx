import { notFound } from "next/navigation";
import { IntakeLinkCard } from "@/components/intake/IntakeLinkCard";
import { env } from "@/lib/env";
import { buildIntakeShare } from "@/lib/intake/message";
import { getCase } from "@/lib/queries/cases";
import { hasIntakeRecording } from "@/lib/queries/intake";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const share = caseRow.intake_token ? buildIntakeShare(caseRow, env.NEXT_PUBLIC_APP_URL, caseRow.intake_token) : null;
  const callCompleted = await hasIntakeRecording(caseRow.id);

  return (
    <div className="space-y-6">
      <IntakeLinkCard
        caseId={caseRow.id}
        initialShare={share ? { url: share.url, whatsapp_url: share.whatsapp_url } : null}
        hasParentEmail={Boolean(caseRow.parent_email)}
        callCompleted={callCompleted}
      />
      <div id="brief-section"></div>
    </div>
  );
}
