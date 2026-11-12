// FR-3: one processor for a finished intake call, used by the webhook, the completion endpoint and the
// demo simulator. Recording, facts, case status and the receipt audit are written in one transaction;
// the brief is generated only after that transaction commits.
import { readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { CASE_SHEET_FIELDS, type CaseSheetField } from "@/lib/caseSheet";
import { assertConsentOrAbort } from "@/lib/consent";
import { loadFixture } from "@/lib/demo";
import { env } from "@/lib/env";
import { generateJson } from "@/lib/gemini";
import { formatTime, renderBriefMarkdown } from "@/lib/intake/briefMarkdown";
import { INTAKE_COMPLETION_GRACE_MS, intakeLinkState } from "@/lib/intake/link";
import { BriefSchema, type Brief, type FactValue, type Segment } from "@/lib/types";

export const POST_CALL_FIXTURE = "elevenlabs-post-call.json";

const ResultValueSchema = z.union([z.string(), z.number(), z.boolean()]).nullable().optional();

export const PostCallDataSchema = z.object({
  agent_id: z.string().optional(),
  conversation_id: z.string().min(1).max(200),
  status: z.string().optional(),
  metadata: z.object({ call_duration_secs: z.number().nullable().optional() }).nullable().optional(),
  transcript: z.array(
    z.object({
      role: z.string(),
      message: z.string().nullable().optional(),
      time_in_call_secs: z.number(),
    }),
  ),
  analysis: z
    .object({
      data_collection_results: z
        .record(z.string(), z.object({ value: ResultValueSchema, rationale: z.string().nullable().optional() }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  conversation_initiation_client_data: z.object({
    dynamic_variables: z.object({ intake_token: z.string().min(1) }).catchall(z.unknown()),
  }),
});
export type PostCallData = z.infer<typeof PostCallDataSchema>;
type Transcript = PostCallData["transcript"];
type CollectionResults = NonNullable<NonNullable<PostCallData["analysis"]>["data_collection_results"]>;

export class InvalidPostCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPostCallError";
  }
}

export type ProcessResult =
  | { received: true; ignored: string }
  | { received: true; duplicate: true }
  | { received: true; case_id: string; recording_id: string; brief: boolean };

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit tested in tests/intake.test.ts)

export function parsePostCallData(data: unknown): PostCallData {
  const result = PostCallDataSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new InvalidPostCallError(`Invalid post-call data: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return result.data;
}

// FR-3.3: ids `t<index+1>` over the original array; turns without a message are skipped.
export function buildIntakeSegments(transcript: Transcript): Segment[] {
  const kept = transcript
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => typeof turn.message === "string" && turn.message.trim() !== "");
  return kept.map(({ turn, index }, k) => {
    const next = kept[k + 1];
    return {
      id: `t${index + 1}`,
      speaker: turn.role === "agent" ? "agent" : "parent",
      speaker_label: turn.role,
      start_sec: turn.time_in_call_secs,
      end_sec: next ? next.turn.time_in_call_secs : turn.time_in_call_secs + 5,
      text: turn.message as string,
    };
  });
}

export type CaseSheetFact = { item_id: string; value: FactValue; rationale: string | null };

// FR-3.4: one fact per case-sheet field present in the results; other keys are ignored.
export function buildCaseSheetFacts(
  results: CollectionResults | null | undefined,
  fields: CaseSheetField[] = CASE_SHEET_FIELDS,
): CaseSheetFact[] {
  if (!results) return [];
  return fields
    .filter((f) => Object.prototype.hasOwnProperty.call(results, f.id))
    .map((f) => ({ item_id: f.id, value: results[f.id].value ?? null, rationale: results[f.id].rationale ?? null }));
}

function displayValue(value: FactValue): string {
  if (value === null) return "(not collected)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// FR-3.5: `[t3 | 00:42 | PARENT] text` lines, then the collected fields as `<label>: <value>`.
export function buildBriefPrompt(
  segments: Segment[],
  facts: CaseSheetFact[],
  fields: CaseSheetField[] = CASE_SHEET_FIELDS,
): string {
  const lines = segments.map(
    (s) => `[${s.id} | ${formatTime(s.start_sec)} | ${s.speaker === "agent" ? "AI" : "PARENT"}] ${s.text}`,
  );
  const labelOf = (id: string) => fields.find((x) => x.id === id)?.label ?? id;
  const collected = facts.map((f) => `${labelOf(f.item_id)}: ${displayValue(f.value)}`);
  const ids = facts.map((f) => `${labelOf(f.item_id)} = ${f.item_id}`);
  return [
    "Intake call transcript:",
    ...lines,
    "",
    "Collected fields (parent-reported):",
    ...(collected.length ? collected : ["(none)"]),
    "",
    "Field ids (label = field_id):",
    ...(ids.length ? ids : ["(none)"]),
  ].join("\n");
}

export function filterRedFlags(brief: Brief, segments: Segment[]): Brief {
  const ids = new Set(segments.map((s) => s.id));
  return { ...brief, red_flags: brief.red_flags.filter((f) => ids.has(f.turn_id)) };
}

export function loadBriefPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "brief.md"), "utf8");
}

// FR-6 / FR-11 demo path: the synthetic fixture with this link's token and a conversation id.
export function demoPostCallData(token: string, conversationId: string): PostCallData {
  const fixture = loadFixture<{ data: Record<string, unknown> }>(POST_CALL_FIXTURE);
  const data = structuredClone(fixture.data) as Record<string, unknown> & {
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
  };
  data.conversation_id = conversationId;
  data.conversation_initiation_client_data = {
    ...data.conversation_initiation_client_data,
    dynamic_variables: { ...data.conversation_initiation_client_data?.dynamic_variables, intake_token: token },
  };
  return parsePostCallData(data);
}

// ---------------------------------------------------------------------------------------------
// Database (server only)

type Sql = postgres.Sql;
const globalForSql = globalThis as unknown as { __carethreadSql?: Sql };

async function db(): Promise<Sql> {
  if (typeof window !== "undefined") throw new Error("lib/intake/process.ts is server-only");
  if (!globalForSql.__carethreadSql) {
    const { default: postgresClient } = await import("postgres");
    // Same pooled client as lib/facts.ts; prepare: false works behind the Supabase pooler.
    globalForSql.__carethreadSql = postgresClient(env.DATABASE_URL, { max: 5, prepare: false, onnotice: () => {} });
  }
  return globalForSql.__carethreadSql;
}

type CaseLookup = {
  id: string;
  status: string;
  child_id: string;
  intake_token: string;
  intake_token_expires_at: Date | string | null;
  intake_token_revoked_at: Date | string | null;
};

const isoOrNull = (value: Date | string | null) => (value instanceof Date ? value.toISOString() : value);

async function saveIntake(
  sql: Sql,
  caseRow: CaseLookup,
  data: PostCallData,
  segments: Segment[],
  facts: CaseSheetFact[],
): Promise<string | null> {
  return sql.begin(async (tx) => {
    // The unique external_id arbitrates concurrent deliveries: a second transaction waits for the first,
    // then inserts nothing and reports a duplicate. If the first rolls back, the second wins instead.
    const inserted = await tx<{ id: string }[]>`
      insert into recordings (case_id, kind, status, external_id, duration_sec, segments)
      values (${caseRow.id}, 'intake_call', 'transcribed', ${data.conversation_id},
              ${data.metadata?.call_duration_secs ?? null}, ${tx.json(segments)})
      on conflict (external_id) do nothing
      returning id`;
    const recordingId = inserted[0]?.id;
    if (!recordingId) return null;

    if (facts.length > 0) {
      await tx`
        insert into facts (case_id, recording_id, instrument, item_id, value, ai_value, source, evidence,
                           confidence, rationale, status)
        select ${caseRow.id}, ${recordingId}, 'CASE_SHEET', x.item_id, x.value, x.value, 'parent_call', null,
               null, x.rationale, 'suggested'
        from jsonb_to_recordset(${tx.json(facts)}::jsonb) as x(item_id text, value jsonb, rationale text)`;
    }

    const updated = await tx<{ id: string }[]>`
      update cases set status = 'intake_done' where id = ${caseRow.id} and status = 'booked' returning id`;

    const details = {
      conversation_id: data.conversation_id,
      facts_count: facts.length,
      segments_count: segments.length,
      status_changed: updated.length > 0,
    };
    await tx`
      insert into audit_events (case_id, actor, action, entity, entity_id, details)
      values (${caseRow.id}, 'parent', 'intake.received', 'recording', ${recordingId}, ${tx.json(details)})`;
    return recordingId;
  });
}

export async function processPostCall(input: unknown): Promise<ProcessResult> {
  const data = parsePostCallData(input);
  const token = data.conversation_initiation_client_data.dynamic_variables.intake_token;
  const sql = await db();

  const cases = await sql<CaseLookup[]>`
    select id, status, child_id, intake_token, intake_token_expires_at, intake_token_revoked_at
    from cases where intake_token = ${token}`;
  const caseRow = cases[0];
  if (!caseRow) {
    await audit({
      caseId: null,
      actor: "system",
      action: "intake.unknown_token",
      details: { conversation_id: data.conversation_id },
    });
    return { received: true, ignored: "unknown token" };
  }

  const existing = await sql`select 1 from recordings where external_id = ${data.conversation_id}`;
  if (existing.length > 0) return { received: true, duplicate: true };

  // 020 FR-7/FR-8: re-check consent when the queued call is processed; nothing is stored without it.
  const consentStage = { stage: "intake_processing", caseId: caseRow.id };
  if (!(await assertConsentOrAbort(caseRow.child_id, "ai_intake_call", consentStage))) {
    return { received: true, ignored: "consent_withdrawn" };
  }
  const linkState = intakeLinkState(
    {
      intake_token: caseRow.intake_token,
      intake_token_expires_at: isoOrNull(caseRow.intake_token_expires_at),
      intake_token_revoked_at: isoOrNull(caseRow.intake_token_revoked_at),
    },
    Date.now(),
    INTAKE_COMPLETION_GRACE_MS,
  );
  if (linkState !== "active") {
    await audit({
      caseId: caseRow.id,
      actor: "system",
      action: "intake.link_inactive",
      details: { conversation_id: data.conversation_id, state: linkState },
    });
    return { received: true, ignored: "link expired" };
  }

  const segments = buildIntakeSegments(data.transcript);
  const facts = buildCaseSheetFacts(data.analysis?.data_collection_results);
  const recordingId = await saveIntake(sql, caseRow, data, segments, facts);
  if (!recordingId) return { received: true, duplicate: true };

  // Re-check right before the transcript goes to Gemini for the brief.
  const briefStage = { stage: "brief_generation", caseId: caseRow.id, recordingId, markRecordingFailed: true };
  if (!(await assertConsentOrAbort(caseRow.child_id, "ai_intake_call", briefStage))) {
    return { received: true, case_id: caseRow.id, recording_id: recordingId, brief: false };
  }

  try {
    const generated = await generateJson({
      task: "brief",
      system: loadBriefPrompt(),
      prompt: buildBriefPrompt(segments, facts),
      schema: BriefSchema,
    });
    const brief = filterRedFlags(generated, segments);
    const reports = await sql<{ id: string }[]>`
      insert into reports (case_id, recording_id, kind, content, content_md, status)
      values (${caseRow.id}, ${recordingId}, 'pre_session_brief', ${sql.json(brief)},
              ${renderBriefMarkdown(brief, segments)}, 'draft')
      on conflict (recording_id, kind) do nothing
      returning id`;
    await audit({
      caseId: caseRow.id,
      actor: "ai",
      action: "brief.generated",
      entity: "report",
      entityId: reports[0]?.id,
      details: { recording_id: recordingId, red_flags: brief.red_flags.length },
    });
    return { received: true, case_id: caseRow.id, recording_id: recordingId, brief: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`brief generation failed: ${message}`);
    await audit({
      caseId: caseRow.id,
      actor: "system",
      action: "intake.brief_failed",
      entity: "recording",
      entityId: recordingId,
      details: { error: message },
    });
    return { received: true, case_id: caseRow.id, recording_id: recordingId, brief: false };
  }
}
