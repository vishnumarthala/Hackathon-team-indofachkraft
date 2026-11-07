// Seeds a complete synthetic demo case. Usage: npm run -s seed:demo [-- --new] [--confirmed] [--stage transcribed]
import { loadEnvConfig } from "@next/env";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  BriefSchema,
  IsaaExtractionSchema,
  SegmentSchema,
  type Brief,
  type Evidence,
  type FactValue,
  type IsaaExtraction,
  type Segment,
} from "../lib/types";

export const CANONICAL = {
  caseId: "00000000-0000-4000-8000-000000000001",
  intakeId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  token: "demo-intake-token",
  externalId: "seed-canonical",
};

export const SEED_CASE = {
  child_alias: "Ravi (synthetic)",
  child_age_months: 40,
  parent_alias: "Lakshmi (synthetic)",
  language: "te" as const,
  therapist_name: "Demo Therapist",
  status: "in_assessment" as const,
};

const FIXTURES = "demo/fixtures";
const SESSION_AUDIO = "demo/audio/session-1.mp3";
const BUCKET = "recordings";

export const PostCallSchema = z.object({
  type: z.literal("post_call_transcription"),
  event_timestamp: z.number(),
  data: z.object({
    agent_id: z.string(),
    conversation_id: z.string(),
    status: z.string(),
    metadata: z.object({ call_duration_secs: z.number() }),
    transcript: z.array(
      z.object({
        role: z.enum(["agent", "user"]),
        message: z.string().nullable(),
        time_in_call_secs: z.number(),
      }),
    ),
    analysis: z.object({
      transcript_summary: z.string(),
      data_collection_results: z.record(
        z.string(),
        z.object({
          data_collection_id: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
          rationale: z.string(),
        }),
      ),
    }),
    conversation_initiation_client_data: z.object({
      dynamic_variables: z.object({
        intake_token: z.string(),
        child_alias: z.string(),
        parent_alias: z.string(),
        therapist_name: z.string(),
        language: z.string(),
      }),
    }),
  }),
});
export type PostCall = z.infer<typeof PostCallSchema>;

export type SeedOptions = { isNew: boolean; confirmed: boolean; stage: "extracted" | "transcribed" };

export function parseArgs(argv: string[]): SeedOptions {
  const options: SeedOptions = { isNew: false, confirmed: false, stage: "extracted" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--new") options.isNew = true;
    else if (arg === "--confirmed") options.confirmed = true;
    else if (arg === "--stage" || arg.startsWith("--stage=")) {
      const value = arg === "--stage" ? argv[++i] : arg.slice("--stage=".length);
      if (value !== "transcribed" && value !== "extracted") throw new Error(`Unknown stage: ${value ?? "(missing)"}`);
      options.stage = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function readJson<T>(file: string, schema: z.ZodType<T>, root = process.cwd()): T {
  return schema.parse(JSON.parse(readFileSync(path.join(root, FIXTURES, file), "utf8")));
}

export function loadSeedFixtures(root = process.cwd()) {
  return {
    segments: readJson("roleplay-segments.json", z.array(SegmentSchema), root),
    extract: readJson("gemini/extract.json", IsaaExtractionSchema, root),
    brief: readJson("gemini/brief.json", BriefSchema, root),
    postCall: readJson("elevenlabs-post-call.json", PostCallSchema, root),
  };
}

export function buildIntakeSegments(transcript: PostCall["data"]["transcript"]): Segment[] {
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

export function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const FLAG_LABELS: Record<string, string> = { lost_speech: "Lost speech", self_injury: "Self-injury", other: "Other" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderBriefMarkdown(brief: Brief, intakeSegments: Segment[]): string {
  const lines = ["## Pre-session brief (parent-reported)", "", brief.summary, "", "### Red flags", ""];
  if (brief.red_flags.length === 0) lines.push("- None reported");
  for (const flag of brief.red_flags) {
    const seg = intakeSegments.find((s) => s.id === flag.turn_id);
    const at = seg ? ` (${formatTime(seg.start_sec)})` : "";
    lines.push(`- ${FLAG_LABELS[flag.type] ?? "Other"}: "${flag.quote}"${at}`);
  }
  lines.push("", "### Questions to verify", "");
  brief.questions_to_verify.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  lines.push("", "### What the parent reported", "", "| Topic | Answer |", "| --- | --- |");
  for (const row of brief.parent_reported) lines.push(`| ${cell(row.label)} | ${cell(row.value)} |`);
  return lines.join("\n") + "\n";
}

export type FactInsert = {
  case_id: string;
  recording_id: string;
  instrument: "ISAA" | "CASE_SHEET";
  item_id: string;
  value: FactValue;
  ai_value: FactValue;
  source: "parent_call" | "session" | "therapist_voice";
  evidence: Evidence | null;
  confidence: number | null;
  rationale: string | null;
  status: "suggested" | "confirmed" | "edited";
  confirmed_by: string | null;
  confirmed_at: string | null;
};

export function buildCaseSheetFacts(
  caseId: string,
  intakeId: string,
  results: PostCall["data"]["analysis"]["data_collection_results"],
  fieldIds: string[],
): FactInsert[] {
  return fieldIds
    .filter((id) => id in results)
    .map((id) => ({
      case_id: caseId,
      recording_id: intakeId,
      instrument: "CASE_SHEET",
      item_id: id,
      value: results[id].value,
      ai_value: results[id].value,
      source: "parent_call",
      evidence: null,
      confidence: null,
      rationale: results[id].rationale,
      status: "suggested",
      confirmed_by: null,
      confirmed_at: null,
    }));
}

export function buildIsaaFacts(args: {
  caseId: string;
  sessionId: string;
  extract: IsaaExtraction;
  segments: Segment[];
  therapistName: string;
  confirmed: boolean;
  now: string;
}): FactInsert[] {
  const { caseId, sessionId, extract, segments, therapistName, confirmed, now } = args;
  const segmentOf = (id: string | null) => (id ? segments.find((s) => s.id === id) : undefined);
  const facts = new Map<number, FactInsert>();
  for (const item of extract.items) {
    if (facts.has(item.item_id)) continue;
    const seg = segmentOf(item.segment_id);
    const evidence: Evidence | null =
      seg && item.quote
        ? {
            quote: item.quote,
            segment_id: seg.id,
            start_sec: seg.start_sec,
            end_sec: seg.end_sec,
            recording_id: sessionId,
            verified: seg.text.includes(item.quote),
          }
        : null;
    facts.set(item.item_id, {
      case_id: caseId,
      recording_id: sessionId,
      instrument: "ISAA",
      item_id: String(item.item_id),
      value: item.rating,
      ai_value: item.rating,
      source: "session",
      evidence,
      confidence: item.confidence,
      rationale: item.rationale,
      status: "suggested",
      confirmed_by: null,
      confirmed_at: null,
    });
  }
  for (let id = 1; id <= 40; id++) {
    if (!facts.has(id)) {
      facts.set(id, {
        case_id: caseId,
        recording_id: sessionId,
        instrument: "ISAA",
        item_id: String(id),
        value: null,
        ai_value: null,
        source: "session",
        evidence: null,
        confidence: 0,
        rationale: "No direct evidence in this session.",
        status: "suggested",
        confirmed_by: null,
        confirmed_at: null,
      });
    }
  }
  for (const note of extract.therapist_notes) {
    const seg = segmentOf(note.segment_id);
    const fact = note.item_id === null ? undefined : facts.get(note.item_id);
    if (!fact || note.rating === null) continue;
    Object.assign(fact, {
      value: note.rating,
      source: "therapist_voice",
      status: "confirmed",
      confirmed_by: `${therapistName} (voice note)`,
      confirmed_at: now,
      evidence: seg
        ? {
            quote: seg.text.slice(0, 300),
            segment_id: seg.id,
            start_sec: seg.start_sec,
            end_sec: seg.end_sec,
            recording_id: sessionId,
            verified: true,
          }
        : fact.evidence,
    });
  }
  if (confirmed) {
    for (const fact of facts.values()) {
      if (fact.status !== "suggested") continue;
      if (fact.value === null) Object.assign(fact, { value: 1, status: "edited", evidence: null });
      else fact.status = "confirmed";
      fact.confirmed_by = therapistName;
      fact.confirmed_at = now;
    }
  }
  return [...facts.values()].sort((a, b) => Number(a.item_id) - Number(b.item_id));
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const options = parseArgs(process.argv.slice(2));
  const fixtures = loadSeedFixtures();
  const { supabaseAdmin } = await import("../lib/db");
  const { newToken } = await import("../lib/tokens");
  const { CASE_SHEET_FIELDS } = await import("../lib/caseSheet");
  const db = supabaseAdmin();

  const caseId = options.isNew ? randomUUID() : CANONICAL.caseId;
  const intakeId = options.isNew ? randomUUID() : CANONICAL.intakeId;
  const sessionId = options.isNew ? randomUUID() : CANONICAL.sessionId;
  const token = options.isNew ? newToken() : CANONICAL.token;
  const externalId = options.isNew ? `seed-${caseId.slice(0, 8)}` : CANONICAL.externalId;

  const removeStorage = async () => {
    const { data, error } = await db.storage.from(BUCKET).list(caseId, { limit: 1000 });
    if (error) throw new Error(`Could not list storage objects: ${error.message}`);
    const keys = (data ?? []).map((o) => `${caseId}/${o.name}`);
    if (keys.length) {
      const { error: removeError } = await db.storage.from(BUCKET).remove(keys);
      if (removeError) throw new Error(`Could not remove storage objects: ${removeError.message}`);
    }
  };
  const deleteCase = async () => {
    const { error } = await db.from("cases").delete().eq("id", caseId);
    if (error) throw new Error(`Could not delete case: ${error.message}`);
  };
  const check = (label: string, error: { message: string } | null) => {
    if (error) throw new Error(`${label}: ${error.message}`);
  };

  let creating = false;
  try {
    if (!options.isNew) {
      await removeStorage();
      await deleteCase();
    }
    creating = true;
    const now = new Date().toISOString();

    check(
      "insert case",
      (await db.from("cases").insert({ id: caseId, ...SEED_CASE, intake_token: token })).error,
    );

    const { postCall, brief, segments, extract } = fixtures;
    const intakeSegments = buildIntakeSegments(postCall.data.transcript);
    check(
      "insert intake recording",
      (
        await db.from("recordings").insert({
          id: intakeId,
          case_id: caseId,
          kind: "intake_call",
          status: "transcribed",
          external_id: externalId,
          duration_sec: postCall.data.metadata.call_duration_secs,
          segments: intakeSegments,
        })
      ).error,
    );

    const caseSheetFacts = buildCaseSheetFacts(
      caseId,
      intakeId,
      postCall.data.analysis.data_collection_results,
      CASE_SHEET_FIELDS.map((f) => f.id),
    );
    check("insert case-sheet facts", (await db.from("facts").insert(caseSheetFacts)).error);

    check(
      "insert brief",
      (
        await db.from("reports").insert({
          case_id: caseId,
          recording_id: intakeId,
          kind: "pre_session_brief",
          content: brief,
          content_md: renderBriefMarkdown(brief, intakeSegments),
          status: "draft",
        })
      ).error,
    );

    let storagePath: string | null = null;
    let mimeType: string | null = null;
    const audioFile = path.join(process.cwd(), SESSION_AUDIO);
    if (existsSync(audioFile)) {
      storagePath = `${caseId}/${sessionId}.mp3`;
      mimeType = "audio/mpeg";
      const { error } = await db.storage
        .from(BUCKET)
        .upload(storagePath, readFileSync(audioFile), { contentType: mimeType, upsert: true });
      check("upload session audio", error);
    }

    const transcribedOnly = options.stage === "transcribed";
    check(
      "insert session recording",
      (
        await db.from("recordings").insert({
          id: sessionId,
          case_id: caseId,
          kind: "session",
          session_number: 1,
          storage_path: storagePath,
          mime_type: mimeType,
          duration_sec: segments[segments.length - 1]?.end_sec ?? 0,
          status: transcribedOnly ? "transcribed" : "extracted",
          speaker_map: { speaker_0: "therapist", speaker_1: "parent" },
          segments,
          red_flags: transcribedOnly ? [] : extract.red_flags,
          language_code: "eng",
        })
      ).error,
    );

    if (!transcribedOnly) {
      const isaaFacts = buildIsaaFacts({
        caseId,
        sessionId,
        extract,
        segments,
        therapistName: SEED_CASE.therapist_name,
        confirmed: options.confirmed,
        now,
      });
      check("insert ISAA facts", (await db.from("facts").insert(isaaFacts)).error);
    }

    console.log(`seeded case=${caseId} session=${sessionId} intake=${intakeId} token=${token}`);
  } catch (err) {
    if (creating) {
      await removeStorage().catch(() => {});
      await deleteCase().catch(() => {});
    }
    throw err;
  }
}

if (process.argv[1] && /seed-demo\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
