import type { Metadata } from "next";
import { AdminNav } from "@/components/admin/AdminNav";
import { VoiceCapsForm } from "@/components/admin/VoiceCapsForm";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { opsOverview } from "@/lib/privacy/ops";
import { VOICE_AGENTS } from "@/lib/voice/constants";
import { voiceUsageOverview } from "@/lib/voice/usage";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("privacy.admin.ops");
  return { title: t("title") };
}

// 041 FR-12: operations status for platform admins (counts and ids only). Other roles: 404.
// 051 FR-10: plus the voice usage card (minutes per agent, estimated cost, top users by id and role, blocked starts)
// and the runtime voice budget caps.
export default async function AdminOpsPage() {
  await requirePlatformAdminPage();
  const [t, format] = [await getT("privacy.admin.ops"), await getFormatter()];
  const [o, v] = await Promise.all([opsOverview(), voiceUsageOverview()]);
  const card = "space-y-2 rounded border border-slate-200 bg-white p-4";
  const row = (label: string, value: string | number, testId: string) => (
    <div key={testId} className="flex justify-between gap-4 text-sm">
      <dt className="text-slate-700">{label}</dt>
      <dd className="font-mono tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <AdminNav current="ops" />
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="ops-outbox" className={card}>
          <h2 id="ops-outbox" className="font-semibold text-slate-900">{t("outbox")}</h2>
          <dl className="space-y-1">
            {row(t("pendingEvents"), o.outbox.pendingEvents, "ops-pending-events")}
            {row(t("oldestPending"), o.outbox.oldestPendingMinutes ?? "-", "ops-oldest-pending")}
            {["pending", "sending", "failed", "dead"].map((s) => row(`${t("deliveries")}: ${s}`, o.outbox.notifications[s] ?? 0, `ops-notifications-${s}`))}
          </dl>
        </section>
        <section aria-labelledby="ops-retention" className={card}>
          <h2 id="ops-retention" className="font-semibold text-slate-900">{t("retention")}</h2>
          <dl className="space-y-1">
            {row(t("lastRun"), o.retention.lastRunAt ? format.dateTime(o.retention.lastRunAt) : t("never"), "ops-retention-last-run")}
            {Object.entries(o.retention.counts ?? {}).map(([k, v]) => row(k, v, `ops-retention-${k}`))}
          </dl>
        </section>
        <section aria-labelledby="ops-privacy" className={card}>
          <h2 id="ops-privacy" className="font-semibold text-slate-900">{t("privacy")}</h2>
          <dl className="space-y-1">
            {row(t("openRequests"), o.privacy.openRequests, "ops-open-requests")}
            {row(t("failedRequests"), o.privacy.failedRequests, "ops-failed-requests")}
            {row(t("queuedExports"), o.privacy.queuedExports, "ops-queued-exports")}
            {row(t("failedExports"), o.privacy.failedExports, "ops-failed-exports")}
            {row(t("processorFailures"), o.privacy.failedProcessorDeletions.length, "ops-processor-failures")}
          </dl>
          {o.privacy.failedProcessorDeletions.length > 0 ? (
            <ul className="space-y-1 font-mono text-xs text-slate-700">
              {o.privacy.failedProcessorDeletions.map((p) => (
                <li key={p.id}>
                  {p.processor} {p.status} {p.response_code ?? "-"} x{p.attempts} req {p.request_id.slice(0, 8)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section aria-labelledby="ops-voice" className={`${card} md:col-span-2`} data-testid="ops-voice">
          <h2 id="ops-voice" className="font-semibold text-slate-900">{t("voiceTitle")}</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-slate-700">
                <tr>
                  <th scope="col" className="py-1 pr-4">{t("voiceAgent")}</th>
                  <th scope="col" className="py-1 pr-4 text-right">{t("voiceToday")}</th>
                  <th scope="col" className="py-1 text-right">{t("voiceMonth")}</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {VOICE_AGENTS.map((a) => (
                  <tr key={a} className="border-t border-slate-100">
                    <th scope="row" className="py-1 pr-4 font-sans font-normal text-slate-700">{t(`voiceAgents.${a}`)}</th>
                    <td className="py-1 pr-4 text-right" data-testid={`ops-voice-today-${a}`}>{v.today[a].minutes}</td>
                    <td className="py-1 text-right" data-testid={`ops-voice-month-${a}`}>{v.month[a].minutes}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-300 font-semibold">
                  <th scope="row" className="py-1 pr-4 font-sans text-slate-900">{t("voiceTotal")}</th>
                  <td className="py-1 pr-4 text-right" data-testid="ops-voice-today-total">{v.totals.todayMinutes}</td>
                  <td className="py-1 text-right" data-testid="ops-voice-month-total">{v.totals.monthMinutes}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <dl className="space-y-1">
            {row(t("voiceCostToday"), t("voiceCostValue", { usd: v.cost.todayUsd.toFixed(2), inr: v.cost.todayInr.toFixed(2) }), "ops-voice-cost-today")}
            {row(t("voiceCostMonth"), t("voiceCostValue", { usd: v.cost.monthUsd.toFixed(2), inr: v.cost.monthInr.toFixed(2) }), "ops-voice-cost-month")}
            {row(t("voiceBlocked"), `${v.blocked.today} / ${v.blocked.month}`, "ops-voice-blocked")}
          </dl>
          <p className="text-xs text-slate-600">{t("voiceRate", { usd: v.cost.usdPerMinute, inr: v.cost.usdInr })}</p>
          <h3 className="pt-2 text-sm font-semibold text-slate-900">{t("voiceTopUsers")}</h3>
          {v.topUsers.length === 0 ? (
            <p className="text-sm text-slate-700">{t("none")}</p>
          ) : (
            <ol className="space-y-1 font-mono text-xs text-slate-700" data-testid="ops-voice-top-users">
              {v.topUsers.map((u) => (
                <li key={u.user_id} className="flex justify-between gap-4">
                  <span className="break-all">{u.user_id} ({u.role ?? "-"})</span>
                  <span className="tabular-nums">{u.minutes}</span>
                </li>
              ))}
            </ol>
          )}
          <h3 className="pt-2 text-sm font-semibold text-slate-900">{t("voiceCaps")}</h3>
          <p className="text-sm text-slate-700" data-testid="ops-voice-caps">
            {t("voiceCapInUse", { daily: v.caps.dailyMinutes, monthly: v.caps.monthlyMinutes })}
          </p>
          <VoiceCapsForm
            dailyOverride={v.caps.overridden.daily ? v.caps.dailyMinutes : null}
            monthlyOverride={v.caps.overridden.monthly ? v.caps.monthlyMinutes : null}
            envDaily={v.caps.envDailyMinutes}
            envMonthly={v.caps.envMonthlyMinutes}
          />
        </section>
        <section aria-labelledby="ops-stuck" className={card}>
          <h2 id="ops-stuck" className="font-semibold text-slate-900">{t("stuck")}</h2>
          {o.stuckRecordings.length === 0 ? (
            <p className="text-sm text-slate-700" data-testid="ops-stuck-none">{t("none")}</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs text-slate-700" data-testid="ops-stuck">
              {o.stuckRecordings.map((r) => (
                <li key={r.id}>
                  {r.id.slice(0, 8)} {r.status} {t("minutes", { count: r.minutes })}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
