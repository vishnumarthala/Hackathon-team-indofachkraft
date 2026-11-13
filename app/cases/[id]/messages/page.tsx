import { notFound } from "next/navigation";
import { EmergencyBanner } from "@/components/messaging/EmergencyBanner";
import { LiveThreadsRefresher } from "@/components/messaging/LiveThreadsRefresher";
import { NewThreadForm } from "@/components/messaging/NewThreadForm";
import { ThreadList } from "@/components/messaging/ThreadList";
import { requireCasePage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { caseHasGuardian, listThreads } from "@/lib/messaging/store";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 027 FR-4: case workspace `Messages` tab - this case's conversations with the child's family.
export default async function CaseMessagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();
  const [threads, hasGuardian, t] = await Promise.all([listThreads(user.id, { caseId: caseRow.id }), caseHasGuardian(caseRow.id), getT("messaging")]);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("caseIntro")}</p>
      </div>
      <EmergencyBanner />
      <LiveThreadsRefresher endpoint={`/api/threads?case_id=${caseRow.id}`} />
      {hasGuardian ? (
        <NewThreadForm cases={[{ id: caseRow.id, label: "" }]} hrefBase={`/cases/${caseRow.id}/messages`} tone="provider" />
      ) : (
        <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{t("noGuardian")}</p>
      )}
      <ThreadList threads={threads} hrefBase={`/cases/${caseRow.id}/messages`} show="child" label={t("threadsLabel")} />
    </div>
  );
}
