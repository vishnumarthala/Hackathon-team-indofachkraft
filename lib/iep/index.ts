// Ticket 025 FR-1..FR-4, FR-6: IEP plans, SMART goals and progress. Server only.
//
// Access: callers have passed the gate first. Providers -> requireCaseActor (case routes),
// requireIepPlanActor / requireIepGoalActor (plan and goal routes); all apply 022's case-access rule.
// Guardians -> requireChildGuardian[Page]; guardian readers here return PUBLISHED content only (NFR-1).
//
// Writes: one transaction each that locks the plan row (publishing also locks the case row), checks the plan's
// optimistic `version` (D-4: every plan or goal edit bumps it; stale -> 409 MSG.stale) and writes its audit row
// (`iep.*`) in the same transaction. Progress entries do not bump the version (they are observations, not plan
// wording). Publishing renders the plan (lib/iep/markdown.ts), calls publishVersion(entity_type 'iep_plan',
// visible to guardians), stores the goal snapshot in `iep_publications` and enqueues outbox `iep.published`.
//
// Typed entry points for later tickets: 026 reads goals with `listPlanGoals`; 038 records confirmed AI
// suggestions with `recordProgress({ ..., source: "ai_suggested_confirmed", recordingId })`.
import type postgres from "postgres";
import { contentHash, getLatestPublished, listGuardianVisible, publishVersion, type PublishedVersion } from "@/lib/clinical/publish";
import { auditStrict } from "@/lib/audit";
import { isUuid } from "@/lib/cases/validation";
import { iepPlanMarkdown, orderGoals } from "@/lib/iep/markdown";
import { goalTrend, sortPoints, type GoalTrend } from "@/lib/iep/progress";
import {
  MAX_GOALS_PER_PLAN,
  MSG,
  goalValueErrors,
  planDatesError,
  targetDateInPlan,
  valueInRange,
  type GoalCreateInput,
  type GoalDomain,
  type GoalPatchInput,
  type GoalStatus,
  type MeasureType,
  type PlanCreateInput,
  type PlanPatchInput,
  type PlanStatus,
  type ProgressSource,
} from "@/lib/iep/schema";
import { enqueue } from "@/lib/notify/outbox";
import { pg as db } from "@/lib/pg";

type Tx = postgres.Sql | postgres.TransactionSql;

export type PlanRow = {
  id: string;
  case_id: string;
  child_id: string;
  org_id: string;
  title: string;
  start_date: string;
  review_date: string;
  status: PlanStatus;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type GoalRow = {
  id: string;
  plan_id: string;
  domain: GoalDomain;
  statement: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  time_bound: string;
  measure_type: MeasureType;
  baseline_value: number;
  target_value: number;
  target_date: string;
  status: GoalStatus;
  sort: number;
  created_at: string;
  updated_at: string;
};

export type ProgressRow = {
  id: string;
  goal_id: string;
  recorded_by: string | null;
  observed_on: string;
  value: number;
  note: string | null;
  source: ProgressSource;
  recording_id: string | null;
  created_at: string;
};

export type GoalWithProgress = GoalRow & { progress: ProgressRow[]; trend: GoalTrend };

export type PublishedInfo = { version: number; published_at: string; published_by: string | null };

export type PlanSummary = PlanRow & {
  goal_count: number;
  published: PublishedInfo | null;
  /** Published at least once and the current plan renders differently from the latest published version. */
  has_unpublished_changes: boolean;
};

export type PlanDetail = { plan: PlanSummary; goals: GoalWithProgress[]; published_md: string | null };

/** Goal wording as published (iep_publications.goals); guardian charts and shared views use only this. */
export type PublishedGoal = {
  id: string;
  domain: GoalDomain;
  statement: string;
  measure_type: MeasureType;
  baseline_value: number;
  target_value: number;
  target_date: string;
  status: GoalStatus;
  sort: number;
};

export type Failure = { ok: false; status: 400 | 404 | 409 | 422; error: string; details?: Record<string, unknown> };

const fail = (status: Failure["status"], error: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  status,
  error,
  ...(details ? { details } : {}),
});

const PLAN_COLS = `p.id, p.case_id, p.child_id, p.org_id, p.title, p.start_date::text as start_date,
  p.review_date::text as review_date, p.status, p.version, p.created_by, p.created_at, p.updated_at`;
const GOAL_COLS = `g.id, g.plan_id, g.domain, g.statement, g.specific, g.measurable, g.achievable, g.relevant, g.time_bound,
  g.measure_type, g.baseline_value::float8 as baseline_value, g.target_value::float8 as target_value,
  g.target_date::text as target_date, g.status, g.sort, g.created_at, g.updated_at`;
const PROGRESS_COLS = `gp.id, gp.goal_id, gp.recorded_by, gp.observed_on::text as observed_on, gp.value::float8 as value,
  gp.note, gp.source, gp.recording_id, gp.created_at`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
function withIso<T extends Record<string, unknown>>(row: T, keys: string[] = ["created_at", "updated_at"]): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) if (k in out && out[k] != null) out[k] = iso(out[k]);
  return out as T;
}

const CLOSED: readonly PlanStatus[] = ["completed", "archived"];

/** The request body without the optimistic-lock `version`. */
function omitVersion<T extends { version: number }>(body: T): Omit<T, "version"> {
  const out: Record<string, unknown> = { ...body };
  delete out.version;
  return out as Omit<T, "version">;
}

// 041: strict audit in the caller's transaction, attributed to the session user (role from user_profiles).
async function auditTx(
  tx: Tx,
  e: { caseId: string; actorUserId: string; action: string; entity: "iep_plan" | "iep_goal" | "goal_progress"; entityId: string; details?: Record<string, unknown> },
) {
  await auditStrict(
    { caseId: e.caseId, actorUserId: e.actorUserId, action: e.action, entity: e.entity, entityId: e.entityId, details: e.details ?? {} },
    tx,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Reads (provider; caller passed the case / plan / goal gate)

async function loadPlan(tx: Tx, planId: string, lock = false): Promise<PlanRow | null> {
  if (!isUuid(planId)) return null;
  const rows = lock
    ? await tx<PlanRow[]>`select ${tx.unsafe(PLAN_COLS)} from iep_plans p where p.id = ${planId} for update`
    : await tx<PlanRow[]>`select ${tx.unsafe(PLAN_COLS)} from iep_plans p where p.id = ${planId}`;
  return rows[0] ? withIso(rows[0]) : null;
}

async function loadGoals(tx: Tx, planId: string): Promise<GoalRow[]> {
  const rows = await tx<GoalRow[]>`
    select ${tx.unsafe(GOAL_COLS)} from iep_goals g where g.plan_id = ${planId} order by g.sort, g.created_at`;
  return rows.map((r) => withIso(r));
}

async function loadProgress(tx: Tx, goalIds: string[]): Promise<ProgressRow[]> {
  if (goalIds.length === 0) return [];
  const rows = await tx<ProgressRow[]>`
    select ${tx.unsafe(PROGRESS_COLS)} from goal_progress gp
    where gp.goal_id = any(${goalIds}::uuid[])
    order by gp.observed_on, gp.created_at`;
  return rows.map((r) => withIso(r, ["created_at"]));
}

function renderPlan(plan: Pick<PlanRow, "title" | "start_date" | "review_date">, goals: GoalRow[]): string {
  return iepPlanMarkdown(plan, goals);
}

async function summarise(tx: Tx, plan: PlanRow, goals: GoalRow[]): Promise<{ summary: PlanSummary; publishedMd: string | null }> {
  const latest = await getLatestPublished(tx, "iep_plan", plan.id);
  return {
    summary: {
      ...plan,
      goal_count: goals.length,
      published: latest ? { version: latest.version, published_at: latest.published_at, published_by: latest.published_by } : null,
      has_unpublished_changes: latest ? contentHash(renderPlan(plan, goals)) !== latest.content_hash : false,
    },
    publishedMd: latest?.content_md ?? null,
  };
}

/** Plans of a case, newest first, with publish state. */
export async function listCasePlans(caseId: string): Promise<PlanSummary[]> {
  const sql = await db();
  const plans = (await sql<PlanRow[]>`
    select ${sql.unsafe(PLAN_COLS)} from iep_plans p where p.case_id = ${caseId}
    order by (p.status = 'active') desc, p.created_at desc`).map((r) => withIso(r));
  const out: PlanSummary[] = [];
  for (const plan of plans) out.push((await summarise(sql, plan, await loadGoals(sql, plan.id))).summary);
  return out;
}

/** Goals of a plan (ordered by `sort`), without progress. */
export async function listPlanGoals(planId: string): Promise<GoalRow[]> {
  const sql = await db();
  return loadGoals(sql, planId);
}

/** One plan with goals, progress points and trends. `caseId` (optional) must match the plan's case. */
export async function getPlanDetail(planId: string, caseId?: string): Promise<PlanDetail | null> {
  const sql = await db();
  const plan = await loadPlan(sql, planId);
  if (!plan || (caseId && plan.case_id !== caseId)) return null;
  const goals = await loadGoals(sql, plan.id);
  const progress = await loadProgress(sql, goals.map((g) => g.id));
  const { summary, publishedMd } = await summarise(sql, plan, goals);
  return {
    plan: summary,
    published_md: publishedMd,
    goals: goals.map((g) => {
      const points = progress.filter((p) => p.goal_id === g.id);
      return { ...g, progress: points, trend: goalTrend(points, g) };
    }),
  };
}

/** Progress entries of a goal, oldest first. */
export async function listGoalProgress(goalId: string): Promise<ProgressRow[]> {
  const sql = await db();
  return loadProgress(sql, [goalId]);
}

// ---------------------------------------------------------------------------------------------------------
// Plan writes

export async function createPlan(input: {
  caseId: string;
  actorUserId: string;
  body: PlanCreateInput;
}): Promise<{ ok: true; plan: PlanRow } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const [kase] = await tx<{ id: string; child_id: string | null }[]>`select id, child_id from cases where id = ${input.caseId}`;
    if (!kase) return fail(404, "Case not found");
    if (!kase.child_id) return fail(422, "This case has no child record yet");
    const [created] = await tx<{ id: string }[]>`
      insert into iep_plans (case_id, child_id, org_id, title, start_date, review_date, created_by)
      select c.id, c.child_id, c.org_id, ${input.body.title}, ${input.body.start_date}, ${input.body.review_date}, ${input.actorUserId}
      from cases c where c.id = ${kase.id}
      returning id`;
    await auditTx(tx, {
      caseId: kase.id,
      actorUserId: input.actorUserId,
      action: "iep.plan_created",
      entity: "iep_plan",
      entityId: created.id,
      details: { start_date: input.body.start_date, review_date: input.body.review_date },
    });
    return { ok: true as const, plan: (await loadPlan(tx, created.id)) as PlanRow };
  });
}

const STATUS_FROM: Record<"completed" | "archived", readonly PlanStatus[]> = {
  completed: ["active"],
  archived: ["draft", "active", "completed"],
};

export async function updatePlan(input: {
  planId: string;
  actorUserId: string;
  body: PlanPatchInput;
}): Promise<{ ok: true; plan: PlanRow } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const plan = await loadPlan(tx, input.planId, true);
    if (!plan) return fail(404, MSG.planNotFound);
    if (plan.version !== input.body.version) return fail(409, MSG.stale, { version: plan.version });
    const { status, ...fields } = omitVersion(input.body);
    const editsText = Object.keys(fields).length > 0;
    if (plan.status === "archived" || (plan.status === "completed" && (editsText || status !== "archived"))) {
      return fail(409, MSG.closed);
    }
    if (status && !STATUS_FROM[status].includes(plan.status)) return fail(409, MSG.statusChange);

    const next = { title: fields.title ?? plan.title, start_date: fields.start_date ?? plan.start_date, review_date: fields.review_date ?? plan.review_date };
    const dateErr = planDatesError(next.start_date, next.review_date);
    if (dateErr) return fail(400, "Invalid request", { review_date: dateErr });
    if (fields.start_date || fields.review_date) {
      const outside = (await loadGoals(tx, plan.id)).filter((g) => !targetDateInPlan(g.target_date, next));
      if (outside.length > 0) return fail(422, MSG.planDatesExcludeGoals, { goal_ids: outside.map((g) => g.id) });
    }
    await tx`
      update iep_plans
      set title = ${next.title}, start_date = ${next.start_date}, review_date = ${next.review_date},
          status = ${status ?? plan.status}, version = version + 1, updated_at = now()
      where id = ${plan.id}`;
    await auditTx(tx, {
      caseId: plan.case_id,
      actorUserId: input.actorUserId,
      action: status ? `iep.plan_${status}` : "iep.plan_updated",
      entity: "iep_plan",
      entityId: plan.id,
      details: { fields: Object.keys(fields), ...(status ? { from: plan.status, to: status } : {}), version: plan.version + 1 },
    });
    return { ok: true as const, plan: (await loadPlan(tx, plan.id)) as PlanRow };
  });
}

export type PublishResult = {
  ok: true;
  plan: PlanRow;
  published: PublishedVersion;
  /** Plan id archived because this plan became the case's active plan, if any. */
  archived_plan_id: string | null;
  event_ids: string[];
};

export async function publishPlan(input: { planId: string; actorUserId: string; version: number }): Promise<PublishResult | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const probe = await loadPlan(tx, input.planId);
    if (!probe) return fail(404, MSG.planNotFound);
    // Lock the case first so two publishes for the same case serialise (one active plan per case).
    await tx`select id from cases where id = ${probe.case_id} for update`;
    const plan = await loadPlan(tx, input.planId, true);
    if (!plan) return fail(404, MSG.planNotFound);
    if (plan.version !== input.version) return fail(409, MSG.stale, { version: plan.version });
    if (CLOSED.includes(plan.status)) return fail(409, MSG.closed);
    const goals = await loadGoals(tx, plan.id);
    if (goals.length === 0) return fail(422, MSG.noGoals);

    const contentMd = renderPlan(plan, goals);
    const latest = await getLatestPublished(tx, "iep_plan", plan.id);
    if (latest && plan.status === "active" && latest.content_hash === contentHash(contentMd)) return fail(409, MSG.nothingToPublish);

    const [previous] = await tx<{ id: string; version: number }[]>`
      select id, version from iep_plans where case_id = ${plan.case_id} and status = 'active' and id <> ${plan.id} for update`;
    if (previous) {
      await tx`update iep_plans set status = 'archived', version = version + 1, updated_at = now() where id = ${previous.id}`;
      await auditTx(tx, {
        caseId: plan.case_id,
        actorUserId: input.actorUserId,
        action: "iep.plan_archived",
        entity: "iep_plan",
        entityId: previous.id,
        details: { from: "active", to: "archived", reason: "replaced", replaced_by: plan.id, version: previous.version + 1 },
      });
    }
    await tx`update iep_plans set status = 'active', version = version + 1, updated_at = now() where id = ${plan.id}`;

    const published = await publishVersion(tx, {
      entityType: "iep_plan",
      entityId: plan.id,
      caseId: plan.case_id,
      contentMd,
      visibleToGuardian: true,
      publishedBy: input.actorUserId,
    });
    const snapshot: PublishedGoal[] = orderGoals(goals).map((g) => ({
      id: g.id,
      domain: g.domain,
      statement: g.statement,
      measure_type: g.measure_type,
      baseline_value: g.baseline_value,
      target_value: g.target_value,
      target_date: g.target_date,
      status: g.status,
      sort: g.sort,
    }));
    await tx`
      insert into iep_publications (published_version_id, plan_id, plan_version, title, goals)
      values (${published.id}, ${plan.id}, ${plan.version + 1}, ${plan.title}, ${tx.json(snapshot as unknown as postgres.JSONValue)})`;
    await auditTx(tx, {
      caseId: plan.case_id,
      actorUserId: input.actorUserId,
      action: "iep.published",
      entity: "iep_plan",
      entityId: plan.id,
      details: { published_version_id: published.id, published_version: published.version, goals: goals.length, plan_version: plan.version + 1 },
    });
    const eventId = await enqueue(tx, {
      topic: "iep.published",
      aggregateType: "iep_plan",
      aggregateId: plan.id,
      payload: { plan_id: plan.id, child_id: plan.child_id, case_id: plan.case_id },
      dedupKey: `iep:${plan.id}:v${published.version}`,
    });
    return {
      ok: true as const,
      plan: (await loadPlan(tx, plan.id)) as PlanRow,
      published,
      archived_plan_id: previous?.id ?? null,
      event_ids: [eventId],
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Goal writes

/** Plan of a goal, locked, plus the goal. */
async function lockGoal(tx: Tx, goalId: string): Promise<{ plan: PlanRow; goal: GoalRow } | null> {
  if (!isUuid(goalId)) return null;
  const [ref] = await tx<{ plan_id: string }[]>`select plan_id from iep_goals where id = ${goalId}`;
  if (!ref) return null;
  const plan = await loadPlan(tx, ref.plan_id, true);
  if (!plan) return null;
  const [goal] = await tx<GoalRow[]>`select ${tx.unsafe(GOAL_COLS)} from iep_goals g where g.id = ${goalId} for update`;
  return goal ? { plan, goal: withIso(goal) } : null;
}

async function bumpPlan(tx: Tx, planId: string): Promise<number> {
  const [row] = await tx<{ version: number }[]>`
    update iep_plans set version = version + 1, updated_at = now() where id = ${planId} returning version`;
  return row.version;
}

export async function addGoal(input: {
  planId: string;
  actorUserId: string;
  body: GoalCreateInput;
}): Promise<{ ok: true; goal: GoalRow; plan_version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const plan = await loadPlan(tx, input.planId, true);
    if (!plan) return fail(404, MSG.planNotFound);
    if (plan.version !== input.body.version) return fail(409, MSG.stale, { version: plan.version });
    if (CLOSED.includes(plan.status)) return fail(409, MSG.closed);
    const g = omitVersion(input.body);
    if (!targetDateInPlan(g.target_date, plan)) return fail(400, "Invalid request", { target_date: MSG.targetDateRange });
    const [{ count, next_sort }] = await tx<{ count: number; next_sort: number }[]>`
      select count(*)::int as count, coalesce(max(sort) + 1, 0)::int as next_sort from iep_goals where plan_id = ${plan.id}`;
    if (count >= MAX_GOALS_PER_PLAN) return fail(422, MSG.tooManyGoals);

    const [created] = await tx<{ id: string }[]>`
      insert into iep_goals (plan_id, domain, statement, specific, measurable, achievable, relevant, time_bound,
                             measure_type, baseline_value, target_value, target_date, sort, created_by)
      values (${plan.id}, ${g.domain}, ${g.statement}, ${g.specific}, ${g.measurable}, ${g.achievable}, ${g.relevant},
              ${g.time_bound}, ${g.measure_type}, ${g.baseline_value}, ${g.target_value}, ${g.target_date}, ${next_sort},
              ${input.actorUserId})
      returning id`;
    const planVersion = await bumpPlan(tx, plan.id);
    await auditTx(tx, {
      caseId: plan.case_id,
      actorUserId: input.actorUserId,
      action: "iep.goal_added",
      entity: "iep_goal",
      entityId: created.id,
      details: { plan_id: plan.id, domain: g.domain, measure_type: g.measure_type, plan_version: planVersion },
    });
    const [goal] = await tx<GoalRow[]>`select ${tx.unsafe(GOAL_COLS)} from iep_goals g where g.id = ${created.id}`;
    return { ok: true as const, goal: withIso(goal), plan_version: planVersion };
  });
}

export async function updateGoal(input: {
  goalId: string;
  actorUserId: string;
  body: GoalPatchInput;
}): Promise<{ ok: true; goal: GoalRow; plan_version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockGoal(tx, input.goalId);
    if (!locked) return fail(404, MSG.goalNotFound);
    const { plan, goal } = locked;
    if (plan.version !== input.body.version) return fail(409, MSG.stale, { version: plan.version });
    if (CLOSED.includes(plan.status)) return fail(409, MSG.closed);
    const changes = omitVersion(input.body);
    const next = { ...goal, ...changes };
    const valueErrors = goalValueErrors(next);
    if (Object.keys(valueErrors).length > 0) return fail(400, "Invalid request", valueErrors);
    if (!targetDateInPlan(next.target_date, plan)) return fail(400, "Invalid request", { target_date: MSG.targetDateRange });
    if (next.measure_type !== goal.measure_type) {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from goal_progress where goal_id = ${goal.id}`;
      if (n > 0) return fail(409, MSG.measureLocked);
    }
    await tx`
      update iep_goals
      set domain = ${next.domain}, statement = ${next.statement}, specific = ${next.specific},
          measurable = ${next.measurable}, achievable = ${next.achievable}, relevant = ${next.relevant},
          time_bound = ${next.time_bound}, measure_type = ${next.measure_type}, baseline_value = ${next.baseline_value},
          target_value = ${next.target_value}, target_date = ${next.target_date}, status = ${next.status},
          sort = ${next.sort}, updated_at = now()
      where id = ${goal.id}`;
    const planVersion = await bumpPlan(tx, plan.id);
    await auditTx(tx, {
      caseId: plan.case_id,
      actorUserId: input.actorUserId,
      action: "iep.goal_updated",
      entity: "iep_goal",
      entityId: goal.id,
      details: {
        plan_id: plan.id,
        fields: Object.keys(changes),
        ...(changes.status && changes.status !== goal.status ? { from: goal.status, to: changes.status } : {}),
        plan_version: planVersion,
      },
    });
    const [row] = await tx<GoalRow[]>`select ${tx.unsafe(GOAL_COLS)} from iep_goals g where g.id = ${goal.id}`;
    return { ok: true as const, goal: withIso(row), plan_version: planVersion };
  });
}

/** Draft plans: the goal is deleted. Active plans: it is marked `discontinued` (kept with its progress). */
export async function deleteGoal(input: {
  goalId: string;
  actorUserId: string;
  version?: number | null;
}): Promise<{ ok: true; deleted: boolean; goal: GoalRow | null; plan_version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockGoal(tx, input.goalId);
    if (!locked) return fail(404, MSG.goalNotFound);
    const { plan, goal } = locked;
    if (input.version != null && plan.version !== input.version) return fail(409, MSG.stale, { version: plan.version });
    if (CLOSED.includes(plan.status)) return fail(409, MSG.closed);
    if (plan.status === "draft") {
      await tx`delete from iep_goals where id = ${goal.id}`;
      const planVersion = await bumpPlan(tx, plan.id);
      await auditTx(tx, {
        caseId: plan.case_id,
        actorUserId: input.actorUserId,
        action: "iep.goal_deleted",
        entity: "iep_goal",
        entityId: goal.id,
        details: { plan_id: plan.id, plan_version: planVersion },
      });
      return { ok: true as const, deleted: true, goal: null, plan_version: planVersion };
    }
    if (goal.status === "discontinued") return fail(409, MSG.goalDiscontinued);
    await tx`update iep_goals set status = 'discontinued', updated_at = now() where id = ${goal.id}`;
    const planVersion = await bumpPlan(tx, plan.id);
    await auditTx(tx, {
      caseId: plan.case_id,
      actorUserId: input.actorUserId,
      action: "iep.goal_discontinued",
      entity: "iep_goal",
      entityId: goal.id,
      details: { plan_id: plan.id, from: goal.status, plan_version: planVersion },
    });
    const [row] = await tx<GoalRow[]>`select ${tx.unsafe(GOAL_COLS)} from iep_goals g where g.id = ${goal.id}`;
    return { ok: true as const, deleted: false, goal: withIso(row), plan_version: planVersion };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Progress

export type RecordProgressInput = {
  goalId: string;
  actorUserId: string;
  observedOn: string;
  value: number;
  note?: string | null;
  /** 038: `ai_suggested_confirmed` once a provider confirmed an AI suggestion; then pass the session recording. */
  source?: ProgressSource;
  recordingId?: string | null;
};

export async function recordProgress(input: RecordProgressInput): Promise<{ ok: true; entry: ProgressRow; trend: GoalTrend } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    if (!isUuid(input.goalId)) return fail(404, MSG.goalNotFound);
    // Share lock: progress does not change the plan, but must not race a plan closing or a goal edit.
    const [row] = await tx<(GoalRow & { case_id: string; plan_status: PlanStatus })[]>`
      select ${tx.unsafe(GOAL_COLS)}, p.case_id, p.status as plan_status
      from iep_goals g join iep_plans p on p.id = g.plan_id
      where g.id = ${input.goalId}
      for share of p, g`;
    if (!row) return fail(404, MSG.goalNotFound);
    if (CLOSED.includes(row.plan_status)) return fail(409, MSG.closed);
    if (row.status === "discontinued") return fail(409, MSG.goalDiscontinued);
    if (!valueInRange(row.measure_type, input.value)) return fail(400, "Invalid request", { value: MSG.valueRange });
    if (input.recordingId) {
      const [rec] = await tx<{ id: string }[]>`select id from recordings where id = ${input.recordingId} and case_id = ${row.case_id}`;
      if (!rec) return fail(422, MSG.recordingNotInCase);
    }
    const source = input.source ?? "manual";
    const [created] = await tx<{ id: string }[]>`
      insert into goal_progress (goal_id, recorded_by, observed_on, value, note, source, recording_id)
      values (${row.id}, ${input.actorUserId}, ${input.observedOn}, ${input.value}, ${input.note ?? null}, ${source},
              ${input.recordingId ?? null})
      returning id`;
    await auditTx(tx, {
      caseId: row.case_id,
      actorUserId: input.actorUserId,
      action: "iep.progress_recorded",
      entity: "goal_progress",
      entityId: created.id,
      details: { goal_id: row.id, plan_id: row.plan_id, observed_on: input.observedOn, source, recording_id: input.recordingId ?? null },
    });
    const points = await loadProgress(tx, [row.id]);
    const entry = points.find((p) => p.id === created.id) as ProgressRow;
    return { ok: true as const, entry, trend: goalTrend(points, row) };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Published reads (guardians, sharing). Only published snapshots + live progress values (no notes).

export type PublishedPoint = { observed_on: string; value: number };
export type PublishedGoalView = PublishedGoal & { points: PublishedPoint[]; trend: GoalTrend };
export type PublishedPlanView = {
  plan_id: string;
  org_id: string;
  org_name: string;
  case_id: string | null;
  title: string;
  version: number;
  published_at: string;
  content_md: string;
  goals: PublishedGoalView[];
};

type PublicationRow = {
  published_version_id: string;
  plan_id: string;
  title: string;
  goals: PublishedGoal[];
  org_name: string;
};

async function publishedGoalViews(tx: Tx, goals: PublishedGoal[]): Promise<PublishedGoalView[]> {
  const ids = goals.map((g) => g.id).filter(isUuid);
  const rows = ids.length
    ? await tx<{ goal_id: string; observed_on: string; value: number; created_at: Date }[]>`
        select goal_id, observed_on::text as observed_on, value::float8 as value, created_at
        from goal_progress where goal_id = any(${ids}::uuid[]) order by observed_on, created_at`
    : [];
  return goals.map((g) => {
    const mine = sortPoints(rows.filter((r) => r.goal_id === g.id).map((r) => ({ ...r, created_at: iso(r.created_at) })));
    return {
      ...g,
      points: mine.map((p) => ({ observed_on: p.observed_on, value: p.value })),
      trend: goalTrend(mine, g),
    };
  });
}

async function publicationsFor(tx: Tx, versions: PublishedVersion[]): Promise<Map<string, PublicationRow>> {
  if (versions.length === 0) return new Map();
  const rows = await tx<PublicationRow[]>`
    select ip.published_version_id, ip.plan_id, ip.title, ip.goals, o.name as org_name
    from iep_publications ip
    join published_versions pv on pv.id = ip.published_version_id
    join organizations o on o.id = pv.org_id
    where ip.published_version_id = any(${versions.map((v) => v.id)}::uuid[])`;
  return new Map(rows.map((r) => [r.published_version_id, r]));
}

async function toViews(tx: Tx, versions: PublishedVersion[]): Promise<PublishedPlanView[]> {
  const pubs = await publicationsFor(tx, versions);
  const out: PublishedPlanView[] = [];
  for (const v of versions) {
    const pub = pubs.get(v.id);
    if (!pub) continue;
    out.push({
      plan_id: v.entity_id,
      org_id: v.org_id,
      org_name: pub.org_name,
      case_id: v.case_id,
      title: pub.title,
      version: v.version,
      published_at: v.published_at,
      content_md: v.content_md,
      goals: await publishedGoalViews(tx, pub.goals),
    });
  }
  return out;
}

/**
 * FR-6: the latest published plan per organisation for a child, newest first. Caller checked the guardian's
 * active link (requireChildGuardian[Page]). Draft text never leaves here (NFR-1): plan and goal wording come from
 * the published version and its snapshot; progress values are live (D-3), notes are not included.
 */
export async function getGuardianPlans(childId: string): Promise<PublishedPlanView[]> {
  const sql = await db();
  const visible = await listGuardianVisible(sql, childId, "iep_plan");
  const latestPerOrg = new Map<string, PublishedVersion>();
  for (const v of visible) {
    const current = latestPerOrg.get(v.org_id);
    if (!current || v.published_at > current.published_at) latestPerOrg.set(v.org_id, v);
  }
  const views = await toViews(sql, [...latestPerOrg.values()]);
  return views.sort((a, b) => b.published_at.localeCompare(a.published_at));
}

/**
 * Share scope `iep` (022 loader): the latest published version of each plan of the child in the source orgs.
 * `planId` narrows to one plan. Callers checked the grant (requireSharedAccess / getActiveGrants).
 */
export async function listSharedPlans(childId: string, sourceOrgIds: string[], planId?: string): Promise<PublishedPlanView[]> {
  if (sourceOrgIds.length === 0 || (planId !== undefined && !isUuid(planId))) return [];
  const sql = await db();
  const rows = await sql<Record<string, unknown>[]>`
    select distinct on (pv.entity_id) pv.*
    from published_versions pv
    join iep_plans p on p.id = pv.entity_id
    join cases c on c.id = p.case_id and c.child_id = ${childId} and c.org_id = any(${sourceOrgIds}::uuid[])
    where pv.entity_type = 'iep_plan'
      and pv.child_id = ${childId}
      and pv.org_id = any(${sourceOrgIds}::uuid[])
      ${planId ? sql`and pv.entity_id = ${planId}` : sql``}
    order by pv.entity_id, pv.version desc`;
  const versions = rows.map((r) => ({ ...(r as PublishedVersion), published_at: iso(r.published_at) }));
  return (await toViews(sql, versions)).sort((a, b) => b.published_at.localeCompare(a.published_at));
}
