// Ticket 024 FR-7..FR-10: assessment portal data access. Server only.
//
// Every write is one transaction that locks the assessment (or case) row and writes its audit row in the same
// transaction (strict: no audit, no change). Callers have already passed the access gate:
// providers -> requireCaseActor / requireAssessmentActor (case access, 022 rule);
// guardians -> requireGuardian, and every function here re-checks `assigned_to = user` AND an active guardian
// link to a live child (fail closed: a revoked link ends access on the next request; 404 otherwise).
// Notifications (032 outbox) are enqueued in the same transactions: `assessment.assigned` (the guardian),
// `assessment.red_flag` and `assessment.submitted` (the case's providers). Payloads carry ids only; callers pass
// the returned `event_ids` to `drainSoon()`.
import type postgres from "postgres";
import {
  MSG,
  OPEN_STATUSES,
  type AssessmentStatus,
  type AssignInput,
  type ResponsesInput,
  type ReviewInput,
} from "@/lib/assessments/schemas";
import { assessmentSummaryMarkdown } from "@/lib/assessments/summary";
import { scoreCheckin, type CheckinScore } from "@/lib/clinical/checkin";
import { getInstrument, type InstrumentItem } from "@/lib/clinical/instruments";
import { getLatestPublished, publishVersion, type PublishedVersion } from "@/lib/clinical/publish";
import { isUuid } from "@/lib/cases/validation";
import { enqueue } from "@/lib/notify/outbox";
import { pg as db } from "@/lib/pg";

type Tx = postgres.Sql | postgres.TransactionSql;

export type AssessmentRow = {
  id: string;
  case_id: string;
  child_id: string;
  org_id: string;
  template_id: string;
  assigned_to: string;
  assigned_by: string | null;
  status: AssessmentStatus;
  due_on: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  score: CheckinScore | null;
  reviewer_note: string | null;
  version: number;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  // joined
  title: string;
  instrument_key: string;
  child_name: string;
};

export type AssessmentListItem = AssessmentRow & {
  guardian_name: string | null;
  guardian_relationship: string | null;
  red_flag_count: number;
  shared_with_parent: boolean;
};

export type Failure = { ok: false; status: 400 | 404 | 409 | 422; error: string; details?: Record<string, unknown> };

const COLS = `a.id, a.case_id, a.child_id, a.org_id, a.template_id, a.assigned_to, a.assigned_by, a.status,
  a.due_on::text as due_on, a.submitted_at, a.reviewed_by, a.reviewed_at, a.score, a.reviewer_note, a.version,
  a.cancelled_at, a.created_at, a.updated_at, t.title, t.instrument_key, ch.display_name as child_name`;

const TS_FIELDS = ["submitted_at", "reviewed_at", "cancelled_at", "created_at", "updated_at"] as const;

function toRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of TS_FIELDS) if (out[key] instanceof Date) out[key] = (out[key] as Date).toISOString();
  return out as T;
}

const fail = (status: Failure["status"], error: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  status,
  error,
  ...(details ? { details } : {}),
});

async function auditTx(
  tx: Tx,
  e: { caseId: string; actor: "therapist" | "parent"; actorUserId: string; action: string; entityId: string; details?: Record<string, unknown> },
) {
  await tx`
    insert into audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
    values (${e.caseId}, ${e.actor}, ${e.actorUserId}, ${e.action}, 'assessment', ${e.entityId}, ${tx.json((e.details ?? {}) as postgres.JSONValue)})`;
}

// ---------------------------------------------------------------------------------------------------------
// Answers

function validValue(item: InstrumentItem, value: unknown): boolean {
  switch (item.scale.type) {
    case "choice":
      return item.scale.options.some((o) => o.value === value);
    case "rating":
      return item.scale.options.some((o) => o.value === value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "text":
      return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
  }
}

function itemsOf(instrumentKey: string): InstrumentItem[] {
  return getInstrument(instrumentKey)?.items ?? [];
}

/** Item ids still unanswered (or invalid), in form order. */
export function missingItems(instrumentKey: string, answers: Record<string, unknown>): string[] {
  return itemsOf(instrumentKey)
    .filter((item) => !validValue(item, answers[item.id]))
    .map((item) => item.id);
}

/** Red-flag codes raised by the answers (items with `red_flag` answered `yes`). */
export function redFlagCodes(instrumentKey: string, answers: Record<string, unknown>): string[] {
  return itemsOf(instrumentKey).flatMap((item) => (item.red_flag && answers[item.id] === "yes" ? item.red_flag : []));
}

export function scoreAnswers(instrumentKey: string, answers: Record<string, unknown>): CheckinScore | null {
  return instrumentKey === "ISAA_PARENT_CHECKIN" ? scoreCheckin(answers) : null;
}

async function loadAnswers(tx: Tx, assessmentId: string): Promise<Record<string, unknown>> {
  const rows = await tx<{ item_id: string; value: unknown }[]>`
    select item_id, value from assessment_responses where assessment_id = ${assessmentId}`;
  return Object.fromEntries(rows.map((r) => [r.item_id, r.value]));
}

// ---------------------------------------------------------------------------------------------------------
// Provider side (caller passed requireCaseActor / requireAssessmentActor)

export type TemplateOption = { id: string; title: string; instrument_key: string };
export type GuardianOption = { user_id: string; display_name: string | null; relationship: string };

export async function listTemplatesForCase(caseId: string): Promise<TemplateOption[]> {
  const sql = await db();
  return sql<TemplateOption[]>`
    select t.id, t.title, t.instrument_key
    from assessment_templates t
    join cases c on c.id = ${caseId}
    where t.active and t.audience = 'guardian' and (t.org_id is null or t.org_id = c.org_id)
    order by t.org_id nulls first, t.title`;
}

/** Guardians with an active link to the case's (live) child: the only people a questionnaire can go to. */
export async function listCaseGuardians(caseId: string): Promise<GuardianOption[]> {
  const sql = await db();
  return sql<GuardianOption[]>`
    select gl.user_id, up.display_name, gl.relationship
    from cases c
    join children ch on ch.id = c.child_id and ch.deleted_at is null
    join guardian_links gl on gl.child_id = c.child_id and gl.status = 'active'
    join user_profiles up on up.id = gl.user_id and up.role = 'guardian'
    where c.id = ${caseId}
    order by gl.created_at`;
}

export async function listCaseAssessments(caseId: string): Promise<AssessmentListItem[]> {
  const sql = await db();
  const rows = await sql<Omit<AssessmentListItem, "red_flag_count">[]>`
    select ${sql.unsafe(COLS)}, up.display_name as guardian_name, gl.relationship as guardian_relationship,
      coalesce((select pv.visible_to_guardian from published_versions pv
                where pv.entity_type = 'assessment' and pv.entity_id = a.id order by pv.version desc limit 1), false)
        as shared_with_parent
    from assessments a
    join assessment_templates t on t.id = a.template_id
    join children ch on ch.id = a.child_id
    left join user_profiles up on up.id = a.assigned_to
    left join guardian_links gl on gl.child_id = a.child_id and gl.user_id = a.assigned_to
    where a.case_id = ${caseId}
    order by a.created_at desc`;
  const ids = rows.map((r) => r.id);
  const responses = ids.length
    ? await sql<{ assessment_id: string; item_id: string; value: unknown }[]>`
        select assessment_id, item_id, value from assessment_responses where assessment_id in ${sql(ids)}`
    : [];
  return rows.map((row) => {
    const answers = Object.fromEntries(responses.filter((r) => r.assessment_id === row.id).map((r) => [r.item_id, r.value]));
    return { ...toRow(row), red_flag_count: redFlagCodes(row.instrument_key, answers).length };
  });
}

export type ProviderAssessmentDetail = {
  assessment: AssessmentListItem;
  answers: Record<string, unknown>;
  /** Stored score once submitted, else the live (partial) score of the saved answers. */
  score: CheckinScore | null;
  red_flags: string[];
  published: PublishedVersion | null;
};

export async function getAssessmentForProvider(assessmentId: string, caseId: string): Promise<ProviderAssessmentDetail | null> {
  if (!isUuid(assessmentId)) return null;
  const list = await listCaseAssessments(caseId);
  const assessment = list.find((a) => a.id === assessmentId);
  if (!assessment) return null;
  const sql = await db();
  const answers = await loadAnswers(sql, assessmentId);
  return {
    assessment,
    answers,
    score: assessment.score ?? scoreAnswers(assessment.instrument_key, answers),
    red_flags: redFlagCodes(assessment.instrument_key, answers),
    published: await getLatestPublished(sql, "assessment", assessmentId),
  };
}

export async function createAssessment(input: {
  caseId: string;
  actorUserId: string;
  body: AssignInput;
}): Promise<{ ok: true; assessment: AssessmentRow; event_ids: string[] } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const [kase] = await tx<{ id: string; org_id: string; child_id: string }[]>`
      select id, org_id, child_id from cases where id = ${input.caseId} for update`;
    if (!kase) return fail(404, "Case not found");
    const [template] = await tx<{ id: string; instrument_key: string }[]>`
      select id, instrument_key from assessment_templates
      where id = ${input.body.template_id} and active and audience = 'guardian'
        and (org_id is null or org_id = ${kase.org_id})`;
    if (!template) return fail(422, MSG.chooseTemplate);
    const [link] = await tx<{ id: string }[]>`
      select gl.id from guardian_links gl
      join children ch on ch.id = gl.child_id and ch.deleted_at is null
      join user_profiles up on up.id = gl.user_id and up.role = 'guardian'
      where gl.child_id = ${kase.child_id} and gl.user_id = ${input.body.assigned_to} and gl.status = 'active'`;
    if (!link) return fail(422, MSG.notLinked);
    const [open] = await tx<{ id: string }[]>`
      select id from assessments
      where case_id = ${kase.id} and template_id = ${template.id} and assigned_to = ${input.body.assigned_to}
        and status in ('assigned', 'in_progress')
      limit 1`;
    if (open) return fail(409, MSG.alreadyOpen, { assessment_id: open.id });

    const [created] = await tx<{ id: string }[]>`
      insert into assessments (case_id, child_id, org_id, template_id, assigned_to, assigned_by, due_on)
      values (${kase.id}, ${kase.child_id}, ${kase.org_id}, ${template.id}, ${input.body.assigned_to},
              ${input.actorUserId}, ${input.body.due_on})
      returning id`;
    await auditTx(tx, {
      caseId: kase.id,
      actor: "therapist",
      actorUserId: input.actorUserId,
      action: "assessment.assigned",
      entityId: created.id,
      details: { template_id: template.id, instrument_key: template.instrument_key, due_on: input.body.due_on },
    });
    const eventId = await enqueue(tx, {
      topic: "assessment.assigned",
      aggregateType: "assessment",
      aggregateId: created.id,
      payload: { assessment_id: created.id, child_id: kase.child_id, case_id: kase.id },
      dedupKey: `assessment:${created.id}:assigned`,
    });
    const [row] = await tx<AssessmentRow[]>`
      select ${tx.unsafe(COLS)} from assessments a
      join assessment_templates t on t.id = a.template_id join children ch on ch.id = a.child_id
      where a.id = ${created.id}`;
    return { ok: true as const, assessment: toRow(row), event_ids: [eventId] };
  });
}

type Locked = { id: string; case_id: string; child_id: string; status: AssessmentStatus; version: number; instrument_key: string; title: string };

async function lockForProvider(tx: Tx, assessmentId: string): Promise<Locked | null> {
  const [row] = await tx<Locked[]>`
    select a.id, a.case_id, a.child_id, a.status, a.version, t.instrument_key, t.title
    from assessments a join assessment_templates t on t.id = a.template_id
    where a.id = ${assessmentId}
    for update of a`;
  return row ?? null;
}

export async function reviewAssessment(input: {
  assessmentId: string;
  actorUserId: string;
  body: ReviewInput;
}): Promise<{ ok: true; assessment: AssessmentRow; published: PublishedVersion } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockForProvider(tx, input.assessmentId);
    if (!locked) return fail(404, MSG.notFound);
    if (locked.status === "reviewed") return fail(409, MSG.alreadyReviewed);
    if (locked.status !== "submitted") return fail(409, locked.status === "cancelled" ? MSG.cancelled : MSG.notSubmitted);

    const [updated] = await tx<{ submitted_at: Date; reviewed_at: Date; score: CheckinScore | null }[]>`
      update assessments
      set status = 'reviewed', reviewed_by = ${input.actorUserId}, reviewed_at = now(),
          reviewer_note = ${input.body.note || null}, version = version + 1, updated_at = now()
      where id = ${locked.id}
      returning submitted_at, reviewed_at, score`;
    const answers = await loadAnswers(tx, locked.id);
    const published = await publishVersion(tx, {
      entityType: "assessment",
      entityId: locked.id,
      caseId: locked.case_id,
      contentMd: assessmentSummaryMarkdown({
        title: locked.title,
        instrumentKey: locked.instrument_key,
        submittedAt: updated.submitted_at,
        reviewedAt: updated.reviewed_at,
        score: updated.score,
        answers,
      }),
      visibleToGuardian: input.body.share_with_parent,
      publishedBy: input.actorUserId,
    });
    await auditTx(tx, {
      caseId: locked.case_id,
      actor: "therapist",
      actorUserId: input.actorUserId,
      action: "assessment.reviewed",
      entityId: locked.id,
      details: {
        shared_with_parent: input.body.share_with_parent,
        published_version_id: published.id,
        version: published.version,
        band: updated.score?.band ?? null,
      },
    });
    const [row] = await tx<AssessmentRow[]>`
      select ${tx.unsafe(COLS)} from assessments a
      join assessment_templates t on t.id = a.template_id join children ch on ch.id = a.child_id
      where a.id = ${locked.id}`;
    return { ok: true as const, assessment: toRow(row), published };
  });
}

export async function cancelAssessment(input: {
  assessmentId: string;
  actorUserId: string;
}): Promise<{ ok: true; status: "cancelled" } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockForProvider(tx, input.assessmentId);
    if (!locked) return fail(404, MSG.notFound);
    if (!OPEN_STATUSES.includes(locked.status)) return fail(409, MSG.notOpen);
    await tx`
      update assessments
      set status = 'cancelled', cancelled_at = now(), cancelled_by = ${input.actorUserId}, version = version + 1,
          updated_at = now()
      where id = ${locked.id}`;
    await auditTx(tx, {
      caseId: locked.case_id,
      actor: "therapist",
      actorUserId: input.actorUserId,
      action: "assessment.cancelled",
      entityId: locked.id,
      details: { previous_status: locked.status },
    });
    return { ok: true as const, status: "cancelled" as const };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Guardian side (caller passed requireGuardian; access re-checked here)

const GUARDIAN_JOIN = `
  join assessment_templates t on t.id = a.template_id
  join children ch on ch.id = a.child_id and ch.deleted_at is null
  join guardian_links gl on gl.child_id = a.child_id and gl.user_id = a.assigned_to and gl.status = 'active'`;

export type GuardianAssessmentItem = AssessmentRow & { has_summary: boolean };

export async function listGuardianAssessments(userId: string): Promise<GuardianAssessmentItem[]> {
  const sql = await db();
  const rows = await sql<GuardianAssessmentItem[]>`
    select ${sql.unsafe(COLS)},
      coalesce((select pv.visible_to_guardian from published_versions pv
                where pv.entity_type = 'assessment' and pv.entity_id = a.id order by pv.version desc limit 1), false)
        as has_summary
    from assessments a ${sql.unsafe(GUARDIAN_JOIN)}
    where a.assigned_to = ${userId} and a.status <> 'cancelled'
    order by (a.status in ('assigned', 'in_progress')) desc, a.due_on nulls last, a.created_at desc`;
  return rows.map(toRow);
}

export type GuardianAssessmentDetail = {
  assessment: AssessmentRow;
  answers: Record<string, unknown>;
  /** The current published summary, only when it is visible to the guardian. */
  summary: PublishedVersion | null;
};

export async function getGuardianAssessment(assessmentId: string, userId: string): Promise<GuardianAssessmentDetail | null> {
  if (!isUuid(assessmentId)) return null;
  const sql = await db();
  const [row] = await sql<AssessmentRow[]>`
    select ${sql.unsafe(COLS)} from assessments a ${sql.unsafe(GUARDIAN_JOIN)}
    where a.id = ${assessmentId} and a.assigned_to = ${userId} and a.status <> 'cancelled'`;
  if (!row) return null;
  const latest = await getLatestPublished(sql, "assessment", assessmentId);
  return {
    assessment: toRow(row),
    answers: await loadAnswers(sql, assessmentId),
    summary: latest?.visible_to_guardian ? latest : null,
  };
}

async function lockForGuardian(tx: Tx, assessmentId: string, userId: string): Promise<Locked | null> {
  if (!isUuid(assessmentId)) return null;
  const [row] = await tx<Locked[]>`
    select a.id, a.case_id, a.child_id, a.status, a.version, t.instrument_key, t.title
    from assessments a ${tx.unsafe(GUARDIAN_JOIN)}
    where a.id = ${assessmentId} and a.assigned_to = ${userId}
    for update of a`;
  return row ?? null;
}

function closedFailure(status: AssessmentStatus): Failure | null {
  if (status === "submitted" || status === "reviewed") return fail(409, MSG.alreadySubmitted);
  if (status === "cancelled") return fail(409, MSG.cancelled);
  return null;
}

export type SaveResult = {
  ok: true;
  version: number;
  status: AssessmentStatus;
  red_flags: string[];
  new_red_flags: string[];
  case_id: string;
  event_ids: string[];
};

export async function saveResponses(input: {
  assessmentId: string;
  userId: string;
  body: ResponsesInput;
}): Promise<SaveResult | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockForGuardian(tx, input.assessmentId, input.userId);
    if (!locked) return fail(404, MSG.notFound);
    const closed = closedFailure(locked.status);
    if (closed) return closed;
    if (locked.version !== input.body.version) return fail(409, MSG.stale, { version: locked.version });

    const items = new Map(itemsOf(locked.instrument_key).map((i) => [i.id, i]));
    const answers = new Map<string, unknown>();
    for (const a of input.body.answers) {
      const item = items.get(a.item_id);
      if (!item || !validValue(item, a.value)) return fail(400, MSG.invalidAnswer, { item_id: a.item_id });
      answers.set(a.item_id, a.value);
    }

    const before = await loadAnswers(tx, locked.id);
    for (const [itemId, value] of answers) {
      await tx`
        insert into assessment_responses (assessment_id, item_id, value, answered_by, answered_at)
        values (${locked.id}, ${itemId}, ${tx.json(value as postgres.JSONValue)}, ${input.userId}, now())
        on conflict (assessment_id, item_id) do update
          set value = excluded.value, answered_by = excluded.answered_by, answered_at = excluded.answered_at`;
    }
    const [next] = await tx<{ version: number; status: AssessmentStatus }[]>`
      update assessments set status = 'in_progress', version = version + 1, updated_at = now()
      where id = ${locked.id}
      returning version, status`;

    const after = { ...before, ...Object.fromEntries(answers) };
    const redFlags = redFlagCodes(locked.instrument_key, after);
    const previous = new Set(redFlagCodes(locked.instrument_key, before));
    const newRedFlags = redFlags.filter((code) => !previous.has(code));

    await auditTx(tx, {
      caseId: locked.case_id,
      actor: "parent",
      actorUserId: input.userId,
      action: "assessment.responses_saved",
      entityId: locked.id,
      details: { answers: answers.size, version: next.version },
    });
    const eventIds: string[] = [];
    if (newRedFlags.length > 0) {
      await auditTx(tx, {
        caseId: locked.case_id,
        actor: "parent",
        actorUserId: input.userId,
        action: "assessment.red_flag",
        entityId: locked.id,
        details: { codes: newRedFlags },
      });
      // Codes stay out of the payload (no clinical content in notifications); the key dedups re-answers.
      eventIds.push(
        await enqueue(tx, {
          topic: "assessment.red_flag",
          aggregateType: "assessment",
          aggregateId: locked.id,
          payload: { assessment_id: locked.id, child_id: locked.child_id, case_id: locked.case_id },
          dedupKey: `assessment:${locked.id}:red_flag:${[...newRedFlags].sort().join("+")}`,
        }),
      );
    }
    return {
      ok: true as const,
      version: next.version,
      status: next.status,
      red_flags: redFlags,
      new_red_flags: newRedFlags,
      case_id: locked.case_id,
      event_ids: eventIds,
    };
  });
}

export type SubmitResult = {
  ok: true;
  status: "submitted";
  score: CheckinScore | null;
  case_id: string;
  red_flags: string[];
  event_ids: string[];
};

export async function submitAssessment(input: { assessmentId: string; userId: string }): Promise<SubmitResult | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const locked = await lockForGuardian(tx, input.assessmentId, input.userId);
    if (!locked) return fail(404, MSG.notFound);
    const closed = closedFailure(locked.status);
    if (closed) return closed;

    const answers = await loadAnswers(tx, locked.id);
    const missing = missingItems(locked.instrument_key, answers);
    if (missing.length > 0) return fail(422, MSG.answerAll, { missing });

    const score = scoreAnswers(locked.instrument_key, answers);
    await tx`
      update assessments
      set status = 'submitted', submitted_at = now(), score = ${score ? tx.json(score as unknown as postgres.JSONValue) : null},
          version = version + 1, updated_at = now()
      where id = ${locked.id}`;
    const redFlags = redFlagCodes(locked.instrument_key, answers);
    await auditTx(tx, {
      caseId: locked.case_id,
      actor: "parent",
      actorUserId: input.userId,
      action: "assessment.submitted",
      entityId: locked.id,
      details: { band: score?.band ?? null, red_flags: redFlags },
    });
    const eventId = await enqueue(tx, {
      topic: "assessment.submitted",
      aggregateType: "assessment",
      aggregateId: locked.id,
      payload: { assessment_id: locked.id, child_id: locked.child_id, case_id: locked.case_id },
      dedupKey: `assessment:${locked.id}:submitted`,
    });
    return {
      ok: true as const,
      status: "submitted" as const,
      score,
      case_id: locked.case_id,
      red_flags: redFlags,
      event_ids: [eventId],
    };
  });
}
