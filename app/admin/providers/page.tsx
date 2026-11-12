import type { Metadata } from "next";
import Link from "next/link";
import { ClaimLinkButton, SuspendButton } from "@/components/providers/AdminActions";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { listProfilesForAdmin } from "@/lib/providers/verification";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("providers.adminProviders");
  return { title: t("metaTitle") };
}

// FR-5 platform-admin list of provider profiles: claim links for unclaimed ones, suspension for verified.
export default async function AdminProvidersPage() {
  await requirePlatformAdminPage();
  const t = await getT("providers");
  const nav = await getT();
  const profiles = await listProfilesForAdmin();

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/dashboard" className="font-medium text-slate-700 underline">
          {nav("nav.dashboard")}
        </Link>
        <Link href="/admin/verifications" className="font-medium text-slate-700 underline">
          {t("nav.verifications")}
        </Link>
        <Link href="/admin/providers/new" className="font-medium text-slate-700 underline">
          {t("adminProviders.seed")}
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold text-slate-900">{t("adminProviders.title")}</h1>
      {profiles.length === 0 ? (
        <p className="text-slate-700">{t("adminProviders.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-left text-sm">
            <thead className="bg-slate-50 text-slate-800">
              <tr>
                {(["name", "type", "status", "listed", "claimed", "actions"] as const).map((key) => (
                  <th key={key} scope="col" className="px-3 py-2 font-semibold">
                    {t(`adminProviders.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {profiles.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="px-3 py-2">
                    {p.listed ? (
                      <Link href={`/p/${p.slug}`} className="font-medium underline">
                        {p.display_name}
                      </Link>
                    ) : (
                      p.display_name
                    )}
                    {p.is_synthetic ? (
                      <span className="ml-2 rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900">{t("demoBadge")}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{t(`types.${p.provider_type as "pediatrician"}`)}</td>
                  <td className="px-3 py-2">{t(`status.${p.verification_status as "verified"}`)}</td>
                  <td className="px-3 py-2">{p.listed ? t("adminProviders.yes") : t("adminProviders.no")}</td>
                  <td className="px-3 py-2">{p.claimed ? t("adminProviders.yes") : t("adminProviders.no")}</td>
                  <td className="space-y-2 px-3 py-2">
                    {p.claimed ? null : <ClaimLinkButton profileId={p.id} />}
                    {p.verification_status === "verified" ? <SuspendButton profileId={p.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
