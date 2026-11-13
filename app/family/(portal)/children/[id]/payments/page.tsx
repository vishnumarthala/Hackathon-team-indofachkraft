import Link from "next/link";
import { LedgerTable } from "@/components/fees/LedgerTable";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { listChildAccounts, refreshBalanceLink } from "@/lib/fees/store";
import { errorMessage, logger } from "@/lib/log";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 045 FR-5 (Figma 30:84): the child's payments, one card per centre: the balance due with `Pay ₹X with UPI or card`
// (the Razorpay payment link - Razorpay's hosted checkout; no third-party script on this page), package offers waiting
// for payment, the active package with sessions left and its expiry, and the history with receipts. Active guardian
// link required (else 404).
export default async function ChildPaymentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ paid?: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const t = await getT("fees.family");
  const tc = await getT("fees.caseTab");
  const format = await getFormatter();
  let accounts = await listChildAccounts(child.id);
  // A balance without a payment link yet (the fee job runs right after marking; this covers a missed run).
  if (accounts.some((a) => a.balance_paise >= 100 && !a.balance_link)) {
    for (const a of accounts.filter((x) => x.balance_paise >= 100 && !x.balance_link)) {
      try {
        await refreshBalanceLink(a.org.id, child.id);
      } catch (err) {
        logger("fees.family").error("balance link refresh failed", { error: errorMessage(err) });
      }
    }
    accounts = await listChildAccounts(child.id);
  }
  const paid = (await searchParams).paid === "1";

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {child.display_name}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-600">{t("intro", { name: child.display_name })}</p>
      </header>
      {paid ? (
        <p role="status" className="rounded-xl bg-teal-50 p-4 font-medium text-teal-900" data-testid="paid-notice">
          {t("paidNotice")}
        </p>
      ) : null}
      {accounts.length === 0 ? <p className="text-slate-700">{t("noAccounts")}</p> : null}

      {accounts.map((account) => {
        const active = account.packages.find((p) => p.status === "active") ?? null;
        const offers = account.packages.filter((p) => p.status === "pending_payment" && p.link_url);
        const due = account.balance_paise;
        return (
          <section key={account.org.id} aria-labelledby={`centre-${account.org.id}`} className="space-y-4" data-testid="family-account">
            <h2 id={`centre-${account.org.id}`} className="text-xl font-semibold text-slate-900">
              {account.org.name}
            </h2>

            <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm font-medium text-slate-700">{t("balanceDue")}</p>
              <p className="text-3xl font-semibold text-slate-900" data-testid="family-balance">
                {format.inr(Math.max(due, 0))}
              </p>
              {due > 0 && account.balance_link ? (
                <a
                  href={account.balance_link.url}
                  className="flex min-h-12 w-full items-center justify-center rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800"
                  data-testid="family-pay-balance"
                  rel="noopener"
                >
                  {t("pay", { amount: format.inr(account.balance_link.amount_paise) })}
                </a>
              ) : due < 0 ? (
                <p className="text-sm text-slate-700">{t("credit", { amount: format.inr(-due) })}</p>
              ) : due === 0 ? (
                <p className="text-sm text-slate-700">{t("nothingDue")}</p>
              ) : null}
              {account.pending_refunds.map((r) => (
                <p key={r.id} className="text-sm text-sky-900">
                  {t("refundPending", { amount: format.inr(r.amount_paise) })}
                </p>
              ))}
              <p className="text-xs text-slate-600">{t("caption", { centre: account.org.name })}</p>
            </div>

            {offers.map((o) => (
              <div key={o.id} className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4" data-testid="family-offer">
                <p className="font-semibold text-slate-900">{t("offer", { name: o.name, sessions: o.sessions_total })}</p>
                <a
                  href={o.link_url as string}
                  className="flex min-h-12 w-full items-center justify-center rounded-lg bg-teal-700 px-4 text-base font-semibold text-white hover:bg-teal-800"
                  data-testid="family-pay-package"
                  rel="noopener"
                >
                  {t("payPackage", { amount: format.inr(o.price_paise) })}
                </a>
                <p className="text-xs text-slate-700">{tc("offerOpenUntil", { date: format.date(o.offer_expires_at) })}</p>
              </div>
            ))}

            {active ? (
              <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4" data-testid="family-package">
                <p className="text-sm font-medium text-slate-700">{t("package")}</p>
                <p className="font-semibold text-slate-900">{active.name}</p>
                <p className="text-2xl font-semibold text-slate-900">{tc("sessionsLeft", { count: active.sessions_total - active.sessions_used })}</p>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={active.sessions_total}
                  aria-valuenow={active.sessions_used}
                  aria-label={tc("progress", { used: active.sessions_used, total: active.sessions_total })}
                >
                  <div className="h-full bg-teal-700" style={{ width: `${Math.round((active.sessions_used / active.sessions_total) * 100)}%` }} />
                </div>
                <p className="text-sm text-slate-700">
                  {tc("progress", { used: active.sessions_used, total: active.sessions_total })}
                  {active.expires_on ? ` · ${tc("validUntil", { date: format.date(`${active.expires_on}T12:00:00+05:30`) })}` : ""}
                </p>
              </div>
            ) : null}

            <div className="space-y-2">
              <h3 className="font-semibold text-slate-900">{t("history")}</h3>
              <LedgerTable rows={account.ledger} receiptBase="/api/fees/payments" />
            </div>
          </section>
        );
      })}
    </div>
  );
}
