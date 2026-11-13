import Link from "next/link";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { sectionsOf } from "@/lib/health/schema";
import { getFormatter, getT } from "@/lib/i18n/server";
import { listHealthHistory } from "@/lib/queries/health";

export const dynamic = "force-dynamic";

// 021 FR-6: every saved version (date, by, changed sections); each opens read only.
export default async function ChildHealthHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const [entries, t, th, ts, format] = await Promise.all([
    listHealthHistory(child.id),
    getT("health"),
    getT("health.history"),
    getT("health.sections"),
    getFormatter(),
  ]);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}/health`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {th("back")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{th("title")}</h1>
        <p className="text-slate-700">{th("intro", { name: child.display_name })}</p>
      </header>
      {entries.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 p-4 text-slate-700">{th("empty")}</p>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry, index) => {
            const sections = sectionsOf(entry.changed_fields);
            const date = format.dateTime(entry.changed_at);
            return (
              <li key={entry.version} className="space-y-1 rounded-2xl border border-slate-200 bg-white p-4" data-version={entry.version}>
                <h2 className="font-semibold text-slate-900">
                  {th("version", { version: entry.version })}
                  {index === 0 ? <span className="ml-2 text-sm font-normal text-teal-800">{th("current")}</span> : null}
                </h2>
                <p className="text-sm text-slate-700">
                  {entry.changed_by_name ? th("savedBy", { date, name: entry.changed_by_name }) : th("savedOn", { date })}
                </p>
                <p className="text-sm text-slate-700">
                  {sections.length > 0 ? th("changed", { sections: sections.map((s) => ts(s)).join(", ") }) : th("nothingChanged")}
                </p>
                <Link
                  href={index === 0 ? `/family/children/${child.id}/health` : `/family/children/${child.id}/health/history/${entry.version}`}
                  className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
                  aria-label={th("viewVersion", { version: entry.version })}
                >
                  {index === 0 ? t("title") : th("view")}
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
