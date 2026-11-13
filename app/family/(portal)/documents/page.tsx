import Link from "next/link";
import { DocumentList } from "@/components/documents/DocumentList";
import { UploadDocumentDialog } from "@/components/documents/UploadDocumentDialog";
import { guardianDocumentView } from "@/components/documents/views";
import { FamilyEmptyState } from "@/components/family/FamilyEmptyState";
import { requireGuardianPage } from "@/lib/authz";
import { listGuardianChildren } from "@/lib/children";
import { listGuardianDocuments, listTreatingOrgs } from "@/lib/documents/store";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 023 FR-7: documents of all the guardian's linked children, one section per child.
export default async function FamilyDocumentsPage() {
  const { user } = await requireGuardianPage();
  const [children, t] = await Promise.all([listGuardianChildren(user.id), getT("documents")]);
  if (children.length === 0) return <FamilyEmptyState title={t("title")} message={t("noChildren")} />;

  const ids = children.map(({ child }) => child.id);
  const [rows, orgsByChild] = await Promise.all([
    listGuardianDocuments(ids),
    Promise.all(ids.map(async (childId) => [childId, await listTreatingOrgs(childId)] as const)).then((pairs) => new Map(pairs)),
  ]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-600">{t("intro")}</p>
      </header>
      {children.map(({ child }) => {
        const orgs = orgsByChild.get(child.id) ?? [];
        const heading = t("childTitle", { name: child.display_name });
        return (
          <section key={child.id} aria-labelledby={`docs-${child.id}`} className="space-y-3" data-child={child.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`docs-${child.id}`} className="text-xl font-semibold break-words text-slate-900">
                {heading}
              </h2>
              <Link
                href={`/family/children/${child.id}/documents`}
                className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline"
                aria-label={t("openChild", { name: child.display_name })}
              >
                {t("link")}
              </Link>
            </div>
            <UploadDocumentDialog endpoint={`/api/family/children/${child.id}/documents`} mode="guardian" orgs={orgs} childName={child.display_name} tone="family" />
            <DocumentList
              documents={rows.filter((row) => row.child_id === child.id).map((row) => guardianDocumentView(row, user.id, t))}
              orgs={orgs}
              tone="family"
              label={heading}
            />
          </section>
        );
      })}
    </div>
  );
}
