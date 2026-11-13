import { notFound } from "next/navigation";
import { GoalsPanel } from "@/components/iep/GoalsPanel";
import { requireCasePage } from "@/lib/authz";
import { getPlanDetail, listCasePlans } from "@/lib/iep";
import { orderGoals } from "@/lib/iep/markdown";
import { todayInIndia } from "@/lib/iep/schema";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 025 FR-5: case workspace `Goals` tab. Shows the case's active plan (or the newest one); `?plan=<id>` picks another
// plan of the same case (ids of other cases fall back to the default).
export default async function CaseGoalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const plans = await listCasePlans(id);
  const wanted = (await searchParams).plan;
  const selected = plans.find((p) => p.id === wanted) ?? plans[0] ?? null;
  const detail = selected ? await getPlanDetail(selected.id, id) : null;

  return (
    <GoalsPanel
      caseId={caseRow.id}
      plans={plans.map((p) => ({ id: p.id, title: p.title, status: p.status }))}
      plan={detail?.plan ?? null}
      goals={detail ? orderGoals(detail.goals) : []}
      today={todayInIndia()}
    />
  );
}
