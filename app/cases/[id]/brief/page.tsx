import { notFound } from "next/navigation";
import { BriefSection } from "@/components/intake/BriefSection";
import { IntakeLinkCard } from "@/components/intake/IntakeLinkCard";
import { hasConsent } from "@/lib/consent";
import { env } from "@/lib/env";
import { briefStateFrom } from "@/lib/intake/briefMarkdown";
import { intakeLinkState } from "@/lib/intake/link";
import { buildIntakeShare } from "@/lib/intake/message";
import { getCase } from "@/lib/queries/cases";
import { getIntakeBrief } from "@/lib/queries/intake";
import { requireCasePage } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  // 020 FR-7/FR-10: expired or revoked links, and links the parent has not allowed (ai_intake_call), are
  // not shown; "Create intake link" then explains the block or issues a new token.
  const consented = caseRow.child_id ? await hasConsent(caseRow.child_id, "ai_intake_call").catch(() => false) : false;
  const share = consented && caseRow.intake_token && intakeLinkState(caseRow) === "active" ? buildIntakeShare(caseRow, env.NEXT_PUBLIC_APP_URL, caseRow.intake_token) : null;
  const intake = await getIntakeBrief(caseRow.id);
  const callCompleted = intake !== null;

  return (
    <div className="space-y-6">
      <IntakeLinkCard
        caseId={caseRow.id}
        initialShare={share ? { url: share.url, whatsapp_url: share.whatsapp_url } : null}
        hasParentEmail={Boolean(caseRow.parent_email)}
        callCompleted={callCompleted}
      />
      <div id="brief-section">
        <BriefSection caseId={caseRow.id} therapistName={caseRow.therapist_name} state={briefStateFrom(intake)} />
      </div>
    </div>
  );
}
