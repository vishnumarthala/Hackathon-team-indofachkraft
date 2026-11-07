import { readFileSync } from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { env } from "@/lib/env";
import { generateJson } from "@/lib/gemini";
import { ISAA } from "@/lib/isaa";
import {
  IsaaExtractionSchema,
  SegmentSchema,
  type Evidence,
  type FactRow,
  type FactValue,
  type IsaaExtraction,
  type IsaaRating,
  type Segment,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Pure helpers (FR-2, FR-3, FR-4, FR-5)
// ---------------------------------------------------------------------------

const ITEM_COUNT = 40;
const NO_EVIDENCE = "No direct evidence in this session.";
const UNVERIFIED_CONFIDENCE_CAP = 0.5;

export type VoiceNote = { item_id: number; rating: number; segment_id: string; text: string };

export type ProcessedItem = {
  item_id: number;
  rating: IsaaRating | null;
  confidence: number;
  rationale: string;
  evidence: Evidence | null;
};

export type ProcessedExtraction = { items: ProcessedItem[]; red_flags: IsaaExtraction["red_flags"] };

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mmss(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Same line format as lib/transcript.ts (ticket 005): `[s12 | 01:23-01:30 | PARENT] text`.
function toPromptLines(segments: Segment[]): string {
  return segments
    .map((s) => `[${s.id} | ${mmss(s.start_sec)}-${mmss(s.end_sec)} | ${s.speaker.toUpperCase()}] ${s.text}`)
    .join("\n");
}

export function buildExtractPrompt(segments: Segment[]): string {
  const domainName = new Map(ISAA.domains.map((d) => [d.id, d.name]));
  const items = ISAA.items.map((item) => `${item.id}. ${item.text} [${domainName.get(item.domain) ?? item.domain}]`);
  const scale = ISAA.scale.map((step) => `${step.value} = ${step.label} (${step.range})`);
  return [
    "ISAA items (rate each from 1 to 5 only with direct evidence, otherwise null):",
    ...items,
    "",
    "Rating scale (how often the behaviour occurs):",
    ...scale,
    "",
    "Transcript (one segment per line: [segment_id | start-end | SPEAKER] text):",
    toPromptLines(segments),
    "",
    "Return one entry per item 1-40 in `items`, plus `red_flags` and `therapist_notes`.",
  ].join("\n");
}

export function loadExtractSystemPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "extract.md"), "utf8");
}

export function postProcess({
  extraction,
  segments,
  recordingId,
}: {
  extraction: IsaaExtraction;
  segments: Segment[];
  recordingId: string;
}): ProcessedExtraction {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const items = new Map<number, ProcessedItem>();

  for (const raw of extraction.items) {
    if (items.has(raw.item_id)) continue;
    const segment = raw.segment_id === null ? undefined : byId.get(raw.segment_id);
    const quote = raw.quote ?? "";
    // D-1: no rating without evidence (unknown segment, missing quote, or no rating at all).
    if (!segment || normalizeText(quote) === "" || raw.rating === null) {
      items.set(raw.item_id, {
        item_id: raw.item_id,
        rating: null,
        confidence: 0,
        rationale: raw.rating === null ? raw.rationale || NO_EVIDENCE : NO_EVIDENCE,
        evidence: null,
      });
      continue;
    }
    const verified = normalizeText(segment.text).includes(normalizeText(quote));
    items.set(raw.item_id, {
      item_id: raw.item_id,
      rating: raw.rating,
      confidence: verified ? raw.confidence : Math.min(raw.confidence, UNVERIFIED_CONFIDENCE_CAP),
      rationale: raw.rationale,
      evidence: {
        quote,
        segment_id: segment.id,
        start_sec: segment.start_sec,
        end_sec: segment.end_sec,
        recording_id: recordingId,
        verified,
      },
    });
  }

  for (let id = 1; id <= ITEM_COUNT; id++) {
    if (!items.has(id)) items.set(id, { item_id: id, rating: null, confidence: 0, rationale: NO_EVIDENCE, evidence: null });
  }

  return {
    items: [...items.values()].sort((a, b) => a.item_id - b.item_id),
    red_flags: extraction.red_flags.filter((flag) => byId.has(flag.segment_id)),
  };
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40 };

function parseNumber(token: string): number | null {
  const words = token.trim().split(/\s+/);
  if (words.length === 1 && /^\d+$/.test(words[0])) return Number(words[0]);
  if (words.length === 1) return UNITS[words[0]] ?? TENS[words[0]] ?? null;
  if (words.length === 2 && words[0] in TENS && words[1] in UNITS && UNITS[words[1]] >= 1 && UNITS[words[1]] <= 9) {
    return TENS[words[0]] + UNITS[words[1]];
  }
  return null;
}

const NOTE_PATTERN = /\brate\s+item\s+(\d+|[a-z]+(?:\s+[a-z]+)?)\s+(?:as|at|to)\s+(\d+|[a-z]+)\b/g;

export function parseVoiceNotes(segments: Segment[]): VoiceNote[] {
  const notes = new Map<number, VoiceNote>();
  for (const segment of segments) {
    if (segment.speaker !== "therapist") continue;
    if (!/^note\b/i.test(segment.text.trim())) continue;
    const text = segment.text.toLowerCase().replace(/-/g, " ");
    for (const match of text.matchAll(NOTE_PATTERN)) {
      const itemId = parseNumber(match[1]);
      const rating = parseNumber(match[2]);
      if (itemId === null || rating === null) continue;
      if (itemId < 1 || itemId > ITEM_COUNT || rating < 1 || rating > 5) continue;
      notes.set(itemId, { item_id: itemId, rating, segment_id: segment.id, text: segment.text });
    }
  }
  return [...notes.values()].sort((a, b) => a.item_id - b.item_id);
}

export function mergeVoiceNotes(
  regexNotes: VoiceNote[],
  geminiNotes: IsaaExtraction["therapist_notes"],
  segments: Segment[],
): VoiceNote[] {
  const merged = new Map(regexNotes.map((note) => [note.item_id, note]));
  const fromGemini = new Map<number, VoiceNote>();
  for (const note of geminiNotes) {
    if (note.item_id === null || note.rating === null || merged.has(note.item_id)) continue;
    const segment = segments.find((s) => s.id === note.segment_id);
    if (!segment || segment.speaker !== "therapist") continue;
    fromGemini.set(note.item_id, { item_id: note.item_id, rating: note.rating, segment_id: segment.id, text: segment.text });
  }
  for (const [id, note] of fromGemini) merged.set(id, note);
  return [...merged.values()].sort((a, b) => a.item_id - b.item_id);
}

export type ExistingFact = { item_id: string; status: FactRow["status"]; ai_value: FactValue };

export type FactWrite = {
  case_id: string;
  recording_id: string;
  item_id: string;
  value: FactValue;
  ai_value: FactValue;
  source: FactRow["source"];
  evidence: Evidence | null;
  confidence: number;
  rationale: string;
  status: FactRow["status"];
  confirmed_by: string | null;
  confirmed_at: string | null;
};

// FR-5: the rows to upsert. Confirmed/edited rows are never written; voice notes confirm the rest.
export function computeFactWrites(args: {
  processed: ProcessedExtraction;
  notes: VoiceNote[];
  existing: ExistingFact[];
  segments: Segment[];
  caseId: string;
  recordingId: string;
  therapistName: string;
  now: string;
}): { rows: FactWrite[]; notesApplied: number } {
  const { processed, notes, existing, segments, caseId, recordingId, therapistName, now } = args;
  const existingById = new Map(existing.map((fact) => [Number(fact.item_id), fact]));
  const noteById = new Map(notes.map((note) => [note.item_id, note]));
  const rows: FactWrite[] = [];
  let notesApplied = 0;

  for (const item of processed.items) {
    const prior = existingById.get(item.item_id);
    if (prior && prior.status !== "suggested") continue;
    const row: FactWrite = {
      case_id: caseId,
      recording_id: recordingId,
      item_id: String(item.item_id),
      value: item.rating,
      ai_value: prior && prior.ai_value !== null && prior.ai_value !== undefined ? prior.ai_value : item.rating,
      source: "session",
      evidence: item.evidence,
      confidence: item.confidence,
      rationale: item.rationale,
      status: "suggested",
      confirmed_by: null,
      confirmed_at: null,
    };
    const note = noteById.get(item.item_id);
    const segment = note ? segments.find((s) => s.id === note.segment_id) : undefined;
    if (note && segment) {
      Object.assign(row, {
        value: note.rating,
        source: "therapist_voice",
        status: "confirmed",
        confirmed_by: `${therapistName} (voice note)`,
        confirmed_at: now,
        rationale: item.rating === null ? "Rated by the therapist in a voice note." : item.rationale,
        evidence: {
          quote: note.text.slice(0, 300),
          segment_id: segment.id,
          start_sec: segment.start_sec,
          end_sec: segment.end_sec,
          recording_id: recordingId,
          verified: true,
        },
      });
      notesApplied++;
    }
    rows.push(row);
  }
  return { rows, notesApplied };
}

// ---------------------------------------------------------------------------
// Persistence (FR-1, FR-5, FR-6): server only, uses a direct Postgres connection for transactions.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const globalDb = globalThis as typeof globalThis & { __carethreadExtractionSql?: Sql };

function extractionDb(): Sql {
  if (typeof window !== "undefined") throw new Error("lib/extraction.ts persistence is server-only");
  globalDb.__carethreadExtractionSql ??= postgres(env.DATABASE_URL, {
    max: 3,
    prepare: false,
    idle_timeout: 20,
    onnotice: () => {},
  });
  return globalDb.__carethreadExtractionSql;
}

function messageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/postgres(ql)?:\/\/\S+/g, "<db-url>");
}

export type ExtractionResponse = {
  recording_id: string;
  facts: FactRow[];
  red_flags: IsaaExtraction["red_flags"];
  therapist_notes_applied: number;
};

export type ExtractionOutcome =
  | { ok: true; body: ExtractionResponse }
  | { ok: false; status: number; error: string; details?: string };

export type ExtractionDeps = {
  sql?: Sql;
  generate?: (input: { system: string; prompt: string }) => Promise<IsaaExtraction>;
  now?: () => Date;
  // Test hooks for the integration checks: corrupt rows before the upsert or fail after it.
  hooks?: { beforeUpsert?: (rows: FactWrite[]) => void; afterUpsert?: () => Promise<void> | void };
};

type DbFact = Omit<FactRow, "confidence" | "confirmed_at" | "created_at"> & {
  confidence: number | null;
  confirmed_at: Date | string | null;
  created_at: Date | string;
};

// postgres.js serializes jsonb parameters itself; pass plain values, never pre-stringified JSON.
const asJson = (value: unknown) => value as postgres.JSONValue;

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

function toFactRow(row: DbFact): FactRow {
  return {
    ...row,
    confidence: row.confidence === null ? null : Number(row.confidence),
    confirmed_at: row.confirmed_at === null ? null : iso(row.confirmed_at),
    created_at: iso(row.created_at),
  };
}

const notFound = (): ExtractionOutcome => ({ ok: false, status: 404, error: "Session not found" });

export async function runExtraction(recordingId: string, deps: ExtractionDeps = {}): Promise<ExtractionOutcome> {
  if (!UUID.test(recordingId)) return notFound();
  const sql = deps.sql ?? extractionDb();

  const claimed = await sql<{ previous_status: "transcribed" | "extracted"; segments: unknown }[]>`
    with prev as (
      select id, status from recordings where id = ${recordingId} and kind = 'session' for update
    )
    update recordings r set status = 'extracting'
    from prev
    where r.id = prev.id and prev.status in ('transcribed', 'extracted')
    returning prev.status as previous_status, r.segments`;

  if (claimed.length === 0) {
    const [current] = await sql<{ kind: string; status: string }[]>`
      select kind, status from recordings where id = ${recordingId}`;
    if (!current || current.kind !== "session") return notFound();
    if (current.status === "extracting") return { ok: false, status: 409, error: "Extraction already running" };
    return { ok: false, status: 409, error: "Transcribe the session first" };
  }

  const previousStatus = claimed[0].previous_status;
  try {
    const segments = SegmentSchema.array().parse(claimed[0].segments);
    const system = loadExtractSystemPrompt();
    const prompt = buildExtractPrompt(segments);
    const extraction = deps.generate
      ? IsaaExtractionSchema.parse(await deps.generate({ system, prompt }))
      : await generateJson({ task: "extract", system, prompt, schema: IsaaExtractionSchema });
    const processed = postProcess({ extraction, segments, recordingId });
    const notes = mergeVoiceNotes(parseVoiceNotes(segments), extraction.therapist_notes, segments);
    const now = (deps.now?.() ?? new Date()).toISOString();

    const body = await sql.begin(async (tx) => {
      const [recording] = await tx<{ case_id: string; status: string }[]>`
        select case_id, status from recordings where id = ${recordingId} for update`;
      if (!recording) throw new Error("Session was deleted during extraction");
      if (recording.status !== "extracting") throw new Error(`Session status changed to ${recording.status} during extraction`);
      const [kase] = await tx<{ therapist_name: string }[]>`
        select therapist_name from cases where id = ${recording.case_id}`;
      if (!kase) throw new Error("Case was deleted during extraction");

      // Re-read under lock: decisions made while the model was running win.
      const existing = await tx<ExistingFact[]>`
        select item_id, status, ai_value from facts
        where recording_id = ${recordingId} and instrument = 'ISAA'
        for update`;
      const { rows, notesApplied } = computeFactWrites({
        processed,
        notes,
        existing,
        segments,
        caseId: recording.case_id,
        recordingId,
        therapistName: kase.therapist_name,
        now,
      });
      deps.hooks?.beforeUpsert?.(rows);

      if (rows.length > 0) {
        await tx`
          insert into facts (case_id, recording_id, instrument, item_id, value, ai_value, source, evidence,
                             confidence, rationale, status, confirmed_by, confirmed_at)
          select x.case_id, x.recording_id, 'ISAA', x.item_id, x.value, x.ai_value, x.source, x.evidence,
                 x.confidence, x.rationale, x.status, x.confirmed_by, x.confirmed_at
          from jsonb_to_recordset(${tx.json(asJson(rows))}) as x(
            case_id uuid, recording_id uuid, item_id text, value jsonb, ai_value jsonb, source text,
            evidence jsonb, confidence numeric, rationale text, status text, confirmed_by text,
            confirmed_at timestamptz)
          on conflict (recording_id, instrument, item_id) do update set
            value = excluded.value,
            ai_value = coalesce(facts.ai_value, excluded.ai_value),
            source = excluded.source,
            evidence = excluded.evidence,
            confidence = excluded.confidence,
            rationale = excluded.rationale,
            status = excluded.status,
            confirmed_by = excluded.confirmed_by,
            confirmed_at = excluded.confirmed_at
          where facts.status = 'suggested'`;
      }
      await deps.hooks?.afterUpsert?.();

      const facts = (
        await tx<DbFact[]>`
          select id, case_id, recording_id, instrument, item_id, value, ai_value, source, evidence,
                 confidence::float8 as confidence, rationale, status, confirmed_by, confirmed_at, created_at
          from facts
          where recording_id = ${recordingId} and instrument = 'ISAA'
          order by item_id::int`
      ).map(toFactRow);
      if (facts.length !== ITEM_COUNT) throw new Error(`Expected ${ITEM_COUNT} ISAA facts, found ${facts.length}`);

      const counts = {
        rated: facts.filter((f) => f.value !== null).length,
        verified: facts.filter((f) => f.evidence?.verified === true).length,
        notes: notesApplied,
      };
      await tx`
        update recordings
        set status = 'extracted', red_flags = ${tx.json(asJson(processed.red_flags))}, error = null
        where id = ${recordingId}`;
      await tx`
        update cases set status = 'in_assessment'
        where id = ${recording.case_id} and status in ('booked', 'intake_done')`;
      await tx`
        insert into audit_events (case_id, actor, action, entity, entity_id, details)
        values (${recording.case_id}, 'ai', 'extraction.completed', 'recording', ${recordingId},
                ${tx.json(counts)})`;

      return {
        recording_id: recordingId,
        facts,
        red_flags: processed.red_flags,
        therapist_notes_applied: notesApplied,
      } satisfies ExtractionResponse;
    });
    return { ok: true, body };
  } catch (err) {
    const message = messageOf(err);
    try {
      const restored = await sql<{ case_id: string }[]>`
        update recordings set status = ${previousStatus}, error = ${message.slice(0, 1000)}
        where id = ${recordingId} and status = 'extracting'
        returning case_id`;
      if (restored[0]) {
        await sql`
          insert into audit_events (case_id, actor, action, entity, entity_id, details)
          values (${restored[0].case_id}, 'ai', 'extraction.failed', 'recording', ${recordingId},
                  ${sql.json({ error: message.slice(0, 500) })})`.catch((auditErr: unknown) => {
          console.error(`audit failed: ${messageOf(auditErr)}`);
        });
      }
    } catch (recordErr) {
      console.error(`extraction failed for ${recordingId} and the failure could not be recorded: ${messageOf(recordErr)}`);
      return {
        ok: false,
        status: 500,
        error: "Extraction failed",
        details: `${message}; the failure could not be recorded: ${messageOf(recordErr)}`,
      };
    }
    return { ok: false, status: 502, error: "Extraction failed", details: message };
  }
}
