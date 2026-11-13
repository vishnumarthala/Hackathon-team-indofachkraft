// Ticket 026 FR-1..FR-7: home programs, activities and guardian practice logs. Server only.
//
// Access: callers have passed a gate first. Providers -> requireCaseActor (case routes),
// requireHomeProgramActor / requireHomeActivityActor (lib/home-program/authz.ts; 022's case-access rule).
// Guardians -> requireGuardian + requireChildGuardian; guardian readers here return PUBLISHED content only (NFR-2).
//
// Writes: one transaction each that locks the program row (publishing also locks the case row), checks the
// optimistic `version` when given (stale -> 409 MSG.stale; PATCH program and publish require it) and writes its audit
// row (`home_program.*`) in the same transaction. Program and activity edits bump the program version; guardian logs
// do not. Publishing renders the program (lib/home-program/markdown.ts), calls 024 publishVersion (entity_type
// 'home_program', visible to guardians), stores the activity snapshot in `home_program_publications`, archives the
// case's previously published program and enqueues outbox `home_program.published` (032).
//
// Typed entry point for 040 (follow-up agent): `getGuardianHomePrograms(childId)` = the published, guardian-visible
// programs of a child (snapshot wording only, this week's adherence, no guardian notes).
import type postgres from "postgres";
import { auditStrict } from "@/lib/audit";
import { contentHash, getLatestPublished, publishVersion, type PublishedVersion } from "@/lib/clinical/publish";
import { isUuid } from "@/lib/cases/validation";
import {
  addDays,
  adherence,
  lastSevenDays,
  mondayOf,
  todayIn,
  weekStartFor,
  weeklySeries,
  type Adherence,
} from "@/lib/home-program/adherence";
import { homeProgramMarkdown, type MarkdownActivity } from "@/lib/home-program/markdown";
import {
  MAX_ACTIVE_ACTIVITIES,
  MSG,
  type ActivityCreateInput,
  type ActivityPatchInput,
  type Difficulty,
  type LogInput,
  type ProgramCreateInput,
  type ProgramPatchInput,
  type ProgramStatus,
} from "@/lib/home-program/schema";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/i18n/config";
import { enqueue } from "@/lib/notify/outbox";
import { pg as db } from "@/lib/pg";

type Tx = postgres.Sql | postgres.TransactionSql;

export type ProgramRow = {
  id: string;
  case_id: string;
  child_id: string;
  org_id: string;
  plan_id: string | null;
  title: string;
  status: ProgramStatus;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ActivityRow = {
  id: string;
  program_id: string;
  goal_id: string | null;
  title: string;
  instructions_md: string;
  frequency_per_week: number;
  duration_min: number;
  materials: string | null;
  document_id: string | null;
  sort: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type LogRow = {
  id: string;
  activity_id: string;
  child_id: string;
  logged_by: string | null;
  done_on: string;
  duration_min: number | null;
  difficulty: Difficulty;
  note: string | null;
  created_at: string;
  updated_at: string;
};

/** One activity as published (home_program_publications.activities). Guardian views use only this wording. */
export type SnapshotActivity = {
  id: string;
  goal_id: string | null;
  /** Published wording of the linked goal (025 iep_publications), or null. */
  goal_statement: string | null;
  title: string;
  instructions_md: string;
  frequency_per_week: number;
  duration_min: number;
  materials: string | null;
  document_id: string | null;
  sort: number;
};

export type PublishedInfo = { version: number; published_at: string; published_by: string | null };

export type ProgramSummary = ProgramRow & {
  /** Active activities. */
  activity_count: number;
  published: PublishedInfo | null;
  /** Published at least once and the current program renders differently from the latest published version. */
  has_unpublished_changes: boolean;
};

export type RecentLog = {
  id: string;
  done_on: string;
  difficulty: Difficulty;
  duration_min: number | null;
  note: string | null;
  logged_by_name: string | null;
};

export type ActivityAdherence = {
  activity_id: string;
  last_7_days: { from: string; to: string; done: number; expected: number; percent: number; met: boolean };
  /** The last 4 Monday-start weeks, oldest first (sparkline). */
  weeks: Adherence[];
  /** Up to 5 most recent logs that carry a guardian note. */
  recent_notes: RecentLog[];
};

export type ProviderActivity = ActivityRow & {
  /** Live goal wording (care team only). */
  goal_statement: string | null;
  document_title: string | null;
};

export type ProgramDetail = {
  program: ProgramSummary;
  activities: ProviderActivity[];
  published_md: string | null;
  adherence: ActivityAdherence[];
  /** Guardian time zone the adherence weeks are computed in, and "today" there. */
  time_zone: string;
  today: string;
};

export type Failure = { ok: false; status: 400 | 404 | 409 | 422; error: string; details?: Record<string, unknown> };

const fail = (status: Failure["status"], error: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  status,
  error,
  ...(details ? { details } : {}),
});

const PROGRAM_COLS = `p.id, p.case_id, p.child_id, p.org_id, p.plan_id, p.title, p.status, p.version, p.created_by,
  p.created_at, p.updated_at`;
const ACTIVITY_COLS = `a.id, a.program_id, a.goal_id, a.title, a.instructions_md, a.frequency_per_week, a.duration_min,
  a.materials, a.document_id, a.sort, a.active, a.created_at, a.updated_at`;
const LOG_COLS = `l.id, l.activity_id, l.child_id, l.logged_by, l.done_on::text as done_on, l.duration_min, l.difficulty,
  l.note, l.created_at, l.updated_at`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
function withIso<T extends Record<string, unknown>>(row: T, keys: string[] = ["created_at", "updated_at"]): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) if (k in out && out[k] != null) out[k] = iso(out[k]);
  return out as T;
}

function omitVersion<T extends { version?: number }>(body: T): Omit<T, "version"> {
  const out: Record<string, unknown> = { ...body };
  delete out.version;
  return out as Omit<T, "version">;
}

// 041: strict audit in the caller's transaction (fails closed: AuditWriteError rolls the change back), attributed to
// the acting session user; the database fills actor_role, child_id and org_id.
async function auditTx(
  tx: Tx,
  e: {
    caseId: string;
    actorUserId: string;
    action: string;
    entity: "home_program" | "home_activity" | "home_activity_log";
    entityId: string;
    details?: Record<string, unknown>;
  },
) {
  await auditStrict(
    { caseId: e.caseId, actorUserId: e.actorUserId, action: e.action, entity: e.entity, entityId: e.entityId, details: e.details ?? {} },
    tx,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Loaders

async function loadProgram(tx: Tx, programId: string, lock = false): Promise<ProgramRow | null> {
  if (!isUuid(programId)) return null;
  const rows = lock
    ? await tx<ProgramRow[]>`select ${tx.unsafe(PROGRAM_COLS)} from home_programs p where p.id = ${programId} for update`
    : await tx<ProgramRow[]>`select ${tx.unsafe(PROGRAM_COLS)} from home_programs p where p.id = ${programId}`;
  return rows[0] ? withIso(rows[0]) : null;
}

async function loadActivities(tx: Tx, programId: string): Promise<ActivityRow[]> {
  const rows = await tx<ActivityRow[]>`
    select ${tx.unsafe(ACTIVITY_COLS)} from home_activities a where a.program_id = ${programId}
    order by a.sort, a.created_at`;
  return rows.map((r) => withIso(r));
}

async function loadActivity(tx: Tx, activityId: string): Promise<ActivityRow | null> {
  if (!isUuid(activityId)) return null;
  const [row] = await tx<ActivityRow[]>`select ${tx.unsafe(ACTIVITY_COLS)} from home_activities a where a.id = ${activityId}`;
  return row ? withIso(row) : null;
}

/** Published wording of goals (latest 025 publication that contains each goal). Unpublished goals are absent. */
async function publishedGoalStatements(tx: Tx, goalIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(goalIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await tx<{ id: string; statement: string }[]>`
    select distinct on (g ->> 'id') g ->> 'id' as id, g ->> 'statement' as statement
    from iep_publications ip, jsonb_array_elements(ip.goals) g
    where g ->> 'id' = any(${ids}::text[])
    order by g ->> 'id', ip.created_at desc`;
  return new Map(rows.map((r) => [r.id, r.statement]));
}

function toMarkdownActivities(activities: ActivityRow[], goals: Map<string, string>): MarkdownActivity[] {
  return activities
    .filter((a) => a.active)
    .map((a) => ({
      title: a.title,
      instructions_md: a.instructions_md,
      frequency_per_week: a.frequency_per_week,
      duration_min: a.duration_min,
      materials: a.materials,
      goal_statement: a.goal_id ? (goals.get(a.goal_id) ?? null) : null,
      has_guide: Boolean(a.document_id),
    }));
}

async function render(tx: Tx, program: Pick<ProgramRow, "title">, activities: ActivityRow[]): Promise<string> {
  const goals = await publishedGoalStatements(tx, activities.filter((a) => a.active).map((a) => a.goal_id));
  return homeProgramMarkdown(program, toMarkdownActivities(activities, goals));
}

async function summarise(tx: Tx, program: ProgramRow, activities: ActivityRow[]): Promise<{ summary: ProgramSummary; publishedMd: string | null }> {
  const latest = await getLatestPublished(tx, "home_program", program.id);
  return {
    summary: {
      ...program,
      activity_count: activities.filter((a) => a.active).length,
      published: latest ? { version: latest.version, published_at: latest.published_at, published_by: latest.published_by } : null,
      has_unpublished_changes: latest ? contentHash(await render(tx, program, activities)) !== latest.content_hash : false,
    },
    publishedMd: latest?.content_md ?? null,
  };
}

/**
 * The time zone adherence weeks are counted in for a child: the zone saved by its (earliest linked, active)
 * guardian's browser (018 `user_profiles.time_zone`), else Asia/Kolkata.
 */
export async function childTimeZone(childId: string, sql?: Tx): Promise<string> {
  const q = sql ?? (await db());
  const rows = await q<{ time_zone: string | null }[]>`
    select up.time_zone from guardian_links gl join user_profiles up on up.id = gl.user_id
    where gl.child_id = ${childId} and gl.status = 'active' and up.time_zone is not null
    order by gl.created_at limit 1`;
  const tz = rows[0]?.time_zone;
  return isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

// ---------------------------------------------------------------------------------------------------------
// Provider reads (caller passed the case / program gate)

/** Programs of a case, published first, then newest. */
export async function listCasePrograms(caseId: string): Promise<ProgramSummary[]> {
  const sql = await db();
  const programs = (await sql<ProgramRow[]>`
    select ${sql.unsafe(PROGRAM_COLS)} from home_programs p where p.case_id = ${caseId}
    order by (p.status = 'published') desc, (p.status = 'archived'), p.created_at desc`).map((r) => withIso(r));
  const out: ProgramSummary[] = [];
  for (const program of programs) out.push((await summarise(sql, program, await loadActivities(sql, program.id))).summary);
  return out;
}

async function logsSince(tx: Tx, activityIds: string[], from: string): Promise<(LogRow & { logged_by_name: string | null })[]> {
  if (activityIds.length === 0) return [];
  const rows = await tx<(LogRow & { logged_by_name: string | null })[]>`
    select ${tx.unsafe(LOG_COLS)}, up.display_name as logged_by_name
    from home_activity_logs l left join user_profiles up on up.id = l.logged_by
    where l.activity_id = any(${activityIds}::uuid[]) and l.done_on >= ${from}
    order by l.done_on desc, l.created_at desc`;
  return rows.map((r) => withIso(r));
}

function activityAdherence(
  logs: (LogRow & { logged_by_name: string | null })[],
  activity: Pick<ActivityRow, "id" | "frequency_per_week">,
  today: string,
): ActivityAdherence {
  const mine = logs.filter((l) => l.activity_id === activity.id);
  return {
    activity_id: activity.id,
    last_7_days: lastSevenDays(mine, activity, today),
    weeks: weeklySeries(mine, activity, today, 4),
    recent_notes: mine
      .filter((l) => l.note)
      .slice(0, 5)
      .map((l) => ({
        id: l.id,
        done_on: l.done_on,
        difficulty: l.difficulty,
        duration_min: l.duration_min,
        note: l.note,
        logged_by_name: l.logged_by_name,
      })),
  };
}

/** One program with activities and adherence. `caseId` (optional) must match the program's case. */
export async function getProgramDetail(programId: string, caseId?: string, opts: { now?: Date } = {}): Promise<ProgramDetail | null> {
  const sql = await db();
  const program = await loadProgram(sql, programId);
  if (!program || (caseId && program.case_id !== caseId)) return null;
  const activities = await loadActivities(sql, program.id);
  const { summary, publishedMd } = await summarise(sql, program, activities);
  const goalIds = activities.map((a) => a.goal_id).filter((id): id is string => Boolean(id));
  const goals = goalIds.length
    ? await sql<{ id: string; statement: string }[]>`select id, statement from iep_goals where id = any(${goalIds}::uuid[])`
    : [];
  const docIds = activities.map((a) => a.document_id).filter((id): id is string => Boolean(id));
  const docs = docIds.length
    ? await sql<{ id: string; title: string }[]>`select id, title from documents where id = any(${docIds}::uuid[]) and status = 'ready'`
    : [];
  const timeZone = await childTimeZone(program.child_id, sql);
  const today = todayIn(timeZone, opts.now);
  const logs = await logsSince(sql, activities.map((a) => a.id), addDays(mondayOf(today), -21));
  return {
    program: summary,
    published_md: publishedMd,
    activities: activities.map((a) => ({
      ...a,
      goal_statement: goals.find((g) => g.id === a.goal_id)?.statement ?? null,
      document_title: docs.find((d) => d.id === a.document_id)?.title ?? null,
    })),
    adherence: activities.map((a) => activityAdherence(logs, a, today)),
    time_zone: timeZone,
    today,
  };
}

export type GoalOption = { id: string; statement: string; domain: string };
export type GuideOption = { id: string; title: string; file_name: string; mime_type: string };

/** `Linked goal` choices: goals of the case's active IEP plan (025), excluding discontinued ones. */
export async function listGoalOptions(caseId: string): Promise<GoalOption[]> {
  const sql = await db();
  return sql<GoalOption[]>`
    select g.id, g.statement, g.domain from iep_goals g join iep_plans p on p.id = g.plan_id
    where p.case_id = ${caseId} and p.status = 'active' and g.status <> 'discontinued'
    order by g.sort, g.created_at`;
}

/** `Attach guide` choices: ready provider documents of the case that the parent can see (023). */
export async function listGuideOptions(caseId: string): Promise<GuideOption[]> {
  const sql = await db();
  return sql<GuideOption[]>`
    select id, title, file_name, mime_type from documents
    where case_id = ${caseId} and status = 'ready' and uploader_kind = 'provider' and visible_to_guardian
    order by created_at desc`;
}

// ---------------------------------------------------------------------------------------------------------
// Program writes

export async function createProgram(input: {
  caseId: string;
  actorUserId: string;
  body: ProgramCreateInput;
}): Promise<{ ok: true; program: ProgramRow } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const [kase] = await tx<{ id: string; child_id: string | null }[]>`select id, child_id from cases where id = ${input.caseId}`;
    if (!kase) return fail(404, "Case not found");
    if (!kase.child_id) return fail(422, MSG.noCaseChild);
    const [created] = await tx<{ id: string }[]>`
      insert into home_programs (case_id, child_id, org_id, plan_id, title, created_by)
      select c.id, c.child_id, c.org_id,
             (select ip.id from iep_plans ip where ip.case_id = c.id and ip.status = 'active'),
             ${input.body.title}, ${input.actorUserId}
      from cases c where c.id = ${kase.id}
      returning id`;
    await auditTx(tx, {
      caseId: kase.id,
      actorUserId: input.actorUserId,
      action: "home_program.created",
      entity: "home_program",
      entityId: created.id,
    });
    return { ok: true as const, program: (await loadProgram(tx, created.id)) as ProgramRow };
  });
}

export async function updateProgram(input: {
  programId: string;
  actorUserId: string;
  body: ProgramPatchInput;
}): Promise<{ ok: true; program: ProgramRow } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const program = await loadProgram(tx, input.programId, true);
    if (!program) return fail(404, MSG.programNotFound);
    if (program.version !== input.body.version) return fail(409, MSG.stale, { version: program.version });
    if (program.status === "archived") return fail(409, MSG.archived);
    const { status, title } = omitVersion(input.body);
    await tx`
      update home_programs set title = ${title ?? program.title}, status = ${status ?? program.status},
        version = version + 1, updated_at = now()
      where id = ${program.id}`;
    await auditTx(tx, {
      caseId: program.case_id,
      actorUserId: input.actorUserId,
      action: status ? "home_program.archived" : "home_program.updated",
      entity: "home_program",
      entityId: program.id,
      details: { fields: title !== undefined ? ["title"] : [], ...(status ? { from: program.status, to: status } : {}), version: program.version + 1 },
    });
    return { ok: true as const, program: (await loadProgram(tx, program.id)) as ProgramRow };
  });
}

export type PublishResult = {
  ok: true;
  program: ProgramRow;
  published: PublishedVersion;
  /** Program archived because this one became the case's published program, if any. */
  archived_program_id: string | null;
  event_ids: string[];
};

export async function publishProgram(input: { programId: string; actorUserId: string; version: number }): Promise<PublishResult | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const probe = await loadProgram(tx, input.programId);
    if (!probe) return fail(404, MSG.programNotFound);
    // Lock the case first so two publishes for the same case serialise (one published program per case).
    await tx`select id from cases where id = ${probe.case_id} for update`;
    const program = await loadProgram(tx, input.programId, true);
    if (!program) return fail(404, MSG.programNotFound);
    if (program.version !== input.version) return fail(409, MSG.stale, { version: program.version });
    if (program.status === "archived") return fail(409, MSG.archived);
    const activities = await loadActivities(tx, program.id);
    const active = activities.filter((a) => a.active);
    if (active.length === 0) return fail(422, MSG.noActivities);

    const goals = await publishedGoalStatements(tx, active.map((a) => a.goal_id));
    const contentMd = homeProgramMarkdown(program, toMarkdownActivities(activities, goals));
    const latest = await getLatestPublished(tx, "home_program", program.id);
    if (latest && program.status === "published" && latest.content_hash === contentHash(contentMd)) {
      return fail(409, MSG.nothingToPublish);
    }

    const [previous] = await tx<{ id: string; version: number }[]>`
      select id, version from home_programs where case_id = ${program.case_id} and status = 'published' and id <> ${program.id}
      for update`;
    if (previous) {
      await tx`update home_programs set status = 'archived', version = version + 1, updated_at = now() where id = ${previous.id}`;
      await auditTx(tx, {
        caseId: program.case_id,
        actorUserId: input.actorUserId,
        action: "home_program.archived",
        entity: "home_program",
        entityId: previous.id,
        details: { from: "published", to: "archived", reason: "replaced", replaced_by: program.id, version: previous.version + 1 },
      });
    }
    await tx`update home_programs set status = 'published', version = version + 1, updated_at = now() where id = ${program.id}`;

    const published = await publishVersion(tx, {
      entityType: "home_program",
      entityId: program.id,
      caseId: program.case_id,
      contentMd,
      visibleToGuardian: true,
      publishedBy: input.actorUserId,
    });
    const snapshot: SnapshotActivity[] = active.map((a) => ({
      id: a.id,
      goal_id: a.goal_id,
      goal_statement: a.goal_id ? (goals.get(a.goal_id) ?? null) : null,
      title: a.title,
      instructions_md: a.instructions_md,
      frequency_per_week: a.frequency_per_week,
      duration_min: a.duration_min,
      materials: a.materials,
      document_id: a.document_id,
      sort: a.sort,
    }));
    await tx`
      insert into home_program_publications (published_version_id, program_id, program_version, title, activities)
      values (${published.id}, ${program.id}, ${program.version + 1}, ${program.title},
              ${tx.json(snapshot as unknown as postgres.JSONValue)})`;
    await auditStrict(
      {
        caseId: program.case_id,
        actorUserId: input.actorUserId,
        action: "home_program.published",
        entity: "home_program",
        entityId: program.id,
        details: { published_version_id: published.id, published_version: published.version, activities: active.length, version: program.version + 1 },
      },
      tx,
    );
    const eventId = await enqueue(tx, {
      topic: "home_program.published",
      aggregateType: "home_program",
      aggregateId: program.id,
      payload: { program_id: program.id, child_id: program.child_id, case_id: program.case_id },
      dedupKey: `home_program:${program.id}:v${published.version}`,
    });
    return {
      ok: true as const,
      program: (await loadProgram(tx, program.id)) as ProgramRow,
      published,
      archived_program_id: previous?.id ?? null,
      event_ids: [eventId],
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Activity writes

async function bumpProgram(tx: Tx, programId: string): Promise<number> {
  const [row] = await tx<{ version: number }[]>`
    update home_programs set version = version + 1, updated_at = now() where id = ${programId} returning version`;
  return row.version;
}

/** FR-2: a linked goal must belong to the case's ACTIVE IEP plan (and not be discontinued). */
async function goalInActivePlan(tx: Tx, caseId: string, goalId: string): Promise<{ plan_id: string } | null> {
  const [row] = await tx<{ plan_id: string }[]>`
    select g.plan_id from iep_goals g join iep_plans p on p.id = g.plan_id
    where g.id = ${goalId} and p.case_id = ${caseId} and p.status = 'active' and g.status <> 'discontinued'`;
  return row ?? null;
}

/** A guide is a ready provider document of the same case that the guardian can see (023 access rules). */
async function guideInCase(tx: Tx, caseId: string, documentId: string): Promise<boolean> {
  const rows = await tx`
    select 1 from documents
    where id = ${documentId} and case_id = ${caseId} and status = 'ready' and uploader_kind = 'provider' and visible_to_guardian`;
  return rows.length > 0;
}

async function checkLinks(
  tx: Tx,
  program: ProgramRow,
  links: { goal_id?: string | null; document_id?: string | null },
  current?: Pick<ActivityRow, "goal_id" | "document_id">,
): Promise<Failure | { planId: string | null }> {
  let planId: string | null = null;
  if (links.goal_id && links.goal_id !== current?.goal_id) {
    const found = await goalInActivePlan(tx, program.case_id, links.goal_id);
    if (!found) return fail(422, MSG.goalNotInPlan, { goal_id: MSG.goalNotInPlan });
    planId = found.plan_id;
  }
  if (links.document_id && links.document_id !== current?.document_id && !(await guideInCase(tx, program.case_id, links.document_id))) {
    return fail(422, MSG.guideNotInCase, { document_id: MSG.guideNotInCase });
  }
  return { planId };
}

async function countActive(tx: Tx, programId: string): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from home_activities where program_id = ${programId} and active`;
  return n;
}

export async function addActivity(input: {
  programId: string;
  actorUserId: string;
  body: ActivityCreateInput;
}): Promise<{ ok: true; activity: ActivityRow; program_version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const program = await loadProgram(tx, input.programId, true);
    if (!program) return fail(404, MSG.programNotFound);
    if (input.body.version !== undefined && program.version !== input.body.version) return fail(409, MSG.stale, { version: program.version });
    if (program.status === "archived") return fail(409, MSG.archived);
    const a = omitVersion(input.body);
    const links = await checkLinks(tx, program, a);
    if ("ok" in links) return links;
    if ((await countActive(tx, program.id)) >= MAX_ACTIVE_ACTIVITIES) return fail(422, MSG.tooManyActivities);
    const [{ next_sort }] = await tx<{ next_sort: number }[]>`
      select coalesce(max(sort) + 1, 0)::int as next_sort from home_activities where program_id = ${program.id}`;
    const [created] = await tx<{ id: string }[]>`
      insert into home_activities (program_id, goal_id, title, instructions_md, frequency_per_week, duration_min, materials,
                                   document_id, sort, created_by)
      values (${program.id}, ${a.goal_id ?? null}, ${a.title}, ${a.instructions_md}, ${a.frequency_per_week}, ${a.duration_min},
              ${a.materials ?? null}, ${a.document_id ?? null}, ${next_sort}, ${input.actorUserId})
      returning id`;
    if (links.planId && links.planId !== program.plan_id) await tx`update home_programs set plan_id = ${links.planId} where id = ${program.id}`;
    const programVersion = await bumpProgram(tx, program.id);
    await auditTx(tx, {
      caseId: program.case_id,
      actorUserId: input.actorUserId,
      action: "home_program.activity_added",
      entity: "home_activity",
      entityId: created.id,
      details: { program_id: program.id, goal_id: a.goal_id ?? null, document_id: a.document_id ?? null, version: programVersion },
    });
    return { ok: true as const, activity: (await loadActivity(tx, created.id)) as ActivityRow, program_version: programVersion };
  });
}

/** The program of an activity, locked, plus the activity. */
async function lockActivity(tx: Tx, activityId: string): Promise<{ program: ProgramRow; activity: ActivityRow } | null> {
  const ref = await loadActivity(tx, activityId);
  if (!ref) return null;
  const program = await loadProgram(tx, ref.program_id, true);
  if (!program) return null;
  const [row] = await tx<ActivityRow[]>`select ${tx.unsafe(ACTIVITY_COLS)} from home_activities a where a.id = ${activityId} for update`;
  return row ? { program, activity: withIso(row) } : null;
}

export async function updateActivity(input: {
  activityId: string;
  actorUserId: string;
  body: ActivityPatchInput;
}): Promise<{ ok: true; activity: ActivityRow; program_version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockActivity(tx, input.activityId);
    if (!locked) return fail(404, MSG.activityNotFound);
    const { program, activity } = locked;
    if (input.body.version !== undefined && program.version !== input.body.version) return fail(409, MSG.stale, { version: program.version });
    if (program.status === "archived") return fail(409, MSG.archived);
    const changes = Object.fromEntries(Object.entries(omitVersion(input.body)).filter(([, v]) => v !== undefined)) as Partial<ActivityRow>;
    const links = await checkLinks(tx, program, changes, activity);
    if ("ok" in links) return links;
    const next: ActivityRow = { ...activity, ...changes };
    if (next.active && !activity.active && (await countActive(tx, program.id)) >= MAX_ACTIVE_ACTIVITIES) {
      return fail(422, MSG.tooManyActivities);
    }
    await tx`
      update home_activities
      set title = ${next.title}, instructions_md = ${next.instructions_md}, frequency_per_week = ${next.frequency_per_week},
          duration_min = ${next.duration_min}, materials = ${next.materials}, goal_id = ${next.goal_id},
          document_id = ${next.document_id}, sort = ${next.sort}, active = ${next.active}, updated_at = now()
      where id = ${activity.id}`;
    if (links.planId && links.planId !== program.plan_id) await tx`update home_programs set plan_id = ${links.planId} where id = ${program.id}`;
    const programVersion = await bumpProgram(tx, program.id);
    await auditTx(tx, {
      caseId: program.case_id,
      actorUserId: input.actorUserId,
      action: "home_program.activity_updated",
      entity: "home_activity",
      entityId: activity.id,
      details: {
        program_id: program.id,
        fields: Object.keys(changes),
        ...(changes.active !== undefined && changes.active !== activity.active ? { active: changes.active } : {}),
        version: programVersion,
      },
    });
    return { ok: true as const, activity: (await loadActivity(tx, activity.id)) as ActivityRow, program_version: programVersion };
  });
}

/** FR-2: a draft program's activity is deleted; otherwise it is stopped (`active = false`, logs kept). */
export async function deleteActivity(input: {
  activityId: string;
  actorUserId: string;
  version?: number | null;
}): Promise<{ ok: true; deleted: boolean; activity: ActivityRow | null; program_version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockActivity(tx, input.activityId);
    if (!locked) return fail(404, MSG.activityNotFound);
    const { program, activity } = locked;
    if (input.version != null && program.version !== input.version) return fail(409, MSG.stale, { version: program.version });
    if (program.status === "archived") return fail(409, MSG.archived);
    // A draft program was never published, so it has no guardian logs: delete. Otherwise keep the row and its logs.
    if (program.status === "draft") {
      await tx`delete from home_activities where id = ${activity.id}`;
      const programVersion = await bumpProgram(tx, program.id);
      await auditTx(tx, {
        caseId: program.case_id,
        actorUserId: input.actorUserId,
        action: "home_program.activity_deleted",
        entity: "home_activity",
        entityId: activity.id,
        details: { program_id: program.id, version: programVersion },
      });
      return { ok: true as const, deleted: true, activity: null, program_version: programVersion };
    }
    if (!activity.active) return { ok: true as const, deleted: false, activity, program_version: program.version };
    await tx`update home_activities set active = false, updated_at = now() where id = ${activity.id}`;
    const programVersion = await bumpProgram(tx, program.id);
    await auditTx(tx, {
      caseId: program.case_id,
      actorUserId: input.actorUserId,
      action: "home_program.activity_stopped",
      entity: "home_activity",
      entityId: activity.id,
      details: { program_id: program.id, version: programVersion },
    });
    return { ok: true as const, deleted: false, activity: (await loadActivity(tx, activity.id)) as ActivityRow, program_version: programVersion };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Published reads (guardians, sharing, 040). Only published snapshots, minus activities stopped since.

type CurrentPublication = {
  program: ProgramRow;
  version: PublishedVersion;
  title: string;
  activities: SnapshotActivity[];
  org_name: string;
};

/**
 * The CURRENT published programs (status `published`, at most one per case) with their latest published version and
 * activity snapshot. Activities stopped after publishing are left out (a provider can withdraw one at once).
 */
async function currentPublications(
  tx: Tx,
  filter: { childId: string; orgIds?: string[]; programId?: string; guardianVisibleOnly: boolean },
): Promise<CurrentPublication[]> {
  if (filter.programId !== undefined && !isUuid(filter.programId)) return [];
  if (filter.orgIds && filter.orgIds.length === 0) return [];
  const rows = await tx<(Record<string, unknown> & { pv: Record<string, unknown>; snapshot_title: string; snapshot: SnapshotActivity[]; org_name: string })[]>`
    select ${tx.unsafe(PROGRAM_COLS)}, to_jsonb(pv) as pv, hpp.title as snapshot_title, hpp.activities as snapshot, o.name as org_name
    from home_programs p
    join cases c on c.id = p.case_id and c.child_id = ${filter.childId}
    join organizations o on o.id = p.org_id
    join lateral (
      select * from published_versions v
      where v.entity_type = 'home_program' and v.entity_id = p.id
      order by v.version desc limit 1
    ) pv on true
    join home_program_publications hpp on hpp.published_version_id = pv.id
    where p.child_id = ${filter.childId} and p.status = 'published' and pv.child_id = ${filter.childId}
      ${filter.guardianVisibleOnly ? tx`and pv.visible_to_guardian` : tx``}
      ${filter.orgIds ? tx`and p.org_id = any(${filter.orgIds}::uuid[]) and pv.org_id = any(${filter.orgIds}::uuid[])` : tx``}
      ${filter.programId ? tx`and p.id = ${filter.programId}` : tx``}
    order by pv.published_at desc`;
  if (rows.length === 0) return [];
  const snapshotIds = rows.flatMap((r) => r.snapshot.map((a) => a.id));
  const live = snapshotIds.length
    ? await tx<{ id: string }[]>`select id from home_activities where id = any(${snapshotIds}::uuid[]) and active`
    : [];
  const liveIds = new Set(live.map((r) => r.id));
  return rows.map((r) => {
    const { pv, snapshot_title, snapshot, org_name, ...program } = r;
    return {
      program: withIso(program) as unknown as ProgramRow,
      version: { ...(pv as unknown as PublishedVersion), published_at: iso(pv.published_at) },
      title: snapshot_title,
      activities: snapshot.filter((a) => liveIds.has(a.id)).sort((x, y) => x.sort - y.sort),
      org_name,
    };
  });
}

export type GuardianGuide = { document_id: string; title: string; file_name: string; mime_type: string; download_url: string };

export type GuardianActivity = {
  id: string;
  title: string;
  instructions_md: string;
  frequency_per_week: number;
  duration_min: number;
  materials: string | null;
  goal: { id: string; statement: string } | null;
  /** Attached guide while it is still a ready, guardian-visible document of the child (023); else null. */
  guide: GuardianGuide | null;
  /** Adherence in the guardian's current Monday-start week (all guardians' logs). */
  this_week: Adherence;
};

export type GuardianHomeProgram = {
  program_id: string;
  case_id: string;
  org_id: string;
  org_name: string;
  title: string;
  version: number;
  published_at: string;
  /** Authoritative published text (published_versions.content_md). */
  content_md: string;
  week_start: string;
  week_end: string;
  today: string;
  time_zone: string;
  activities: GuardianActivity[];
};

/**
 * Published, guardian-visible home programs of a child (one per treating case), newest first. Caller checked the
 * guardian's active link (requireChildGuardian[Page]) or, for 040, the guardian's authorisation. Draft activities
 * and unpublished edits never leave here (NFR-2); guardian notes are not included.
 * `timeZone` = the guardian's zone (018 getTimeZone); defaults to the child's guardian zone.
 */
export async function getGuardianHomePrograms(
  childId: string,
  opts: { timeZone?: string; now?: Date } = {},
): Promise<GuardianHomeProgram[]> {
  if (!isUuid(childId)) return [];
  const sql = await db();
  const pubs = await currentPublications(sql, { childId, guardianVisibleOnly: true });
  if (pubs.length === 0) return [];
  const timeZone = opts.timeZone && isValidTimeZone(opts.timeZone) ? opts.timeZone : await childTimeZone(childId, sql);
  const today = todayIn(timeZone, opts.now);
  const weekStart = weekStartFor(opts.now ?? new Date(), timeZone);
  const activityIds = pubs.flatMap((p) => p.activities.map((a) => a.id));
  const logs = await logsSince(sql, activityIds, weekStart);
  const docIds = [...new Set(pubs.flatMap((p) => p.activities.map((a) => a.document_id)).filter((id): id is string => Boolean(id)))];
  const docs = docIds.length
    ? await sql<{ id: string; title: string; file_name: string; mime_type: string }[]>`
        select id, title, file_name, mime_type from documents
        where id = any(${docIds}::uuid[]) and child_id = ${childId} and status = 'ready' and uploader_kind = 'provider'
          and visible_to_guardian`
    : [];
  return pubs.map((p) => ({
    program_id: p.program.id,
    case_id: p.program.case_id,
    org_id: p.program.org_id,
    org_name: p.org_name,
    title: p.title,
    version: p.version.version,
    published_at: p.version.published_at,
    content_md: p.version.content_md,
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    today,
    time_zone: timeZone,
    activities: p.activities.map((a) => {
      const doc = a.document_id ? docs.find((d) => d.id === a.document_id) : undefined;
      return {
        id: a.id,
        title: a.title,
        instructions_md: a.instructions_md,
        frequency_per_week: a.frequency_per_week,
        duration_min: a.duration_min,
        materials: a.materials,
        goal: a.goal_id && a.goal_statement ? { id: a.goal_id, statement: a.goal_statement } : null,
        guide: doc
          ? { document_id: doc.id, title: doc.title, file_name: doc.file_name, mime_type: doc.mime_type, download_url: `/api/documents/${doc.id}/download` }
          : null,
        this_week: adherence(logs, a, weekStart),
      };
    }),
  }));
}

/** The viewer's own logs of this week for the given activities (guardian page: `Done today` state and `Remove`). */
export async function listOwnLogs(userId: string, activityIds: string[], from: string, to: string): Promise<LogRow[]> {
  if (activityIds.length === 0) return [];
  const sql = await db();
  const rows = await sql<LogRow[]>`
    select ${sql.unsafe(LOG_COLS)} from home_activity_logs l
    where l.logged_by = ${userId} and l.activity_id = any(${activityIds}::uuid[]) and l.done_on between ${from} and ${to}
    order by l.done_on`;
  return rows.map((r) => withIso(r));
}

/**
 * Guardian gate helper: an activity the guardian may log against = ACTIVE and part of the latest published snapshot
 * of its program's CURRENT published version. Returns the child to check the guardian link against, or null (404).
 */
export async function findPublishedActivity(activityId: string): Promise<{ activityId: string; programId: string; caseId: string; childId: string } | null> {
  if (!isUuid(activityId)) return null;
  const sql = await db();
  const [row] = await sql<{ program_id: string; case_id: string; child_id: string; in_snapshot: boolean }[]>`
    select a.program_id, p.case_id, p.child_id,
      exists (
        select 1 from home_program_publications hpp
        join published_versions pv on pv.id = hpp.published_version_id and pv.visible_to_guardian
        where hpp.program_id = p.id
          and pv.version = (select max(v.version) from published_versions v where v.entity_type = 'home_program' and v.entity_id = p.id)
          and hpp.activities @> ${sql.json([{ id: activityId }])}::jsonb
      ) as in_snapshot
    from home_activities a join home_programs p on p.id = a.program_id
    where a.id = ${activityId} and a.active and p.status = 'published'`;
  if (!row || !row.in_snapshot) return null;
  return { activityId, programId: row.program_id, caseId: row.case_id, childId: row.child_id };
}

/** FR-5: one log per activity, day and guardian; the same activity + date again updates it (idempotent retries). */
export async function saveLog(input: {
  activityId: string;
  userId: string;
  body: LogInput;
}): Promise<{ ok: true; created: boolean; log: LogRow }> {
  const sql = await db();
  const [row] = await sql<(LogRow & { inserted: boolean })[]>`
    insert into home_activity_logs as l (activity_id, child_id, logged_by, done_on, duration_min, difficulty, note)
    select a.id, p.child_id, ${input.userId}, ${input.body.done_on}, ${input.body.duration_min}, ${input.body.difficulty}, ${input.body.note}
    from home_activities a join home_programs p on p.id = a.program_id
    where a.id = ${input.activityId}
    on conflict (activity_id, done_on, logged_by) do update
      set difficulty = excluded.difficulty, duration_min = excluded.duration_min, note = excluded.note, updated_at = now()
    returning ${sql.unsafe(LOG_COLS)}, (xmax = 0) as inserted`;
  if (!row) throw new Error("saveLog: activity not found (callers check findPublishedActivity first)");
  const { inserted, ...log } = row;
  return { ok: true, created: inserted, log: withIso(log as LogRow) };
}

/** A log of the given guardian (others' logs and missing ids -> null, i.e. 404). */
export async function findOwnLog(logId: string, userId: string): Promise<LogRow | null> {
  if (!isUuid(logId)) return null;
  const sql = await db();
  const [row] = await sql<LogRow[]>`select ${sql.unsafe(LOG_COLS)} from home_activity_logs l where l.id = ${logId} and l.logged_by = ${userId}`;
  return row ? withIso(row) : null;
}

/** FR-5: guardians remove their own logs of the current week (their time zone); older -> 409. */
export async function deleteOwnLog(input: {
  log: LogRow;
  userId: string;
  timeZone: string;
  now?: Date;
}): Promise<{ ok: true } | Failure> {
  if (mondayOf(input.log.done_on) !== weekStartFor(input.now ?? new Date(), input.timeZone)) return fail(409, MSG.notThisWeek);
  const sql = await db();
  return sql.begin(async (tx) => {
    const [ctx] = await tx<{ case_id: string; program_id: string }[]>`
      delete from home_activity_logs l using home_activities a, home_programs p
      where l.id = ${input.log.id} and l.logged_by = ${input.userId} and a.id = l.activity_id and p.id = a.program_id
      returning p.case_id, p.id as program_id`;
    if (!ctx) return fail(404, MSG.logNotFound);
    await auditStrict(
      {
        caseId: ctx.case_id,
        actorUserId: input.userId,
        action: "home_program.log_deleted",
        entity: "home_activity_log",
        entityId: input.log.id,
        details: { program_id: ctx.program_id, activity_id: input.log.activity_id, done_on: input.log.done_on },
      },
      tx,
    );
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Sharing (022 scope `home_program`): published snapshot + adherence, no guardian notes.

export type SharedProgramView = {
  program_id: string;
  org_id: string;
  title: string;
  published_at: string;
  content_md: string;
  time_zone: string;
  today: string;
  activities: (SnapshotActivity & { last_7_days: ActivityAdherence["last_7_days"]; weeks: Adherence[] })[];
};

/** Callers checked the grant (requireSharedAccess / getActiveGrants). `programId` narrows to one program. */
export async function listSharedPrograms(childId: string, sourceOrgIds: string[], programId?: string, opts: { now?: Date } = {}): Promise<SharedProgramView[]> {
  if (sourceOrgIds.length === 0 || !isUuid(childId)) return [];
  const sql = await db();
  const pubs = await currentPublications(sql, { childId, orgIds: sourceOrgIds, programId, guardianVisibleOnly: false });
  if (pubs.length === 0) return [];
  const timeZone = await childTimeZone(childId, sql);
  const today = todayIn(timeZone, opts.now);
  const logs = await logsSince(sql, pubs.flatMap((p) => p.activities.map((a) => a.id)), addDays(mondayOf(today), -21));
  return pubs.map((p) => ({
    program_id: p.program.id,
    org_id: p.program.org_id,
    title: p.title,
    published_at: p.version.published_at,
    content_md: p.version.content_md,
    time_zone: timeZone,
    today,
    activities: p.activities.map((a) => {
      const adh = activityAdherence(logs, a, today);
      return { ...a, last_7_days: adh.last_7_days, weeks: adh.weeks };
    }),
  }));
}
