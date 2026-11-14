import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminCentreForms, RetryButton } from "@/components/payouts/PayoutForms";
import { requirePlatformAdminPage } from "@/lib/authz";
import type { Formatter } from "@/lib/i18n/format";
import { getFormatter, getT } from "@/lib/i18n/server";
import type { FeePolicy } from "@/lib/payouts/fees";
import { invoiceMonthLabel } from "@/lib/payouts/invoice";
import { adminPayoutOverview } from "@/lib/payouts/store";
import { voiceUsageOverview } from "@/lib/voice/usage";
import { Alert } from "@/components/ui/Alert";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("payouts.admin");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

function policyShort(format: Formatter, p: FeePolicy, defaultLabel: string): string {
  const base = p.kind === "flat" ? `${format.inr(p.flat_paise ?? 0)}` : `${format.number((p.percent_bps ?? 0) / 100)}%`;
  const parts = [p.version === 0 ? `${base} (${defaultLabel})` : base];
  if (p.min_paise > 0) parts.push(`min ${format.inr(p.min_paise)}`);
  if (p.cap_paise !== null) parts.push(`cap ${format.inr(p.cap_paise)}`);
  if (p.waived_until) parts.push(`waived to ${format.date(`${p.waived_until}T12:00:00+05:30`)}`);
  return parts.join(", ");
}

// 046 FR-9 (Figma 31:777): platform admins - GMV, platform fee + GST this month, failed transfers, voice minutes today
// (051, full card in /admin/ops); per centre the payout account, fee policy (a new version on each change) and this
// month; failed and on-hold transfers with `Retry`. Every change is strictly audited. Other roles: 404.
export default async function AdminPayoutsPage() {
  await requirePlatformAdminPage();
  const t = await getT("payouts.admin");
  const format = await getFormatter();
  const [o, v] = await Promise.all([adminPayoutOverview(), voiceUsageOverview()]);
  const card = "space-y-1 rounded-xl border border-slate-200 bg-white p-4";
  const cell = "px-4 py-2 align-top";

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <AdminNav current="payouts" />
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
        <p className="text-slate-700">{t("subtitle", { month: invoiceMonthLabel(o.month_from) })}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className={card}>
          <p className="text-sm text-slate-600">{t("gmv")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="admin-gmv">{format.inr(o.gmv_paise)}</p>
          <p className="text-sm text-slate-700">{t("centres", { count: o.orgs.length })}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-slate-600">{t("fee")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="admin-fee">{format.inr(o.fee_paise)}</p>
          <p className="text-sm text-slate-700">{t("gstNote", { amount: format.inr(o.gst_paise) })}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-slate-600">{t("failed")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="admin-failed">{format.number(o.failed_transfers)}</p>
          <p className="text-sm text-teal-800">{t("failedNote")}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-slate-600">{t("voice")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="admin-voice">
            {format.number(v.totals.todayMinutes)} / {format.number(v.caps.dailyMinutes)}
          </p>
          <Link href="/admin/ops" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">{t("voiceLink")}</Link>
        </div>
      </div>

      {o.open_reconciliation_flags > 0 ? (
        <Alert as="p" tone="warning" role="status" data-testid="admin-recon">
          {t("reconFlags", { count: o.open_reconciliation_flags })}
        </Alert>
      ) : null}

      <section aria-labelledby="centres-title" className="space-y-2">
        <h2 id="centres-title" className="sr-only">{t("centre")}</h2>
        {o.orgs.length === 0 ? (
          <p className="text-slate-700">{t("noCentres")}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm" data-testid="admin-centres">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{t("centre")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("account")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("policy")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("thisMonth")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("action")}</th>
                </tr>
              </thead>
              <tbody>
                {o.orgs.map((c) => (
                  <tr key={c.org_id} className="border-t border-slate-100" data-testid={`admin-centre-${c.org_id}`}>
                    <th scope="row" className={`${cell} font-medium text-teal-800`}>{c.name}</th>
                    <td className={cell}>
                      {t(`accountStatus.${c.account.status}`)}
                      {c.account.razorpay_account_id ? ` · …${c.account.razorpay_account_id.slice(-4)}` : ""}
                      {c.account.explicit ? "" : ` (${t("demo")})`}
                    </td>
                    <td className={cell}>
                      {policyShort(format, c.policy, t("defaultPolicy"))}
                      {c.accepted ? null : <span className="block text-amber-900">{t("notAccepted")}</span>}
                    </td>
                    <td className={cell}>
                      {c.failed > 0 ? (
                        <span className="text-red-700">{t("failedCount", { count: c.failed })}</span>
                      ) : c.hidden_paid_services > 0 ? (
                        <span className="text-amber-900">{t("hidden")}</span>
                      ) : (
                        t("paidOut", { amount: format.inr(c.month_paid_out_paise) })
                      )}
                    </td>
                    <td className={cell}>
                      <details>
                        <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-teal-800 underline">{t("edit")}</summary>
                        <div className="mt-2 w-[min(80vw,48rem)]">
                          <AdminCentreForms orgId={c.org_id} account={c.account} policy={c.policy} />
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="attention-title" className="space-y-2">
        <h2 id="attention-title" className="text-lg font-semibold text-slate-900">{t("attention")}</h2>
        {o.attention.length === 0 ? (
          <p className="text-sm text-slate-700">{t("attentionEmpty")}</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="admin-attention">
            {o.attention.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" data-testid={`attention-${i.id}`}>
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-slate-900">
                    {i.org_name} · {format.date(`${i.consultation_on}T12:00:00+05:30`)} · {format.inr(i.net_paise)}
                  </p>
                  <p className="text-slate-600">
                    {i.status === "on_hold"
                      ? t("accountStatus.suspended")
                      : i.failure_reason === "payout_account_inactive"
                        ? t("waitingAccount")
                        : `${i.failure_reason ?? i.status}${i.exhausted ? ` · ${t("exhausted")}` : i.next_attempt_at ? ` · ${t("nextAttempt", { time: format.dateTime(i.next_attempt_at) })}` : ""}`}
                  </p>
                </div>
                {i.status === "failed" || i.status === "pending" ? <RetryButton itemId={i.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
