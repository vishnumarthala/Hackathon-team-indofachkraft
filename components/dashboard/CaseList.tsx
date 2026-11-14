// Ticket 052 FR-4 (Figma /dashboard — Cases 18:11): the case list under the Today panel, translated, with the filter
// chips All / Needs review / Booked / Referred and a search (plain GET form, no client code). Links open each case on
// its default tab (FR-5). Server component.
import Link from "next/link";
import { getFormatter, getT } from "@/lib/i18n/server";
import { CASE_FILTERS, filterCases, type CaseFilter } from "@/lib/dashboard/cases-filter";
import type { CaseRow } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  booked: "bg-slate-100 text-slate-800",
  intake_done: "bg-sky-100 text-sky-800",
  in_assessment: "bg-amber-100 text-amber-900",
  referred: "bg-emerald-100 text-emerald-800",
};
const STATUSES = ["booked", "intake_done", "in_assessment", "referred"] as const;
const LANGUAGES = ["en", "hi", "te"] as const;

export async function CaseList({
  cases,
  filter,
  q,
  caseLinks,
}: {
  cases: Pick<CaseRow, "id" | "status" | "child_alias" | "parent_alias" | "child_age_months" | "language" | "created_at">[];
  filter: CaseFilter;
  q: string;
  caseLinks: Record<string, string>;
}) {
  const t = await getT("dashboard.cases");
  const ts = await getT("dashboard.status");
  const tl = await getT("dashboard.languages");
  const format = await getFormatter();
  const rows = filterCases(cases, filter, q);
  const chipHref = (f: CaseFilter) => {
    const params = new URLSearchParams();
    if (f !== "all") params.set("filter", f);
    if (q) params.set("q", q);
    const query = params.toString();
    return query ? `/dashboard?${query}#cases` : "/dashboard#cases";
  };
  const statusLabel = (s: string) => ((STATUSES as readonly string[]).includes(s) ? ts(s as (typeof STATUSES)[number]) : s);
  const languageLabel = (l: string) => ((LANGUAGES as readonly string[]).includes(l) ? tl(l as (typeof LANGUAGES)[number]) : l);

  return (
    <section id="cases" aria-labelledby="cases-title" className="space-y-3">
      <h2 id="cases-title" className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label={t("filters.label")}>
          <ul className="flex flex-wrap gap-2">
            {CASE_FILTERS.map((f) => (
              <li key={f}>
                <Link
                  href={chipHref(f)}
                  aria-current={filter === f ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
                    filter === f ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                  }`}
                >
                  {t(`filters.${f}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <form action="/dashboard#cases" method="get" role="search" className="flex gap-2">
          {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
          <label htmlFor="case-search" className="sr-only">
            {t("searchLabel")}
          </label>
          <input
            id="case-search"
            name="q"
            type="search"
            defaultValue={q}
            placeholder={t("searchLabel")}
            className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm sm:w-64"
          />
          <button type="submit" className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900 hover:bg-slate-50">
            {t("search")}
          </button>
        </form>
      </div>
      {cases.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">
          <p>{t("empty")}</p>
          <Link href="/cases/new" className="inline-flex min-h-11 items-center rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800">
            {t("emptyAction")}
          </Link>
        </div>
      ) : rows.length === 0 ? (
        <div className="space-y-2 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">
          <p>{t("noMatch")}</p>
          <Link href="/dashboard#cases" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
            {t("showAll")}
          </Link>
        </div>
      ) : (
        <div className="max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm" data-testid="case-table">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <th className="px-3 py-2 font-medium">{t("child")}</th>
                <th className="px-3 py-2 font-medium">{t("age")}</th>
                <th className="px-3 py-2 font-medium">{t("language")}</th>
                <th className="px-3 py-2 font-medium">{t("status")}</th>
                <th className="px-3 py-2 font-medium">{t("created")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t border-slate-200">
                  <td className="px-3 py-2">
                    <Link href={caseLinks[c.id] ?? `/cases/${c.id}`} className="font-medium text-slate-900 underline">
                      {c.child_alias}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{c.child_age_months == null ? "-" : t("ageMonths", { count: c.child_age_months })}</td>
                  <td className="px-3 py-2">{languageLabel(c.language)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[c.status] ?? STATUS_COLORS.booked}`}>
                      {statusLabel(c.status)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{format.date(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
