import { notFound } from "next/navigation";
import { CareTeamPanel, type CandidateView, type TeamMemberView } from "@/components/case/CareTeamPanel";
import { requireCasePage } from "@/lib/authz";
import { canManageCaseTeam, listCaseTeam, listTeamCandidates } from "@/lib/cases/team";
import { getT } from "@/lib/i18n/server";
import type { ProviderType } from "@/lib/providers/constants";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 022 FR-3: the case's care team; owners/admins of the org and the case lead add and remove providers.
export default async function CaseTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const [team, manage, tp] = await Promise.all([listCaseTeam(id), canManageCaseTeam(user.id, id), getT("providers.types")]);
  const candidates = manage ? await listTeamCandidates(id) : [];
  const typeLabel = (type: ProviderType | null) => (type ? tp(type) : null);

  const members: TeamMemberView[] = team.map((m) => ({
    assignmentId: m.assignment_id,
    name: m.display_name ?? m.email,
    discipline: m.discipline_label ?? typeLabel(m.provider_type),
    careRole: m.care_role,
    memberActive: m.member_active,
    isSelf: m.user_id === user.id,
  }));
  const options: CandidateView[] = candidates.map((c) => ({
    userId: c.user_id,
    name: c.display_name ? `${c.display_name}${c.email ? ` (${c.email})` : ""}` : (c.email ?? c.user_id),
    typeLabel: typeLabel(c.provider_type),
  }));

  return <CareTeamPanel caseId={caseRow.id} members={members} candidates={options} manage={manage} />;
}
