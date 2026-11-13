import Link from "next/link";
import { HealthProfileForm } from "@/components/health/HealthProfileForm";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { displayNames, getHealthProfileOrEmpty } from "@/lib/queries/health";

export const dynamic = "force-dynamic";

// 021 FR-4: the guardian edits the child's health profile (active link required, else 404).
export default async function ChildHealthPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const [profile, t, format] = await Promise.all([getHealthProfileOrEmpty(child.id), getT("health"), getFormatter()]);
  const updatedBy = profile.updated_by ? (await displayNames([profile.updated_by])).get(profile.updated_by) : undefined;
  const name = child.display_name;

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name })}
      </Link>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-700">{t("intro", { name })}</p>
        <p className="rounded-2xl bg-teal-50 p-4 text-teal-950">{t("notice", { name })}</p>
        <p className="text-sm text-slate-600" data-testid="health-last-updated">
          {profile.updated_at
            ? updatedBy
              ? t("lastUpdated", { date: format.dateTime(profile.updated_at), name: updatedBy })
              : t("lastUpdatedNoName", { date: format.dateTime(profile.updated_at) })
            : t("notSavedYet")}
        </p>
        {profile.version > 0 ? (
          <Link href={`/family/children/${child.id}/health/history`} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
            {t("historyLink")}
          </Link>
        ) : null}
      </header>
      <HealthProfileForm childId={child.id} initial={profile} />
    </div>
  );
}
