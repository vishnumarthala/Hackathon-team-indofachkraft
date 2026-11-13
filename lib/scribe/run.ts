// Ticket 038 FR-4: run the AI scribe on a transcribed in-clinic recording. Server only.
//
// recording (transcribed/extracted, template != child_dev_isaa)
//   -> claim (status `extracting`, one runner at a time)
//   -> appointment re-check (video -> 422 in-clinic only)
//   -> context: transcript with speaker roles (024), the case's active IEP goals (025), health summary (021)
//   -> consent re-check (020 assertConsentOrAbort, ai_extraction) -> Gemini session note + goal suggestions (Zod)
//   -> prescriber only (028 provider_can_prescribe of the uploader), medical template:
//      consent re-check -> Gemini Rx draft (Zod)
//   -> one transaction: session_note / rx_draft reports replaced only while `draft` (a final note is never touched),
//      `suggested` goal suggestions replaced (accepted/rejected ones kept), recording `extracted`, audit.
// Idempotent per recording: a re-run replaces drafts only. Nothing here is final or visible to guardians.
import { readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { auditStrict } from "@/lib/audit";
import { assertConsentOrAbort, CONSENT_REQUIRED_ERROR, CONSENT_WITHDRAWN } from "@/lib/consent";
import { generateJson } from "@/lib/gemini";
import { healthSummary } from "@/lib/health/summary";
import type { MeasureType } from "@/lib/iep/schema";
import { errorMessage } from "@/lib/log";
import { pg, type Queryable, type Sql } from "@/lib/pg";
import { getHealthProfileForCase } from "@/lib/queries/health";
import { SegmentSchema, type Segment } from "@/lib/types";
import { isUuid } from "@/lib/cases/validation";
import { checkScribeAppointment } from "./appointments";
import {
  buildNotePrompt,
  buildRxPrompt,
  goalsForPrompt,
  noteMarkdown,
  planStatements,
  processGoalSuggestions,
  processNote,
  processRx,
  rxMarkdown,
  type PromptGoal,
} from "./process";
import { noteOutputSchema, RxOutputSchema, type NoteOutput, type RxOutput } from "./schema";
import { isNoteTemplate, NOTE_TEMPLATES, RX_GEMINI_TASK, RX_PROMPT, type NoteTemplate } from "./templates";

type Json = postgres.JSONValue;
const asJson = (v: unknown) => v as Json;

export type GoalSuggestionRow = {
  id: string;
  recording_id: string;
  case_id: string;
  goal_id: string;
  goal_statement: string;
  measure_type: MeasureType;
  suggested_value: number;
  evidence: { segment_id: string; quote: string; start_sec: number; end_sec: number; verified: boolean }[];
  rationale: string;
  status: "suggested" | "accepted" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  decided_value: number | null;
  progress_id: string | null;
};

export type ScribeResponse = {
  recording_id: string;
  session_note_id: string;
  session_note_status: "draft" | "final";
  goal_suggestions: GoalSuggestionRow[];
  rx_draft_id?: string;
};

export type ScribeOutcome =
  | { ok: true; body: ScribeResponse }
  | { ok: false; status: number; error: string; details?: unknown };

export type GenerateFn = (input: { task: string; system: string; prompt: string; schema: unknown }) => Promise<unknown>;

export type ScribeDeps = { sql?: Sql; generate?: GenerateFn };

export const SCRIBE_MESSAGES = {
  notFound: "Session not found",
  isaa: "Child Development sessions use the ISAA form, not the AI scribe",
  running: "The AI scribe is already running for this session",
  transcribeFirst: "Transcribe the session first",
  failed: "The AI scribe could not draft this session",
} as const;

export function loadPrompt(file: string): string {
  return readFileSync(path.join(process.cwd(), "prompts", file), "utf8");
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));

export const SUGGESTION_COLS = `s.id, s.recording_id, s.case_id, s.goal_id, g.statement as goal_statement, g.measure_type,
  s.suggested_value::float8 as suggested_value, s.evidence, s.rationale, s.status, s.decided_by, s.decided_at,
  s.decided_value::float8 as decided_value, s.progress_id`;

export async function listSuggestions(sql: Queryable, recordingId: string): Promise<GoalSuggestionRow[]> {
  const rows = await sql<GoalSuggestionRow[]>`
    select ${sql.unsafe(SUGGESTION_COLS)}
    from goal_progress_suggestions s join iep_goals g on g.id = s.goal_id
    where s.recording_id = ${recordingId}
    order by g.sort, g.created_at`;
  return rows.map((r) => ({ ...r, decided_at: iso(r.decided_at) }));
}

/** Active goals of the case's active plan(s), with the latest recorded value. */
export async function activeGoals(sql: Queryable, caseId: string) {
  return sql<
    { id: string; statement: string; measure_type: MeasureType; baseline_value: number; target_value: number; latest_value: number | null }[]
  >`
    select g.id, g.statement, g.measure_type, g.baseline_value::float8 as baseline_value,
           g.target_value::float8 as target_value,
           (select gp.value::float8 from goal_progress gp where gp.goal_id = g.id
            order by gp.observed_on desc, gp.created_at desc limit 1) as latest_value
    from iep_goals g join iep_plans p on p.id = g.plan_id
    where p.case_id = ${caseId} and p.status = 'active' and g.status = 'active'
    order by p.created_at, g.sort, g.created_at`;
}

/** 028: the uploader's own provider profile can prescribe (verified prescriber type + medical council). */
export async function uploaderCanPrescribe(sql: Queryable, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const rows = await sql<{ can: boolean | null }[]>`
    select public.provider_can_prescribe(p.id) as can from provider_profiles p where p.user_id = ${userId}`;
  return rows[0]?.can === true;
}

async function safeHealthSummary(caseId: string): Promise<string | null> {
  try {
    const profile = await getHealthProfileForCase(caseId);
    return profile ? healthSummary(profile) : null;
  } catch (err) {
    console.error(`scribe: health summary unavailable: ${errorMessage(err)}`);
    return null;
  }
}

type Claimed = {
  previous_status: "transcribed" | "extracted";
  segments: unknown;
  case_id: string;
  child_id: string | null;
  org_id: string;
  template: string;
  uploaded_by: string | null;
  appointment_id: string | null;
};

async function restore(sql: Queryable, recordingId: string, status: string, error: string | null) {
  await sql`update recordings set status = ${status}, error = ${error} where id = ${recordingId} and status = 'extracting'`;
}

export async function runScribe(recordingId: string, deps: ScribeDeps = {}): Promise<ScribeOutcome> {
  if (!isUuid(recordingId)) return { ok: false, status: 404, error: SCRIBE_MESSAGES.notFound };
  const sql = deps.sql ?? (await pg());
  const generate: GenerateFn = deps.generate ?? ((input) => generateJson(input as Parameters<typeof generateJson>[0]));

  const claimed = await sql<Claimed[]>`
    with prev as (
      select id, status from recordings
      where id = ${recordingId} and kind in ('session', 'consult') and template <> 'child_dev_isaa'
      for update
    )
    update recordings r set status = 'extracting', error = null
    from prev
    where r.id = prev.id and prev.status in ('transcribed', 'extracted')
    returning prev.status as previous_status, r.segments, r.case_id, r.template, r.uploaded_by, r.appointment_id,
      (select c.child_id from cases c where c.id = r.case_id) as child_id,
      (select c.org_id from cases c where c.id = r.case_id) as org_id`;

  if (claimed.length === 0) {
    const [current] = await sql<{ kind: string; status: string; template: string }[]>`
      select kind, status, template from recordings where id = ${recordingId}`;
    if (!current || current.kind === "intake_call") return { ok: false, status: 404, error: SCRIBE_MESSAGES.notFound };
    if (current.template === "child_dev_isaa") return { ok: false, status: 409, error: SCRIBE_MESSAGES.isaa };
    if (current.status === "extracting") return { ok: false, status: 409, error: SCRIBE_MESSAGES.running };
    return { ok: false, status: 409, error: SCRIBE_MESSAGES.transcribeFirst };
  }

  const rec = claimed[0];
  const template = rec.template as NoteTemplate;
  if (!isNoteTemplate(template)) {
    await restore(sql, recordingId, rec.previous_status, null);
    return { ok: false, status: 409, error: SCRIBE_MESSAGES.isaa };
  }

  // FR-3: never for a video (Meet) appointment, also when the appointment changed after the upload.
  if (rec.appointment_id) {
    const check = await checkScribeAppointment(sql, rec.appointment_id, { id: rec.case_id, org_id: rec.org_id, child_id: rec.child_id });
    if (!check.ok) {
      await restore(sql, recordingId, rec.previous_status, null);
      return { ok: false, status: check.status, error: check.error };
    }
  }

  const consentAbort = (stage: string) => ({
    ok: false as const,
    status: 422,
    error: CONSENT_REQUIRED_ERROR,
    details: { feature: "ai_extraction", child_id: rec.child_id, reason: CONSENT_WITHDRAWN, stage },
  });
  const stage = (name: string) => ({ stage: name, caseId: rec.case_id, recordingId, markRecordingFailed: true });

  try {
    const segments: Segment[] = SegmentSchema.array().parse(rec.segments);
    const spec = NOTE_TEMPLATES[template];
    const [goalRows, health, prescriber] = await Promise.all([
      activeGoals(sql, rec.case_id),
      safeHealthSummary(rec.case_id),
      spec.rxDraft ? uploaderCanPrescribe(sql, rec.uploaded_by) : Promise.resolve(false),
    ]);
    const goals: PromptGoal[] = goalsForPrompt(goalRows);

    // 020 FR-8: re-check right before the transcript leaves for Gemini.
    if (!(await assertConsentOrAbort(rec.child_id, "ai_extraction", stage("before_gemini_scribe_note")))) {
      return consentAbort("before_gemini_scribe_note");
    }
    const noteSchema = noteOutputSchema(template);
    const output = noteSchema.parse(
      await generate({
        task: spec.geminiTask,
        system: loadPrompt(spec.prompt),
        prompt: buildNotePrompt({ template, segments, goals, healthSummary: health }),
        schema: noteSchema,
      }),
    ) as NoteOutput;
    const note = processNote({ template, output, segments, healthSummary: health });
    const suggestions = processGoalSuggestions(output.goal_suggestions, goals, segments);

    let rx: ReturnType<typeof processRx> | null = null;
    if (prescriber) {
      if (!(await assertConsentOrAbort(rec.child_id, "ai_extraction", stage("before_gemini_rx_draft")))) {
        return consentAbort("before_gemini_rx_draft");
      }
      const rxOutput = RxOutputSchema.parse(
        await generate({
          task: RX_GEMINI_TASK,
          system: loadPrompt(RX_PROMPT),
          prompt: buildRxPrompt({ segments, plan: planStatements(note), healthSummary: health }),
          schema: RxOutputSchema,
        }),
      ) as RxOutput;
      rx = processRx(rxOutput, segments, health);
    }

    const body = await sql.begin(async (tx) => {
      const [locked] = await tx<{ status: string }[]>`select status from recordings where id = ${recordingId} for update`;
      if (!locked) throw new Error("Session was deleted while the scribe was running");
      if (locked.status !== "extracting") throw new Error(`Session status changed to ${locked.status} while the scribe was running`);

      // A final note is never replaced (the update's where clause); the draft is.
      const md = noteMarkdown(note);
      await tx`
        insert into reports (case_id, recording_id, kind, content, content_md, status)
        values (${rec.case_id}, ${recordingId}, 'session_note', ${tx.json(asJson(note))}, ${md}, 'draft')
        on conflict (recording_id, kind) do update
          set content = excluded.content, content_md = excluded.content_md, updated_at = now()
          where reports.status = 'draft'`;
      const [noteRow] = await tx<{ id: string; status: "draft" | "final" }[]>`
        select id, status from reports where recording_id = ${recordingId} and kind = 'session_note'`;

      let rxId: string | undefined;
      if (rx) {
        await tx`
          insert into reports (case_id, recording_id, kind, content, content_md, status)
          values (${rec.case_id}, ${recordingId}, 'rx_draft', ${tx.json(asJson(rx))}, ${rxMarkdown(rx)}, 'draft')
          on conflict (recording_id, kind) do update
            set content = excluded.content, content_md = excluded.content_md, updated_at = now()
            where reports.status = 'draft'`;
        const [rxRow] = await tx<{ id: string }[]>`select id from reports where recording_id = ${recordingId} and kind = 'rx_draft'`;
        rxId = rxRow.id;
      } else {
        // Not (or no longer) a verified prescriber: no Rx draft may remain from an earlier run.
        await tx`delete from reports where recording_id = ${recordingId} and kind = 'rx_draft' and status = 'draft'`;
      }

      await tx`delete from goal_progress_suggestions where recording_id = ${recordingId} and status = 'suggested'`;
      for (const s of suggestions) {
        await tx`
          insert into goal_progress_suggestions (recording_id, case_id, goal_id, suggested_value, evidence, rationale)
          values (${recordingId}, ${rec.case_id}, ${s.goal_id}, ${s.suggested_value}, ${tx.json(asJson(s.evidence))}, ${s.rationale})
          on conflict (recording_id, goal_id) do nothing`;
      }

      await tx`update recordings set status = 'extracted', error = null where id = ${recordingId}`;
      await auditStrict(
        {
          caseId: rec.case_id,
          actor: "ai",
          actorRole: "ai",
          action: "scribe.completed",
          entity: "recording",
          entityId: recordingId,
          details: {
            template,
            session_note_id: noteRow.id,
            session_note_status: noteRow.status,
            statements: note.sections.reduce((n, s) => n + s.statements.length, 0),
            goal_suggestions: suggestions.length,
            rx_draft: Boolean(rxId),
          },
        },
        tx,
      );

      return {
        recording_id: recordingId,
        session_note_id: noteRow.id,
        session_note_status: noteRow.status,
        goal_suggestions: await listSuggestions(tx, recordingId),
        ...(rxId ? { rx_draft_id: rxId } : {}),
      } satisfies ScribeResponse;
    });
    return { ok: true, body };
  } catch (err) {
    const message = errorMessage(err).replace(/postgres(ql)?:\/\/\S+/g, "<db-url>");
    try {
      await restore(sql, recordingId, rec.previous_status, message.slice(0, 1000));
    } catch (restoreErr) {
      console.error(`scribe failed for ${recordingId} and could not be restored: ${errorMessage(restoreErr)}`);
    }
    console.error(`scribe failed for ${recordingId}: ${message}`);
    return { ok: false, status: 502, error: SCRIBE_MESSAGES.failed, details: message };
  }
}
