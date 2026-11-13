import { notFound } from "next/navigation";
import { HealthProfileView } from "@/components/health/HealthProfileView";
import { requireCasePage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";
import { getHealthProfile } from "@/lib/queries/health";

export const dynamic = "force-dynamic";

// 021 FR-5: read-only health profile of the case's child for providers who can access this case (rule 2).
export default async function CaseHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const [profile, t, tp, format] = await Promise.all([
    caseRow.child_id ? getHealthProfile(caseRow.child_id) : Promise.resolve(null),
    getT("health"),
    getT("health.provider"),
    getFormatter(),
  ]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{tp("readOnly")}</p>
        {profile?.updated_at ? <p className="text-xs text-slate-600">{tp("updated", { date: format.dateTime(profile.updated_at) })}</p> : null}
      </div>
      {profile ? <HealthProfileView profile={profile} /> : <p className="text-slate-700">{tp("empty")}</p>}
    </div>
  );
}
