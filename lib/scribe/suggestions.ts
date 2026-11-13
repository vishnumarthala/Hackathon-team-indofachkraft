// Ticket 038 FR-5: clinician decisions on AI goal-progress suggestions. Server only. The route gates with
// requireIepGoalActor (case access through the goal's plan, 025) before calling these.
//
// Accept: claim the suggestion (`suggested` -> `accepted`, one decision only), then record the progress through 025's
// `recordProgress({ source: "ai_suggested_confirmed", recordingId })` (its own strict audit), then link the progress
// row. A failed recordProgress (plan closed, goal discontinued, value out of range) puts the suggestion back.
// Reject: `suggested` -> `rejected`; no progress row.
import { auditStrict } from "@/lib/audit";
import { isUuid } from "@/lib/cases/validation";
import { recordProgress, type ProgressRow } from "@/lib/iep";
import type { GoalTrend } from "@/lib/iep/progress";
import { valueInRange, MSG as IEP_MSG, type MeasureType } from "@/lib/iep/schema";
import { pg } from "@/lib/pg";
import { listSuggestions, type GoalSuggestionRow } from "./run";

export const SUGGESTION_MESSAGES = {
  notFound: "Suggestion not found",
  decided: "This suggestion was already decided",
} as const;

export type SuggestionFailure = { ok: false; status: 400 | 404 | 409 | 422; error: string; details?: Record<string, unknown> };

/** Goal and case of a suggestion (for the route's gate). */
export async function suggestionTarget(id: string): Promise<{ goal_id: string; case_id: string } | null> {
  if (!isUuid(id)) return null;
  const sql = await pg();
  const [row] = await sql<{ goal_id: string; case_id: string }[]>`
    select goal_id, case_id from goal_progress_suggestions where id = ${id}`;
  return row ?? null;
}

async function loadSuggestion(id: string): Promise<GoalSuggestionRow | null> {
  const sql = await pg();
  const [row] = await sql<{ recording_id: string }[]>`select recording_id from goal_progress_suggestions where id = ${id}`;
  if (!row) return null;
  return (await listSuggestions(sql, row.recording_id)).find((s) => s.id === id) ?? null;
}

export async function rejectGoalSuggestion(input: {
  suggestionId: string;
  actorUserId: string;
}): Promise<{ ok: true; suggestion: GoalSuggestionRow } | SuggestionFailure> {
  const sql = await pg();
  const result = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; case_id: string; goal_id: string; recording_id: string }[]>`
      update goal_progress_suggestions
      set status = 'rejected', decided_by = ${input.actorUserId}, decided_at = now()
      where id = ${input.suggestionId} and status = 'suggested'
      returning id, case_id, goal_id, recording_id`;
    if (!row) return null;
    await auditStrict(
      {
        caseId: row.case_id,
        actorUserId: input.actorUserId,
        action: "scribe.goal_suggestion_rejected",
        entity: "goal_progress_suggestion",
        entityId: row.id,
        details: { goal_id: row.goal_id, recording_id: row.recording_id },
      },
      tx,
    );
    return row;
  });
  if (!result) {
    return (await suggestionTarget(input.suggestionId))
      ? { ok: false, status: 409, error: SUGGESTION_MESSAGES.decided }
      : { ok: false, status: 404, error: SUGGESTION_MESSAGES.notFound };
  }
  return { ok: true, suggestion: (await loadSuggestion(input.suggestionId)) as GoalSuggestionRow };
}

export async function acceptGoalSuggestion(input: {
  suggestionId: string;
  actorUserId: string;
  /** `Edit value`: the clinician's value instead of the suggested one. */
  value?: number;
}): Promise<{ ok: true; suggestion: GoalSuggestionRow; entry: ProgressRow; trend: GoalTrend } | SuggestionFailure> {
  const sql = await pg();
  const [current] = await sql<
    { status: string; suggested_value: number; measure_type: MeasureType; observed_on: string; session_number: number | null; recording_id: string; goal_id: string; case_id: string }[]
  >`
    select s.status, s.case_id, s.suggested_value::float8 as suggested_value, g.measure_type, s.recording_id, s.goal_id,
           ((r.created_at at time zone 'Asia/Kolkata')::date)::text as observed_on, r.session_number
    from goal_progress_suggestions s
    join iep_goals g on g.id = s.goal_id
    join recordings r on r.id = s.recording_id
    where s.id = ${input.suggestionId}`;
  if (!current) return { ok: false, status: 404, error: SUGGESTION_MESSAGES.notFound };
  if (current.status !== "suggested") return { ok: false, status: 409, error: SUGGESTION_MESSAGES.decided };
  const value = input.value ?? current.suggested_value;
  if (!valueInRange(current.measure_type, value)) {
    return { ok: false, status: 400, error: "Invalid request", details: { value: IEP_MSG.valueRange } };
  }

  // One decision only: the claim is a conditional update.
  const claimed = await sql`
    update goal_progress_suggestions
    set status = 'accepted', decided_by = ${input.actorUserId}, decided_at = now(), decided_value = ${value}
    where id = ${input.suggestionId} and status = 'suggested'`;
  if (claimed.count === 0) return { ok: false, status: 409, error: SUGGESTION_MESSAGES.decided };

  const progress = await recordProgress({
    goalId: current.goal_id,
    actorUserId: input.actorUserId,
    observedOn: current.observed_on,
    value,
    note: `AI suggestion confirmed by the clinician (session ${current.session_number ?? "?"}).`,
    source: "ai_suggested_confirmed",
    recordingId: current.recording_id,
  }).catch((err: unknown) => err);

  if (!progress || progress instanceof Error || !(progress as { ok?: boolean }).ok) {
    await sql`
      update goal_progress_suggestions set status = 'suggested', decided_by = null, decided_at = null, decided_value = null
      where id = ${input.suggestionId} and status = 'accepted' and progress_id is null`;
    if (progress instanceof Error || !progress) throw progress ?? new Error("Could not record progress");
    const failure = progress as SuggestionFailure;
    return { ok: false, status: failure.status, error: failure.error, ...(failure.details ? { details: failure.details } : {}) };
  }
  const recorded = progress as { ok: true; entry: ProgressRow; trend: GoalTrend };

  await sql.begin(async (tx) => {
    await tx`update goal_progress_suggestions set progress_id = ${recorded.entry.id} where id = ${input.suggestionId}`;
    await auditStrict(
      {
        caseId: current.case_id,
        actorUserId: input.actorUserId,
        action: "scribe.goal_suggestion_accepted",
        entity: "goal_progress_suggestion",
        entityId: input.suggestionId,
        details: {
          goal_id: current.goal_id,
          recording_id: current.recording_id,
          progress_id: recorded.entry.id,
          suggested_value: current.suggested_value,
          value,
          edited: value !== current.suggested_value,
        },
      },
      tx,
    );
  });
  const suggestion = (await loadSuggestion(input.suggestionId)) as GoalSuggestionRow;
  return { ok: true, suggestion, entry: recorded.entry, trend: recorded.trend };
}
