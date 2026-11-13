import { notFound } from "next/navigation";
import { AssessmentsPanel, type AssessmentRowView } from "@/components/assessments/AssessmentsPanel";
import { listCaseAssessments, listCaseGuardians, listTemplatesForCase } from "@/lib/assessments";
import { todayInIndia } from "@/lib/assessments/schemas";
import { requireCasePage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 024 FR-8: questionnaires sent to the child's guardians from this case.
export default async function CaseAssessmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const [templates, guardians, assessments, tr] = await Promise.all([
    listTemplatesForCase(id),
    listCaseGuardians(id),
    listCaseAssessments(id),
    getT("family.children.form.relationships"),
  ]);
  const t = await getT("assessments.provider");

  const guardianLabel = (name: string | null, relationship: string | null) => {
    const rel = relationship ? tr(relationship as Parameters<typeof tr>[0]) : null;
    if (name && rel) return `${name} (${rel})`;
    return name ?? rel ?? t("parentFallback");
  };

  const rows: AssessmentRowView[] = assessments.map((a) => ({
    id: a.id,
    title: a.title,
    guardian: guardianLabel(a.guardian_name, a.guardian_relationship),
    status: a.status,
    dueOn: a.due_on,
    updatedAt: a.updated_at,
    redFlagCount: a.red_flag_count,
    sharedWithParent: a.shared_with_parent,
  }));

  return (
    <AssessmentsPanel
      caseId={caseRow.id}
      templates={templates.map((tpl) => ({ id: tpl.id, title: tpl.title }))}
      guardians={guardians.map((g) => ({ userId: g.user_id, label: guardianLabel(g.display_name, g.relationship) }))}
      assessments={rows}
      minDue={todayInIndia()}
    />
  );
}
