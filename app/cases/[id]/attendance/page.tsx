import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCasePage } from "@/lib/authz";
import { listCaseAttendance } from "@/lib/booking/attendance";
import { hasStarted } from "@/lib/booking/display";
import { addMonths, effectiveAttendance, isValidMonth, monthCounts, monthGrid, monthOf, type Attendance } from "@/lib/booking/attendance-display";
import { HTML_LANG } from "@/lib/i18n/config";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";
import { Button } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

const DOT: Record<Attendance | "unmarked" | "upcoming", string> = {
  present: "bg-emerald-700 text-white",
  absent: "bg-red-700 text-white",
  late_cancel_family: "bg-amber-200 text-amber-950",
  cancelled_centre: "bg-slate-600 text-white",
  unmarked: "border border-amber-500 bg-white text-amber-900",
  upcoming: "border border-slate-300 bg-white text-slate-700",
};

// 044 FR-6: the case's `Attendance` tab - a month calendar (Monday first, viewer's time zone) with attended / absent /
// cancelled counts, the sessions of the month, and `Download CSV` for staff. Case access (022) via the layout's gate.
export default async function CaseAttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();
  const t = await getT("attendance");
  const format = await getFormatter();
  const requested = (await searchParams).month;
  const month = isValidMonth(requested) ? requested : monthOf(new Date(), format.timeZone);
  const rows = await listCaseAttendance({ id: caseRow.id, org_id: caseRow.org_id, child_id: caseRow.child_id ?? null }, month, format.timeZone);
  const counts = monthCounts(rows);
  const monthLabel = new Intl.DateTimeFormat(HTML_LANG[format.locale], { month: "long", year: "numeric", timeZone: "UTC", numberingSystem: "latn" }).format(new Date(`${month}-15T12:00:00Z`));
  const weekdayFmt = new Intl.DateTimeFormat(HTML_LANG[format.locale], { weekday: "short", timeZone: "UTC", numberingSystem: "latn" });
  // 2024-01-01 was a Monday.
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(Date.UTC(2024, 0, 1 + i, 12))));
  const kindOf = (r: (typeof rows)[number]) => effectiveAttendance(r) ?? (hasStarted(r.starts_at) ? "unmarked" : "upcoming");
  const label = (k: ReturnType<typeof kindOf>) =>
    k === "unmarked" ? t("caseTab.notMarked") : k === "upcoming" ? t("caseTab.upcoming") : t(`values.${k}`);
  const base = `/cases/${caseRow.id}/attendance`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{monthLabel}</h2>
          <p className="text-sm text-slate-700">{t("caseTab.intro")}</p>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm" aria-label={t("caseTab.title")}>
          <Link href={`${base}?month=${addMonths(month, -1)}`} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3">
            {t("caseTab.previous")}
          </Link>
          <Link href={`${base}?month=${addMonths(month, 1)}`} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3">
            {t("caseTab.next")}
          </Link>
          <Button asChild>
            <a
              href={`/api/cases/${caseRow.id}/attendance?month=${month}&format=csv`}
              data-testid="attendance-csv"
            >
              {t("caseTab.export")}
            </a>
          </Button>
        </nav>
      </div>

      <p className="font-medium text-slate-900" data-testid="attendance-counts">
        {t("caseTab.counts", counts)}
      </p>

      <table className="w-full table-fixed border-collapse text-center text-xs" aria-label={t("caseTab.calendar", { month: monthLabel })}>
        <thead>
          <tr>
            {weekdays.map((d) => (
              <th key={d} scope="col" className="py-1 font-medium text-slate-600">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(month).map((week, i) => (
            <tr key={i}>
              {week.map((day, j) => {
                const items = day ? rows.filter((r) => r.local_date === day) : [];
                return (
                  <td key={j} className="h-14 border border-slate-200 align-top">
                    {day ? (
                      <div className="flex flex-col items-center gap-0.5 p-0.5">
                        <span className="text-slate-700">{Number(day.slice(8))}</span>
                        {items.map((r) => {
                          const k = kindOf(r);
                          return (
                            <span key={r.id} className={`inline-block h-3 w-3 rounded-full ${DOT[k]}`} title={label(k)}>
                              <span className="sr-only">{label(k)}</span>
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <section aria-labelledby="attendance-sessions" className="space-y-2">
        <h3 id="attendance-sessions" className="font-semibold text-slate-900">
          {t("caseTab.sessions")}
        </h3>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-600">{t("caseTab.none")}</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white text-sm">
            {rows.map((r) => {
              const k = kindOf(r);
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="text-slate-900">
                    {format.dateTime(r.starts_at)} · {r.service_name} · {r.provider_name}
                  </span>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${DOT[k]}`}>
                    {label(k)}
                    {r.billable !== null ? ` · ${r.billable ? t("register.billable") : t("register.notBillable")}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
