// Ticket 052 FR-5: lead with weekly value. A child past the assessment opens on `Sessions` (session notes and goal
// progress); a case still in assessment keeps the current default (Overview, whose Next step points at the ISAA work).
// "Past the assessment" = the case was referred, its assessment report is final, it has a published (or active)
// therapy plan (025), or the child is on a weekly therapy timetable (043).
import { isUuid } from "@/lib/cases/validation";
import { pg } from "@/lib/pg";

export type CaseTabFacts = {
  status: string;
  final_assessment: boolean;
  plan: boolean;
  series: boolean;
};

export type CaseDefaultTab = "overview" | "sessions";

export function isPastAssessment(f: CaseTabFacts): boolean {
  return f.status === "referred" || f.final_assessment || f.plan || f.series;
}

export function defaultCaseTab(f: CaseTabFacts): CaseDefaultTab {
  return isPastAssessment(f) ? "sessions" : "overview";
}

export function caseHref(caseId: string, tab: CaseDefaultTab): string {
  return tab === "sessions" ? `/cases/${caseId}/sessions` : `/cases/${caseId}`;
}

/** One query for many cases (dashboard list, NFR-1). Unknown ids are absent from the map. */
export async function loadCaseTabFacts(caseIds: string[]): Promise<Map<string, CaseTabFacts>> {
  const ids = [...new Set(caseIds.filter(isUuid))];
  const out = new Map<string, CaseTabFacts>();
  if (ids.length === 0) return out;
  const sql = await pg();
  const rows = await sql<{ id: string; status: string; final_assessment: boolean; plan: boolean; series: boolean }[]>`
    select c.id, c.status,
           exists (select 1 from public.reports r where r.case_id = c.id and r.kind = 'assessment' and r.status = 'final') as final_assessment,
           exists (select 1 from public.iep_plans p where p.case_id = c.id and p.status in ('active', 'completed')) as plan,
           exists (select 1 from public.appointment_series s where s.case_id = c.id and s.status in ('active', 'paused')) as series
    from public.cases c
    where c.id = any(${ids}::uuid[])`;
  for (const r of rows) out.set(r.id, { status: r.status, final_assessment: r.final_assessment, plan: r.plan, series: r.series });
  return out;
}

export async function getCaseDefaultTab(caseId: string): Promise<CaseDefaultTab> {
  const facts = (await loadCaseTabFacts([caseId])).get(caseId);
  return facts ? defaultCaseTab(facts) : "overview";
}
