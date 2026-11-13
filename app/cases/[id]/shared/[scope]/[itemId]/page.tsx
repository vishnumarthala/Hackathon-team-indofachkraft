import Link from "next/link";
import { notFound } from "next/navigation";
import { ReportPreview } from "@/components/report/ReportEditor";
import { requireCasePage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";
import { isShareScope } from "@/lib/sharing/scopes";
import { openSharedItem } from "@/lib/sharing/shared";

export const dynamic = "force-dynamic";

// 022 FR-6: one shared item, read only. Every view audits `sharing.viewed` { grant_id, scope, item_id } (strict).
export default async function SharedItemPage({ params }: { params: Promise<{ id: string; scope: string; itemId: string }> }) {
  const { id, scope, itemId } = await params;
  const { user } = await requireCasePage(id);
  if (!isShareScope(scope)) notFound();
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) notFound();

  const opened = await openSharedItem(user.id, { id: caseRow.id, org_id: caseRow.org_id, child_id: caseRow.child_id }, scope, itemId);
  if (!opened) notFound();
  const [t, ts, format] = await Promise.all([getT("sharedWithUs"), getT("sharing.scopes"), getFormatter()]);
  const { item, sourceOrgName } = opened;

  return (
    <div className="space-y-4">
      <Link href={`/cases/${caseRow.id}/shared`} className="text-sm font-medium text-slate-700 underline">
        {t("back")}
      </Link>
      <header className="space-y-1">
        <p className="text-xs font-medium text-slate-600">{ts(scope)}</p>
        <h2 className="text-lg font-semibold break-words">{item.title}</h2>
        <p className="text-sm text-slate-700">
          {t("readOnly", { org: sourceOrgName })} · {format.date(item.date, "long")}
        </p>
      </header>
      {item.body.kind === "markdown" ? (
        <ReportPreview markdown={item.body.markdown} />
      ) : (
        <a href={item.body.url} className="font-medium text-slate-900 underline" rel="noreferrer">
          {item.body.fileName}
        </a>
      )}
    </div>
  );
}
