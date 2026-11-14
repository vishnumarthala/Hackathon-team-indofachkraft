import type { Metadata } from "next";
import Link from "next/link";
import { AcceptFeeButton, PayoutSettingsForm } from "@/components/payouts/PayoutForms";
import { getFormatter, getT } from "@/lib/i18n/server";
import type { Formatter } from "@/lib/i18n/format";
import { requirePayoutsPage } from "@/lib/payouts/authz";
import type { FeePolicy } from "@/lib/payouts/fees";
import { invoiceMonthLabel } from "@/lib/payouts/invoice";
import { listInvoices, listPayoutItems, payoutReadiness, payoutStatement, type PayoutItemRow } from "@/lib/payouts/store";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("payouts.dashboard");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

type T = Awaited<ReturnType<typeof getT<"payouts">>>;

function policyText(t: T, format: Formatter, p: FeePolicy): string {
  const parts = [
    p.kind === "flat" ? t("fee.flat", { amount: format.inr(p.flat_paise ?? 0) }) : t("fee.percent", { percent: format.number((p.percent_bps ?? 0) / 100) }),
  ];
  if (p.min_paise > 0) parts.push(t("fee.min", { amount: format.inr(p.min_paise) }));
  if (p.cap_paise !== null) parts.push(t("fee.cap", { amount: format.inr(p.cap_paise) }));
  if (p.waived_until) parts.push(t("fee.waived", { date: format.date(`${p.waived_until}T12:00:00+05:30`, "long") }));
  return parts.join(" ");
}

function shortPolicy(format: Formatter, p: FeePolicy): string {
  return p.kind === "flat" ? `${format.inr(p.flat_paise ?? 0)} + GST` : `${format.number((p.percent_bps ?? 0) / 100)}% + GST`;
}

function statusLabel(t: T, i: PayoutItemRow): string {
  if (i.status === "transferred" && !i.processed_at) return t("status.processing");
  return t(`status.${i.status}`);
}

// 046 FR-7 / FR-8 (Figma 31:340): the centre's payouts. Owner/admin of the organisation (members 403, forbidden()):
// payout account status with setup steps, the fee notice to accept, this month's and week's totals, every payout
// item, monthly platform-fee invoices and the payout settings.
export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { orgs, org } = await requirePayoutsPage((await searchParams).org);
  const t = await getT("payouts");
  const format = await getFormatter();
  const [readiness, statement, items, invoices] = await Promise.all([
    payoutReadiness(org.id),
    payoutStatement(org.id),
    listPayoutItems(org.id, { limit: 100 }),
    listInvoices(org.id),
  ]);
  const { account, policy } = readiness;
  const card = "space-y-1 rounded-xl border border-slate-200 bg-white p-4";
  const active = account.status === "active";
  const alertClass = active
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : account.status === "suspended"
      ? "border-red-200 bg-red-50 text-red-900"
      : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900">{t("dashboard.title")}</h1>
          <p className="text-slate-700">{t("dashboard.subtitle", { centre: org.name })}</p>
        </div>
        <a
          href={`/api/orgs/${org.id}/payouts/export`}
          className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900"
          data-testid="payouts-csv"
        >
          {t("dashboard.downloadCsv")}
        </a>
      </header>

      {orgs.length > 1 ? (
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="payouts-org" className="block text-sm font-medium text-slate-800">{t("dashboard.org")}</label>
            <select id="payouts-org" name="org" defaultValue={org.id} className="mt-1 block min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm">
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900">
            {t("dashboard.show")}
          </button>
        </form>
      ) : null}

      <section role="status" aria-live="polite" className={`space-y-2 rounded-xl border p-4 ${alertClass}`} data-testid="payout-account">
        <h2 className="font-semibold">
          {active ? `✓ ${t("account.activeTitle")}` : account.status === "suspended" ? t("account.suspendedTitle") : t("account.setupTitle")}
        </h2>
        <p className="text-sm">
          {active
            ? readiness.demoImplicit
              ? t("account.demoBody", { policy: shortPolicy(format, policy) })
              : t("account.activeBody", { last4: (account.razorpay_account_id ?? "").slice(-4), policy: shortPolicy(format, policy) })
            : account.status === "suspended"
              ? t("account.suspendedBody")
              : account.status === "pending_kyc"
                ? t("account.pendingBody")
                : t("account.notStartedBody")}
        </p>
        {!active && account.status !== "suspended" ? (
          <div className="text-sm">
            <p className="font-medium">{t("account.steps")}</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>{t("account.step1")}</li>
              <li>{t("account.step2")}</li>
              <li>{t("account.step3")}</li>
            </ol>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="fee-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4" data-testid="fee-notice">
        <h2 id="fee-title" className="font-semibold text-slate-900">{t("fee.title")}</h2>
        <p className="text-slate-800">{policyText(t, format, policy)}</p>
        <p className="text-sm text-slate-600">{t("fee.familiesNote")}</p>
        {readiness.accepted ? (
          readiness.demoImplicit ? null : <p className="text-sm font-medium text-emerald-800">{t("fee.accepted", { version: policy.version })}</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium text-amber-900">{t("fee.needed")}</p>
            <AcceptFeeButton orgId={org.id} version={policy.version} canAccept={org.role === "owner"} />
          </div>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="payout-stats">
        <div className={card}>
          <p className="text-sm text-slate-600">{t("stats.consultations")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="stat-consultations">{format.number(statement.month.consultations)}</p>
          <p className="text-sm text-teal-800">{t("stats.week", { value: format.number(statement.week.consultations) })}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-slate-600">{t("stats.paid")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="stat-gross">{format.inr(statement.month.gross_paise)}</p>
          <p className="text-sm text-teal-800">{t("stats.week", { value: format.inr(statement.week.gross_paise) })}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-slate-600">{t("stats.fee")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="stat-fee">{format.inr(statement.month.fee_gst_paise)}</p>
          <p className="text-sm text-teal-800">{t("stats.week", { value: format.inr(statement.week.fee_gst_paise) })}</p>
        </div>
        <div className={card}>
          <p className="text-sm text-slate-600">{t("stats.out")}</p>
          <p className="text-2xl font-semibold text-slate-900" data-testid="stat-out">{format.inr(statement.month.paid_out_paise)}</p>
          <p className="text-sm text-teal-800">{t("stats.week", { value: format.inr(statement.week.paid_out_paise) })}</p>
        </div>
      </div>

      <section aria-labelledby="items-title" className="space-y-2">
        <h2 id="items-title" className="text-lg font-semibold text-slate-900">{t("table.title")}</h2>
        {items.length === 0 ? (
          <p className="text-slate-700">{t("table.empty")}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm" data-testid="payout-items">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{t("table.session")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("table.child")}</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">{t("table.consultation")}</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">{t("table.feeGst")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("table.net")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-t border-slate-100" data-testid="payout-item">
                    <td className="px-4 py-2 text-teal-800">
                      {i.session_at ? format.dateTime(i.session_at) : format.date(`${i.consultation_on}T12:00:00+05:30`)}
                      {" · "}
                      {i.kind === "package_expiry" ? t("table.unused") : (i.service ?? "")}
                    </td>
                    <td className="px-4 py-2 text-slate-800">{i.child_name ?? "-"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{format.inr(i.consultation_paise)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {i.fee_waived ? t("table.waived") : format.inr(i.fee_paise + i.gst_paise)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                      {format.inr(i.net_paise)} · {statusLabel(t, i)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="invoices-title" className="space-y-2">
        <h2 id="invoices-title" className="text-lg font-semibold text-slate-900">{t("invoices.title")}</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-slate-700">{t("invoices.none")}</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="payout-invoices">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium break-words text-slate-900">{t("invoices.row", { month: invoiceMonthLabel(inv.period_month), number: inv.invoice_no })}</p>
                  <p className="text-sm text-slate-600">{t("invoices.detail", { fee: format.inr(inv.fee_paise), gst: format.inr(inv.gst_paise) })}</p>
                </div>
                <a href={inv.pdf_path} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900">
                  {t("invoices.download")}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="settings-title" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
        <h2 id="settings-title" className="font-semibold text-slate-900">{t("settings.title")}</h2>
        <PayoutSettingsForm orgId={org.id} expiryPolicy={readiness.package_expiry_policy} gstin={account.gstin} />
      </section>

      <p className="text-sm">
        <Link href="/dashboard/fees" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">{t("dashboard.feesLink")}</Link>
      </p>
    </div>
  );
}
