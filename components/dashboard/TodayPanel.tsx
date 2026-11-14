// Ticket 052 FR-4 (Figma /dashboard — Cases 18:11): the four stat cards, then the Today panel (today's sessions with
// one-tap attendance and `Write note`, and the To-do counts with links). Server components.
import Link from "next/link";
import { NeedsAttention } from "@/components/attendance/NeedsAttention";
import type { DashboardStats, DashboardToday } from "@/lib/dashboard/today";
import { getFormatter, getT } from "@/lib/i18n/server";
import { TodaySessionActions } from "./TodaySessionActions";

const panel = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";

export async function StatCards({ stats }: { stats: DashboardStats }) {
  const t = await getT("dashboard.stats");
  const format = await getFormatter();
  const cards: { key: string; label: string; value: string; hint: string }[] = [
    { key: "children", label: t("activeChildren"), value: format.number(stats.active_children), hint: t("activeChildrenHint") },
    { key: "sessions", label: t("sessionsWeek"), value: format.number(stats.sessions_this_week), hint: t("sessionsWeekHint") },
    {
      key: "attendance",
      label: t("attendance"),
      value: stats.attendance_rate === null ? t("none") : `${format.number(stats.attendance_rate)}%`,
      hint: t("attendanceHint"),
    },
    { key: "home", label: t("homeLogs"), value: format.number(stats.home_logs_this_week), hint: t("homeLogsHint") },
  ];
  return (
    <section aria-label={t("label")}>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="stat-cards">
        {cards.map((c) => (
          <li key={c.key} className={panel} data-stat={c.key}>
            <p className="text-sm font-medium text-slate-600">{c.label}</p>
            <p className="mt-1 text-3xl font-bold text-slate-900">{c.value}</p>
            <p className="mt-1 text-xs text-slate-500">{c.hint}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `caseLinks`: case id -> the case's default tab (FR-5), for the child names. */
export async function TodayPanel({ today, userId, caseLinks }: { today: DashboardToday; userId: string; caseLinks: Record<string, string> }) {
  const t = await getT("dashboard.today");
  const tt = await getT("dashboard.todo");
  const format = await getFormatter();
  const now = new Date().toISOString();
  const showProvider = new Set(today.sessions.map((s) => s.provider_name)).size > 1;
  const open = today.todos.filter((i) => i.count > 0);

  return (
    <section aria-labelledby="today-title" className="space-y-4" data-testid="today-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="today-title" className="text-xl font-semibold text-slate-900">
          {t("title")}
        </h2>
        <p className="text-sm text-slate-600">{today.manage ? t("orgScope") : t("ownScope")}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className={`${panel} space-y-3 lg:col-span-2`}>
          <h3 className="font-semibold text-slate-900">{t("sessionsTitle", { count: today.sessions.length })}</h3>
          {today.sessions.length === 0 ? (
            <div className="space-y-2 rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-600">
              <p>{t("empty")}</p>
              <Link href="/dashboard/schedule" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
                {t("emptyAction")}
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="today-sessions">
              {today.sessions.map((s) => (
                <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="today-session">
                  <div className="min-w-0 text-sm">
                    <p className="font-semibold text-slate-900">
                      {format.time(s.starts_at)} - {format.time(s.ends_at)}
                    </p>
                    <p className="break-words text-slate-800">
                      {s.case_id && s.child_name ? (
                        <Link href={caseLinks[s.case_id] ?? `/cases/${s.case_id}`} className="font-medium underline">
                          {s.child_name}
                        </Link>
                      ) : (
                        (s.child_name ?? t("noChild"))
                      )}
                      {" · "}
                      {s.service_name}
                      {s.mode === "video" ? ` · ${t("video")}` : ""}
                      {showProvider ? ` · ${s.provider_name}` : ""}
                    </p>
                  </div>
                  <TodaySessionActions
                    id={s.id}
                    startsAt={s.starts_at}
                    status={s.status}
                    attendance={s.attendance}
                    caseId={s.case_id}
                    mode={s.mode}
                    hasNote={s.has_note}
                    registerHref={`/dashboard/register?org=${s.org_id}&date=${today.date}`}
                    now={now}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={`${panel} space-y-3`}>
          <h3 className="font-semibold text-slate-900">{tt("title")}</h3>
          {open.length === 0 ? (
            <p className="text-sm text-slate-600" data-testid="todo-empty">
              {tt("allDone")}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="todo-list">
              {open.map((item) => (
                <li key={item.key} data-todo={item.key} data-count={item.count}>
                  <Link href={item.key === "attendance" ? "#needs-attention" : item.href} className="flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 text-sm hover:bg-slate-50">
                    <span className="text-slate-900">{tt(`items.${item.key}`, { count: item.count })}</span>
                    <span aria-hidden="true" className="text-teal-800">
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {/* 044 FR-4: the unmarked sessions themselves (renders nothing when there are none). */}
      <NeedsAttention userId={userId} />
    </section>
  );
}
