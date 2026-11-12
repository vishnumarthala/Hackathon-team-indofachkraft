import Link from "next/link";
import { requireGuardianPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// FR-7. "Add your child" points at the children page (020 fills it); /find ships with 029.
export default async function FamilyHomePage() {
  const { profile } = await requireGuardianPage();
  const t = await getT("family.home");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900 break-words sm:text-3xl">
        {t("hello", { name: profile.display_name ?? t("there") })}
      </h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/family/children"
          className="block min-h-11 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-teal-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
        >
          <h2 className="text-lg font-semibold text-slate-900">{t("addChild")}</h2>
          <p className="mt-1 text-sm text-slate-600">{t("addChildText")}</p>
        </Link>
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5" aria-disabled="true">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">{t("findSpecialist")}</h2>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{t("comingSoon")}</span>
          </div>
          <p className="mt-1 text-sm text-slate-600">{t("findSpecialistText")}</p>
        </div>
      </div>
    </div>
  );
}
