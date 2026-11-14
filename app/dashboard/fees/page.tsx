import type { Metadata } from "next";
import Link from "next/link";
import { requireProviderPage } from "@/lib/authz";
import { listBalancesDue } from "@/lib/fees/store";
import { getFormatter, getT } from "@/lib/i18n/server";
import { canManage, listMemberships } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("fees.dashboard");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

// 045 FR-7 / FR-8: balances due and ending packages across the organisations the user manages (owner/admin), with the
// `Overdue` (unpaid 3 days after a session) and `Package ending` (<= 2 sessions or <= 7 days) badges.
export default async function FeesDashboardPage() {
  const { user } = await requireProviderPage();
  const t = await getT("fees.dashboard");
  const tc = await getT("fees.caseTab");
  const format = await getFormatter();
  const orgs = (await listMemberships(user.id)).filter((m) => canManage(m.org_role));
  const rows = await listBalancesDue(orgs.map((m) => m.org.id));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
        <p className="text-slate-700">{t("intro")}</p>
        <div className="flex flex-wrap gap-x-4">
          <Link href="/dashboard/settings/packages" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
            {t("packagesLink")}
          </Link>
          <Link href="/dashboard/payouts" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
            {t("payoutsLink")}
          </Link>
        </div>
      </header>
      {orgs.length === 0 ? (
        <p className="text-slate-700">{t("noOrg")}</p>
      ) : rows.length === 0 ? (
        <p className="text-slate-700">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="fees-dashboard">
          {rows.map((r) => (
            <li key={`${r.org_id}:${r.child_id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="font-medium break-words text-slate-900">{r.child_name}</p>
                <p className="text-sm text-slate-600">{orgs.length > 1 ? r.org_name : null}</p>
                <div className="flex flex-wrap gap-2">
                  {r.overdue ? <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-800">{tc("overdue")}</span> : null}
                  {r.package_ending ? (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
                      {tc("packageEnding")}
                      {r.package_left !== null ? ` · ${t("packageLeft", { count: r.package_left })}` : ""}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-slate-900">
                  {r.balance_paise > 0 ? format.inr(r.balance_paise) : r.balance_paise < 0 ? `${tc("credit")} ${format.inr(-r.balance_paise)}` : tc("nothingDue")}
                </span>
                {r.case_id ? (
                  <Link href={`/cases/${r.case_id}/fees`} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900">
                    {t("open")}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
