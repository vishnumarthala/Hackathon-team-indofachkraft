import Link from "next/link";
import { notFound } from "next/navigation";
import { DocumentList } from "@/components/documents/DocumentList";
import { UploadDocumentDialog } from "@/components/documents/UploadDocumentDialog";
import { caseDocumentView } from "@/components/documents/views";
import { getCaseAccessLevel, requireCasePage } from "@/lib/authz";
import { listCaseDocuments } from "@/lib/documents/store";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";
import { documentsLoader } from "@/lib/sharing/loaders/documents";
import { getActiveGrants, sourceOrgIdsOf } from "@/lib/sharing/access";
import { orgNames } from "@/lib/sharing/shared";

export const dynamic = "force-dynamic";

// 023 FR-8: the case's documents (upload with `Parent can see this document`), family uploads shared with the
// case's organisation, and provider documents of other organisations shared by a `documents` grant (read only).
export default async function CaseDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) notFound();

  const [rows, level, grants, t, tShared, format] = await Promise.all([
    listCaseDocuments(caseRow.id),
    getCaseAccessLevel(user.id, caseRow.id),
    getActiveGrants(user.id, caseRow.child_id, "documents", caseRow.org_id),
    getT("documents"),
    getT("sharedWithUs"),
    getFormatter(),
  ]);
  const shared = await documentsLoader.list({ childId: caseRow.child_id, sourceOrgIds: sourceOrgIdsOf(grants) });
  const names = await orgNames([...new Set(shared.map((item) => item.sourceOrgId))]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("caseIntro")}</p>
      </div>
      <UploadDocumentDialog endpoint={`/api/cases/${caseRow.id}/documents`} mode="provider" tone="provider" />
      <DocumentList
        documents={rows.map((row) => caseDocumentView(row, user.id, level === "manage", t))}
        tone="provider"
        label={t("title")}
      />

      <section aria-labelledby="docs-shared-heading" className="space-y-2">
        <h3 id="docs-shared-heading" className="text-base font-semibold">
          {t("sharedWithUs")}
        </h3>
        <p className="text-sm text-slate-700">{t("sharedWithUsIntro")}</p>
        {shared.length === 0 ? (
          <p className="text-sm text-slate-600">{t("noShared")}</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white" aria-label={t("sharedWithUs")}>
            {shared.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-shared-document={item.id}>
                <span className="break-words">
                  {item.title}{" "}
                  <span className="text-slate-600">
                    · {t("sharedFrom", { org: names.get(item.sourceOrgId) ?? "" })} · {format.date(item.date, "short")}
                  </span>
                </span>
                <Link
                  href={`/cases/${caseRow.id}/shared/documents/${item.id}`}
                  className="font-medium text-slate-900 underline"
                  aria-label={`${tShared("open")}: ${item.title}`}
                >
                  {tShared("open")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
