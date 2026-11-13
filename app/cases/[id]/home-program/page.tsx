import { notFound } from "next/navigation";
import { HomeProgramPanel } from "@/components/home-program/HomeProgramPanel";
import { requireCasePage } from "@/lib/authz";
import { getProgramDetail, listCasePrograms, listGoalOptions, listGuideOptions } from "@/lib/home-program";
import { DEFAULT_TIME_ZONE } from "@/lib/i18n/config";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 026 FR-4: case workspace `Home program` tab. Shows the case's published program (or the newest one); `?program=<id>`
// picks another program of the same case (ids of other cases fall back to the default).
export default async function CaseHomeProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ program?: string | string[] }>;
}) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const programs = await listCasePrograms(id);
  const wanted = (await searchParams).program;
  const selected = programs.find((p) => p.id === wanted) ?? programs[0] ?? null;
  const [detail, goals, guides] = await Promise.all([
    selected ? getProgramDetail(selected.id, id) : null,
    listGoalOptions(id),
    listGuideOptions(id),
  ]);

  return (
    <HomeProgramPanel
      caseId={caseRow.id}
      programs={programs.map((p) => ({ id: p.id, title: p.title, status: p.status }))}
      program={detail?.program ?? null}
      activities={detail?.activities ?? []}
      adherence={detail?.adherence ?? []}
      goals={goals}
      guides={guides}
      timeZone={detail?.time_zone ?? DEFAULT_TIME_ZONE}
    />
  );
}
