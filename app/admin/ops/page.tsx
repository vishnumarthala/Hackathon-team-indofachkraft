import type { Metadata } from "next";
import { AdminNav } from "@/components/admin/AdminNav";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { opsOverview } from "@/lib/privacy/ops";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("privacy.admin.ops");
  return { title: t("title") };
}

// 041 FR-12: operations status for platform admins (counts and ids only). Other roles: 404.
export default async function AdminOpsPage() {
  await requirePlatformAdminPage();
  const [t, format] = [await getT("privacy.admin.ops"), await getFormatter()];
  const o = await opsOverview();
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
