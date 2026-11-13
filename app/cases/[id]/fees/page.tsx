import { FeesActions } from "@/components/fees/FeesActions";
import { LedgerTable } from "@/components/fees/LedgerTable";
import { requireFeesCasePage } from "@/lib/fees/authz";
import { listOpenLinks, listPackages, listRefundableSessions, loadAccount, packageSeriesWithoutCover } from "@/lib/fees/store";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 045 FR-7: the case's `Fees` tab (Figma 31:616): balance due, the package and sessions left, badges (FR-8), the ledger
// and, for owner/admin, `Offer package`, `Request payment`, `Show QR`, `Adjustment` and refunds. Case access (022) is
// checked here (layouts are not a gate); other organisations 404.
export default async function CaseFeesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope, access } = await requireFeesCasePage(id);
  const t = await getT("fees");
  const format = await getFormatter();
  if (!scope) return <p className="text-slate-700">{t("caseTab.noChild")}</p>;

  const [account, links, packages, refundable, seriesWarning] = await Promise.all([
    loadAccount(scope.orgId, scope.childId),
    listOpenLinks(scope.orgId, scope.childId),
    listPackages(scope.orgId, { activeOnly: true }),
    access === "manage" ? listRefundableSessions(scope.orgId, scope.childId) : Promise.resolve([]),
    packageSeriesWithoutCover(scope.orgId, scope.childId),
  ]);
  const active = account.packages.find((p) => p.status === "active") ?? null;
  const pending = account.packages.filter((p) => p.status === "pending_payment");
  const balance = account.balance_paise;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-slate-900">{t("caseTab.title")}</h2>
        <p className="text-sm text-slate-700">{t("caseTab.intro")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="fees-balance" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h3 id="fees-balance" className="text-sm font-medium text-slate-700">
            {balance < 0 ? t("caseTab.credit") : t("caseTab.balanceDue")}
          </h3>
          <p className="text-3xl font-semibold text-slate-900" data-testid="fees-balance">
            {balance === 0 ? t("caseTab.nothingDue") : format.inr(Math.abs(balance))}
          </p>
          <div className="flex flex-wrap gap-2">
            {account.overdue ? (
              <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-800" data-testid="badge-overdue">
                {t("caseTab.overdue")}
              </span>
            ) : null}
            {account.package_ending ? (
              <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900" data-testid="badge-package-ending">
                {t("caseTab.packageEnding")}
              </span>
            ) : null}
          </div>
          {account.pending_refunds.map((r) => (
            <p key={r.id} className="text-sm text-sky-900">
              {t("caseTab.refundPending", { amount: format.inr(r.amount_paise) })}
            </p>
          ))}
        </section>

        <section aria-labelledby="fees-package" className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <h3 id="fees-package" className="text-sm font-medium text-slate-700">
            {t("caseTab.activePackage")}
          </h3>
          {active ? (
            <div className="space-y-2" data-testid="fees-active-package">
              <p className="font-semibold text-slate-900">{active.name}</p>
              <p className="text-2xl font-semibold text-slate-900" data-testid="fees-sessions-left">
                {t("caseTab.sessionsLeft", { count: active.sessions_total - active.sessions_used })}
              </p>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={active.sessions_total}
                aria-valuenow={active.sessions_used}
                aria-label={t("caseTab.progress", { used: active.sessions_used, total: active.sessions_total })}
              >
                <div className="h-full bg-teal-700" style={{ width: `${Math.round((active.sessions_used / active.sessions_total) * 100)}%` }} />
              </div>
              <p className="text-sm text-slate-700">
                {t("caseTab.progress", { used: active.sessions_used, total: active.sessions_total })}
                {active.expires_on ? ` · ${t("caseTab.validUntil", { date: format.date(`${active.expires_on}T12:00:00+05:30`) })}` : ""}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-700">{t("caseTab.noPackage")}</p>
          )}
          {pending.map((p) => (
            <p key={p.id} className="text-sm text-amber-900" data-testid="fees-pending-offer">
              {t("caseTab.pendingOffer", { name: p.name, amount: format.inr(p.price_paise) })}{" "}
              {t("caseTab.offerOpenUntil", { date: format.date(p.offer_expires_at) })}
            </p>
          ))}
          {seriesWarning ? <p className="rounded bg-amber-50 p-2 text-sm text-amber-950">{t("caseTab.seriesWarning")}</p> : null}
        </section>
      </div>

      <FeesActions
        caseId={scope.caseId}
        canManage={access === "manage"}
        centre={scope.orgName}
        packages={packages.map((p) => ({ id: p.id, label: `${p.name} · ${format.inr(p.price_inr * 100)}` }))}
        links={links.map((l) => ({ payment_id: l.payment_id, purpose: l.purpose, amount: format.inr(l.amount_paise) }))}
        refundablePackages={account.packages
          .filter((p) => ["active", "used_up", "expired"].includes(p.status) && p.payment_id)
          .map((p) => ({ id: p.id, label: `${p.name} (${t(`packageStatus.${p.status}`)})` }))}
        refundableSessions={refundable.map((s) => ({ id: s.appointment_id, label: `${format.date(s.starts_at)} · ${s.service} · ${format.inr(s.amount_paise)}` }))}
      />

      <section aria-labelledby="fees-ledger" className="space-y-2">
        <h3 id="fees-ledger" className="font-semibold text-slate-900">
          {t("caseTab.ledger")}
        </h3>
        <LedgerTable rows={account.ledger} receiptBase="/api/fees/payments" />
      </section>
    </div>
  );
}
