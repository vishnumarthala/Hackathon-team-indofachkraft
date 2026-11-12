import type { Metadata } from "next";
import Link from "next/link";
import { SeedForm } from "@/components/providers/SeedForm";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("providers.adminSeed");
  return { title: t("metaTitle") };
}

export default async function SeedProviderPage() {
  await requirePlatformAdminPage();
  const t = await getT("providers.adminSeed");
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <Link href="/admin/providers" className="text-sm font-medium text-slate-700 underline">
        {t("backToList")}
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <p className="text-slate-700">{t("intro")}</p>
      <SeedForm />
    </div>
  );
}
