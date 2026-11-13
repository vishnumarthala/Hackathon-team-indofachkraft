import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProviderPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getImport, listImportedChildren } from "@/lib/import/store";
import { formatWeekdays } from "@/lib/import/timetable";
import { canManage, getMembershipRole } from "@/lib/orgs";
import { RegenerateCodes, SchedulePendingButton, UndoButton } from "../ImportClient";

export const dynamic = "force-dynamic";

// 047 FR-4/FR-5: one import: counts, the children it created (consent, family link, code, timetable, notes),
// new codes, and undo within 24 h. Owner/admin of the import's organisation only; everyone else gets a 404.
export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireProviderPage();
  const record = await getImport(id);
  if (!record || !canManage(await getMembershipRole(user.id, record.org_id))) notFound();
  const children = record.undone_at ? [] : await listImportedChildren(id);
  const t = await getT("childImport");
  const format = await getFormatter();
  const consentGiven = Object.fromEntries(children.map((c) => [c.child_id, c.consent_given]));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <Link href="/dashboard/import" className="inline-flex min-h-11 items-center text-sm font-medium underline">
        {t("back")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("detailTitle", { date: format.dateTime(record.created_at) })}</h1>
        <p className="font-medium" data-testid="import-counts">
          {t("resultCounts", { imported: record.imported_count, skipped: record.skipped_count, failed: record.failed_count })}
        </p>
        {record.timetable_pending_count > 0 && !record.undone_at ? (
          <div className="space-y-2">
            <p className="text-sm text-slate-700">{t("timetableSaved", { count: record.timetable_pending_count })}</p>
            {/* 044: weekly series (043) exist now; schedule the timetables this import could not book yet. */}
            <SchedulePendingButton importId={record.id} />
          </div>
        ) : null}
      </header>

      {record.undone_at ? (
        <p className="rounded bg-slate-50 p-3 text-sm text-slate-800">{t("undoneOn", { date: format.dateTime(record.undone_at) })}</p>
      ) : (
        <>
          <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-semibold">{t("regenerate")}</h2>
            <RegenerateCodes importId={record.id} consentGiven={consentGiven} />
          </section>

          <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
            <p className="text-sm text-slate-700">{t("consentIntro")}</p>
            <ol className="divide-y divide-slate-200 rounded border border-slate-200" data-testid="imported-children">
              {children.map((c) => (
                <li key={c.case_id} className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-baseline gap-x-3">
                      <span className="text-slate-600">
                        {t("col.row")} {c.row}
                      </span>
                      <Link href={`/cases/${c.case_id}`} className="break-words font-medium underline">
                        {c.child_name}
                      </Link>
                      {c.date_of_birth ? <span>{c.date_of_birth}</span> : null}
                    </p>
                    <p className="break-words text-slate-700">
                      {t("col.guardian")}: {c.guardian_name}
                      {c.guardian_phone ? ` · ${c.guardian_phone}` : ""}
                    </p>
                    <p data-testid="consent-status">
                      <span className="text-slate-600">{t("col.consent")}:</span>{" "}
                      <span className="font-medium">{c.consent_given ? t("given") : t("notGiven")}</span>
                    </p>
                    <p>
                      <span className="text-slate-600">{t("col.code")}:</span>{" "}
                      {c.guardian_linked
                        ? t("linked")
                        : c.code_expires_at
                          ? t("codeValid", { date: format.dateTime(c.code_expires_at) })
                          : t("noCode")}
                    </p>
                    {c.timetable ? (
                      <p>
                        <span className="text-slate-600">{t("col.timetable")}:</span> {formatWeekdays(c.timetable.weekdays)}{" "}
                        {c.timetable.time} · {c.timetable.service_name} (
                        {c.timetable_status === "scheduled" ? t("timetableScheduled") : t("timetablePendingShort")})
                      </p>
                    ) : null}
                    {c.notes ? (
                      <p className="whitespace-pre-line break-words">
                        <span className="text-slate-600">{t("col.notes")}:</span> {c.notes}
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={`/cases/${c.case_id}/consent/paper`}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-slate-300 bg-white px-4 py-2 font-medium text-slate-900"
                  >
                    {t("paperConsent")}
                  </Link>
                </li>
              ))}
            </ol>
          </section>

          <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-semibold">{t("undo")}</h2>
            {record.undo_open ? (
              <>
                <p className="text-sm text-slate-700">{t("undoUntil", { date: format.dateTime(record.undo_until) })}</p>
                <UndoButton importId={record.id} />
              </>
            ) : (
              <p className="text-sm text-slate-700">{t("undoExpired")}</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
