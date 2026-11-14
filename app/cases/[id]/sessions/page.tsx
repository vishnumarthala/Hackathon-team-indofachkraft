import Link from "next/link";
import { notFound } from "next/navigation";
import { getCase, listSessions } from "@/lib/queries/cases";
import { requireCasePage } from "@/lib/authz";
import { listCaseGoalSummary, type GoalSummary } from "@/lib/cases/goal-summary";
import { getFormatter, getT } from "@/lib/i18n/server";
import { Button } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

// 052 FR-5: for children past their assessment this is the case's default tab (lib/cases/default-tab.ts), so it leads
// with weekly value: goal progress (025) and the session notes. ISAA review stays inside each ISAA session.
export default async function SessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();
  const [sessions, goals] = await Promise.all([listSessions(id), listCaseGoalSummary(id)]);
  const t = await getT("scribe");
  const tc = await getT("caseSessions");
  const ti = await getT("iep.values");
  const format = await getFormatter();

  const value = (g: GoalSummary, v: number) => {
    if (g.measure_type === "percent") return ti("percent", { value: format.number(v) });
    if (g.measure_type === "rating_1_5") return ti("rating", { value: format.number(v) });
    if (g.measure_type === "yes_no") return v >= 1 ? ti("yes") : ti("no");
    return format.number(v);
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="goal-progress" className="space-y-3" data-testid="goal-progress">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="goal-progress" className="text-lg font-semibold">
            {tc("goalsTitle")}
          </h2>
          <Link href={`/cases/${id}/goals`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
            {tc("goalsAction")}
          </Link>
        </div>
        {goals.length === 0 ? (
          <div className="space-y-2 rounded border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            <p>{tc("goalsEmpty")}</p>
            <Link href={`/cases/${id}/goals`} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
              {tc("goalsEmptyAction")}
            </Link>
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {goals.map((g) => (
              <li key={g.id} className="space-y-1 rounded border border-slate-200 p-3 text-sm">
                <p className="font-medium break-words text-slate-900">{g.statement}</p>
                <p className="text-slate-700">
                  {g.latest ? tc("latest", { value: value(g, g.latest.value), date: format.date(`${g.latest.observed_on}T12:00:00Z`) }) : tc("noProgress")}
                  {g.target_value !== null ? ` · ${tc("target", { value: value(g, g.target_value) })}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="session-list" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="session-list" className="text-lg font-semibold">
            {tc("notesTitle")}
          </h2>
          <Button href={`/cases/${id}/sessions/new`}>{tc("newSession")}</Button>
        </div>
        {sessions.length === 0 ? (
          <div className="space-y-2 rounded border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            <p>{tc("empty")}</p>
            <Link href={`/cases/${id}/sessions/new`} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
              {tc("emptyAction")}
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-medium">{tc("session", { number: s.session_number ?? "-" })}</span>
                <span className="text-slate-600">{t(`templates.${s.template ?? "child_dev_isaa"}`)}</span>
                <span className="text-slate-600">{s.status}</span>
                <span className="text-slate-600">{format.date(s.created_at)}</span>
                <Link href={`/cases/${id}/sessions/${s.id}`} className="inline-flex min-h-11 items-center underline">
                  {tc("open")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
