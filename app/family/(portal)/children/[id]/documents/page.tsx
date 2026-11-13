import Link from "next/link";
import { DocumentList } from "@/components/documents/DocumentList";
import { UploadDocumentDialog } from "@/components/documents/UploadDocumentDialog";
import { guardianDocumentView } from "@/components/documents/views";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { listGuardianDocuments, listTreatingOrgs } from "@/lib/documents/store";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 023 FR-7: one child's documents (active link required, else 404), upload, download, delete and sharing.
export default async function ChildDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child, session } = await requireChildGuardianPage(id);
  const [rows, orgs, t] = await Promise.all([listGuardianDocuments([child.id]), listTreatingOrgs(child.id), getT("documents")]);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("childTitle", { name: child.display_name })}</h1>
        <p className="text-slate-600">{t("childIntro", { name: child.display_name })}</p>
      </header>
      <UploadDocumentDialog endpoint={`/api/family/children/${child.id}/documents`} mode="guardian" orgs={orgs} childName={child.display_name} tone="family" />
      <DocumentList
        documents={rows.map((row) => guardianDocumentView(row, session.user.id, t))}
        orgs={orgs}
        tone="family"
        label={t("childTitle", { name: child.display_name })}
      />
    </div>
  );
}
