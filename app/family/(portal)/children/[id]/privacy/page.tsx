import Link from "next/link";
import { DeletionRequestForm } from "@/components/privacy/DeletionRequestForm";
import { ExportPanel } from "@/components/privacy/ExportPanel";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { listChildDeletionRequests } from "@/lib/privacy/deletion";
import { listExports } from "@/lib/privacy/export";

export const dynamic = "force-dynamic";

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

// 041 FR-7 / FR-8: the guardian's privacy page for one child (active link required, else 404).
export default async function ChildPrivacyPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child, session } = await requireChildGuardianPage(id);
  const [t, tr] = [await getT("privacy.family"), await getT()];
  const [exports, requests] = await Promise.all([listExports(child.id, session.user.id), listChildDeletionRequests(child.id)]);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {tr("common.back")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-700">{t("intro", { name: child.display_name })}</p>
      </header>
      <ExportPanel
        childId={child.id}
        name={child.display_name}
        exports={exports.map((e) => ({ id: e.id, status: e.status, createdAt: iso(e.created_at) as string, expiresAt: iso(e.expires_at) }))}
      />
      <DeletionRequestForm
        childId={child.id}
        name={child.display_name}
        requests={requests.map((r) => ({
          id: r.id,
          scope: r.scope,
          status: r.status,
          createdAt: iso(r.created_at) as string,
          reviewNote: r.status === "rejected" ? r.review_note : null,
        }))}
      />
      <Link href="/privacy" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
        {t("noticeLink")}
      </Link>
    </div>
  );
}
