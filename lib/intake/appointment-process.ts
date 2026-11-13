// Ticket 035 FR-5: processing a finished appointment intake call (webhook, completion endpoint, demo simulator).
// Idempotent by conversation_id: the recording's unique external_id arbitrates concurrent deliveries, and a replay
// for the same appointment answers `{ received: true, duplicate: true }`. Data is only ever attached to the
// appointment of the attempt named in the call's dynamic variables (`intake_attempt_id`), after checking the agent,
// the attempt's state and ai_intake_call consent (again right before Gemini).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { assertConsentOrAbort } from "@/lib/consent";
import { isDemoMode, loadFixture } from "@/lib/demo";
import { generateJson } from "@/lib/gemini";
import { healthSummary } from "@/lib/health/summary";
import { getHealthProfile, getPrescribingHealthFacts } from "@/lib/queries/health";
import { agentIdFor, attemptLinkState, getAttemptById, type IntakeAttempt } from "@/lib/intake/attempts";
import {
  buildGenericIntakePrompt,
  checkAgainstProfile,
  filterGenericRedFlags,
  GenericIntakeBriefSchema,
  loadGenericIntakePrompt,
  renderGenericBriefMarkdown,
  type CollectionResults,
} from "@/lib/intake/generic";
import { INTAKE_COMPLETION_GRACE_MS } from "@/lib/intake/link";
import {
  buildCaseSheetFacts,
  buildIntakeSegments,
  db,
  generateChildDevBrief,
  InvalidPostCallError,
  POST_CALL_FIXTURE,
  PostCallDataSchema,
  type CaseSheetFact,
  type ProcessResult,
  type Sql,
} from "@/lib/intake/process";
import type { Segment } from "@/lib/types";

export const GENERIC_POST_CALL_FIXTURE = "elevenlabs-generic-post-call.json";

export const AppointmentPostCallSchema = PostCallDataSchema.extend({
  conversation_initiation_client_data: z.object({
    dynamic_variables: z.object({ intake_attempt_id: z.uuid() }).catchall(z.unknown()),
  }),
});
export type AppointmentPostCall = z.infer<typeof AppointmentPostCallSchema>;

/** Webhook routing: appointment calls carry `intake_attempt_id` (never an intake_token or a case id). */
export function isAppointmentPostCall(data: unknown): boolean {
  const vars = (data as { conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> } } | null)
    ?.conversation_initiation_client_data?.dynamic_variables;
  return typeof vars?.intake_attempt_id === "string";
}

export function parseAppointmentPostCall(data: unknown): AppointmentPostCall {
  const result = AppointmentPostCallSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new InvalidPostCallError(`Invalid post-call data: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return result.data;
}

/** Demo path: the synthetic fixture of the attempt's agent with this attempt id and conversation id. */
export function demoAppointmentPostCall(attempt: Pick<IntakeAttempt, "id" | "agent_kind">, conversationId: string): AppointmentPostCall {
  const fixture = loadFixture<{ data: Record<string, unknown> }>(attempt.agent_kind === "generic" ? GENERIC_POST_CALL_FIXTURE : POST_CALL_FIXTURE);
  const data = structuredClone(fixture.data) as Record<string, unknown>;
  data.conversation_id = conversationId;
  data.agent_id = agentIdFor(attempt.agent_kind) ?? data.agent_id;
  data.conversation_initiation_client_data = { dynamic_variables: { intake_attempt_id: attempt.id } };
  return parseAppointmentPostCall(data);
}

export const demoConversationId = () => `demo-${randomUUID()}`;

/** FR-5 agent check: the call must come from the agent of the attempt's kind (DEMO_MODE: any, if none configured). */
export function agentMatches(kind: IntakeAttempt["agent_kind"], agentId: string | undefined): boolean {
  const expected = agentIdFor(kind);
  if (!expected) return isDemoMode();
  return agentId === expected;
}

type Saved = { recordingId: string } | { duplicate: true } | { conflict: string };

async function saveAppointmentIntake(
  sql: Sql,
  attempt: IntakeAttempt,
  data: AppointmentPostCall,
  segments: Segment[],
  facts: CaseSheetFact[],
): Promise<Saved> {
  return sql.begin(async (tx) => {
    // Lock the attempt: a parallel delivery of another conversation for the same attempt waits here.
    const [locked] = await tx<{ status: string; conversation_id: string | null }[]>`
      select status, conversation_id from public.intake_attempts where id = ${attempt.id} for update`;
    if (!locked) return { conflict: "unknown attempt" };
    if (locked.status === "completed") {
      return locked.conversation_id === data.conversation_id ? { duplicate: true } : { conflict: "attempt already completed" };
    }
    const inserted = await tx<{ id: string }[]>`
      insert into public.recordings (case_id, kind, status, external_id, duration_sec, segments, appointment_id)
      values (${attempt.case_id}, 'intake_call', 'transcribed', ${data.conversation_id},
              ${data.metadata?.call_duration_secs ?? null}, ${tx.json(segments)}, ${attempt.appointment_id})
      on conflict (external_id) do nothing
      returning id`;
    const recordingId = inserted[0]?.id;
    if (!recordingId) return { duplicate: true };

    await tx`
      update public.intake_attempts
      set status = 'completed', conversation_id = ${data.conversation_id}, completed_at = now(),
          started_at = coalesce(started_at, now()), updated_at = now()
      where id = ${attempt.id}`;

    let statusChanged = false;
    if (attempt.agent_kind === "child_dev") {
      if (facts.length > 0) {
        await tx`
          insert into public.facts (case_id, recording_id, instrument, item_id, value, ai_value, source, evidence,
                                    confidence, rationale, status)
          select ${attempt.case_id}, ${recordingId}, 'CASE_SHEET', x.item_id, x.value, x.value, 'parent_call', null,
                 null, x.rationale, 'suggested'
          from jsonb_to_recordset(${tx.json(facts)}::jsonb) as x(item_id text, value jsonb, rationale text)`;
      }
      const updated = await tx`update public.cases set status = 'intake_done' where id = ${attempt.case_id} and status = 'booked' returning id`;
      statusChanged = updated.length > 0;
    }

    await tx`
      insert into public.audit_events (case_id, actor, action, entity, entity_id, details)
      values (${attempt.case_id}, 'parent', 'intake.received', 'recording', ${recordingId}, ${tx.json({
        conversation_id: data.conversation_id,
        appointment_id: attempt.appointment_id,
        intake_attempt_id: attempt.id,
        agent_kind: attempt.agent_kind,
        facts_count: facts.length,
        segments_count: segments.length,
        status_changed: statusChanged,
      })})`;
    return { recordingId };
  });
}

async function generateGenericBrief(sql: Sql, attempt: IntakeAttempt, recordingId: string, segments: Segment[], results: CollectionResults | null | undefined): Promise<ProcessResult> {
  const childId = attempt.child_id as string;
  const briefStage = { stage: "brief_generation", caseId: attempt.case_id, recordingId, markRecordingFailed: true };
  if (!(await assertConsentOrAbort(childId, "ai_intake_call", briefStage))) {
    return { received: true, case_id: attempt.case_id, recording_id: recordingId, brief: false };
  }
  try {
    // 021: the brief compares reported medicines/allergies with the guardian's health profile.
    const [profile, facts] = await Promise.all([getHealthProfile(childId), getPrescribingHealthFacts(childId)]);
    const generated = await generateJson({
      task: "generic-intake",
      system: loadGenericIntakePrompt(),
      prompt: buildGenericIntakePrompt(segments, results, healthSummary(profile)),
      schema: GenericIntakeBriefSchema,
    });
    const brief = filterGenericRedFlags(generated, segments);
    const stored = {
      ...brief,
      health_check: checkAgainstProfile(brief, {
        recorded: facts.recorded,
        version: facts.version,
        medications: facts.medications,
        allergies: facts.allergies,
      }),
    };
    const reports = await sql<{ id: string }[]>`
      insert into public.reports (case_id, recording_id, kind, content, content_md, status, appointment_id)
      values (${attempt.case_id}, ${recordingId}, 'generic_intake_brief', ${sql.json(stored)},
              ${renderGenericBriefMarkdown(stored, segments)}, 'draft', ${attempt.appointment_id})
      on conflict (recording_id, kind) do nothing
      returning id`;
    await audit({
      caseId: attempt.case_id,
      actor: "ai",
      action: "brief.generated",
      entity: "report",
      entityId: reports[0]?.id,
      details: { recording_id: recordingId, kind: "generic_intake_brief", red_flags: brief.red_flags.length, health_profile_version: facts.version },
    });
    return { received: true, case_id: attempt.case_id, recording_id: recordingId, brief: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`generic brief generation failed: ${message}`);
    await audit({
      caseId: attempt.case_id,
      actor: "system",
      action: "intake.brief_failed",
      entity: "recording",
      entityId: recordingId,
      details: { error: message, kind: "generic_intake_brief" },
    });
    return { received: true, case_id: attempt.case_id, recording_id: recordingId, brief: false };
  }
}

export type AppointmentProcessOptions = {
  /** Completion endpoint / simulator: the attempt behind the link token. A call for another attempt is refused. */
  expectedAttemptId?: string;
};

export class AttemptMismatchError extends Error {
  constructor() {
    super("This call does not belong to this intake link");
    this.name = "AttemptMismatchError";
  }
}

export async function processAppointmentPostCall(input: unknown, opts: AppointmentProcessOptions = {}): Promise<ProcessResult> {
  const data = parseAppointmentPostCall(input);
  const attemptId = data.conversation_initiation_client_data.dynamic_variables.intake_attempt_id;
  if (opts.expectedAttemptId && attemptId !== opts.expectedAttemptId) throw new AttemptMismatchError();
  const sql = await db();

  const attempt = await getAttemptById(attemptId, sql);
  if (!attempt) {
    await audit({ caseId: null, actor: "system", action: "intake.unknown_attempt", details: { conversation_id: data.conversation_id } });
    return { received: true, ignored: "unknown attempt" };
  }
  if (!agentMatches(attempt.agent_kind, data.agent_id)) {
    await audit({
      caseId: attempt.case_id,
      actor: "system",
      action: "intake.agent_mismatch",
      entity: "intake_attempt",
      entityId: attempt.id,
      details: { conversation_id: data.conversation_id },
    });
    if (opts.expectedAttemptId) throw new AttemptMismatchError();
    return { received: true, ignored: "agent mismatch" };
  }

  // Idempotency first: a replay of a stored call is a duplicate; a call stored for another appointment is never
  // attached here.
  const [existing] = await sql<{ appointment_id: string | null }[]>`
    select appointment_id from public.recordings where external_id = ${data.conversation_id}`;
  if (existing) {
    if (existing.appointment_id === attempt.appointment_id) return { received: true, duplicate: true };
    if (opts.expectedAttemptId) throw new AttemptMismatchError();
    return { received: true, ignored: "conversation belongs to another intake" };
  }
  if (attempt.status === "completed") {
    return attempt.conversation_id === data.conversation_id ? { received: true, duplicate: true } : { received: true, ignored: "already completed" };
  }

  // 020: consent re-checked when the queued call is processed; nothing is stored without it.
  if (!attempt.child_id || !(await assertConsentOrAbort(attempt.child_id, "ai_intake_call", { stage: "intake_processing", caseId: attempt.case_id }))) {
    return { received: true, ignored: "consent_withdrawn" };
  }
  const state = attemptLinkState(attempt, Date.now(), INTAKE_COMPLETION_GRACE_MS);
  if (state !== "active") {
    await audit({
      caseId: attempt.case_id,
      actor: "system",
      action: "intake.link_inactive",
      entity: "intake_attempt",
      entityId: attempt.id,
      details: { conversation_id: data.conversation_id, state },
    });
    return { received: true, ignored: "link expired" };
  }

  const segments = buildIntakeSegments(data.transcript);
  const results = data.analysis?.data_collection_results;
  const facts = attempt.agent_kind === "child_dev" ? buildCaseSheetFacts(results) : [];
  const saved = await saveAppointmentIntake(sql, attempt, data, segments, facts);
  if ("duplicate" in saved) return { received: true, duplicate: true };
  if ("conflict" in saved) return { received: true, ignored: saved.conflict };

  if (attempt.agent_kind === "generic") return generateGenericBrief(sql, attempt, saved.recordingId, segments, results);
  return generateChildDevBrief(sql, {
    caseId: attempt.case_id,
    childId: attempt.child_id,
    recordingId: saved.recordingId,
    segments,
    facts,
    appointmentId: attempt.appointment_id,
  });
}
