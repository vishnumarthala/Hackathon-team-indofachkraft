// Ticket 052 FR-5: the Sessions tab leads with weekly value - the case's active goals with their latest progress
// (025), next to the session notes. One query. The caller checked case access (requireCasePage).
import { isUuid } from "@/lib/cases/validation";
import { pg } from "@/lib/pg";

export type GoalSummary = {
  id: string;
  statement: string;
  measure_type: "percent" | "count" | "rating_1_5" | "yes_no";
  baseline_value: number | null;
  target_value: number | null;
  latest: { value: number; observed_on: string } | null;
};

/** Active goals of the case's active (else most recent non-archived) plan, newest progress first per goal. */
export async function listCaseGoalSummary(caseId: string, limit = 12): Promise<GoalSummary[]> {
  if (!isUuid(caseId)) return [];
  const sql = await pg();
  const rows = await sql`
    with plan as (
      select id from public.iep_plans
      where case_id = ${caseId} and status <> 'archived'
      order by (status = 'active') desc, created_at desc
      limit 1
    )
    select g.id, g.statement, g.measure_type, g.baseline_value, g.target_value,
           (select json_build_object('value', gp.value, 'observed_on', gp.observed_on::text)
            from public.goal_progress gp where gp.goal_id = g.id
            order by gp.observed_on desc, gp.created_at desc limit 1) as latest
    from public.iep_goals g
    join plan on plan.id = g.plan_id
    where g.status = 'active'
    order by g.sort, g.created_at
    limit ${limit}`;
  return rows.map((r) => {
    const latest = r.latest as { value: number | string; observed_on: string } | null;
    return {
      id: String(r.id),
      statement: String(r.statement),
      measure_type: r.measure_type as GoalSummary["measure_type"],
      baseline_value: r.baseline_value === null ? null : Number(r.baseline_value),
      target_value: r.target_value === null ? null : Number(r.target_value),
      latest: latest ? { value: Number(latest.value), observed_on: latest.observed_on } : null,
    };
  });
}
