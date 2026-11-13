import type { Metadata } from "next";
import { PackagesEditor } from "@/components/fees/PackagesEditor";
import { requireProviderPage } from "@/lib/authz";
import { listPackages } from "@/lib/fees/store";
import { getFormatter, getT } from "@/lib/i18n/server";
import { canManage, listMemberships } from "@/lib/orgs";
import { pg } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("fees.settings");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

// 045 FR-7 org settings `Packages`: owner/admin of an organisation edit its packages. The organisation comes from the
// user's own memberships (an unknown `org` falls back to the first one).
export default async function PackagesSettingsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { user } = await requireProviderPage();
  const t = await getT("fees.settings");
  const format = await getFormatter();
  const orgs = (await listMemberships(user.id)).filter((m) => canManage(m.org_role)).map((m) => m.org);
  const requested = (await searchParams).org;
  const org = orgs.find((o) => o.id === requested) ?? orgs[0] ?? null;
  if (!org) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
        <p className="text-slate-700">{t("noOrg")}</p>
      </div>
    );
  }
  const sql = await pg();
  const services = await sql<{ id: string; name: string; fee_inr: number; active: boolean }[]>`
    select id, name, fee_inr, active from public.services where org_id = ${org.id} order by active desc, name`;
  const packages = await listPackages(org.id);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>
      {orgs.length > 1 ? (
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="packages-org" className="block text-sm font-medium text-slate-800">
              {t("org")}
            </label>
            <select id="packages-org" name="org" defaultValue={org.id} className="mt-1 block min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm">
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900">
            {t("show")}
          </button>
        </form>
      ) : null}
      <PackagesEditor
        orgId={org.id}
        services={services.map((s) => ({ id: s.id, label: `${s.name}${s.fee_inr > 0 ? ` · ${format.inr(s.fee_inr * 100)}` : ""}` }))}
        packages={packages.map((p) => ({ ...p, summary: t("summary", { sessions: p.session_count, price: format.inr(p.price_inr * 100), days: p.validity_days }) }))}
      />
    </div>
  );
}
