// Builds the case context for "Ask the case" (ticket 013, FR-2). The builder is pure; loadAskCase reads the DB.
import { readFileSync } from "node:fs";
import path from "node:path";
import { getCaseSheetField } from "@/lib/caseSheet";
import { supabaseAdmin } from "@/lib/db";
import { getIsaaItem, ratingLabel } from "@/lib/isaa";
import { SegmentSchema, type Evidence, type FactRow, type FactValue, type Segment } from "@/lib/types";
import {
  clock,
  factCitation,
  segmentCitation,
  type CitableContext,
  type CitationRecording,
  type ResolvedCitation,
} from "@/lib/ask/citations";

export const MAX_CONTEXT_CHARS = 60_000;

export type AskRecording = CitationRecording & { segments: Segment[]; created_at: string };
export type AskFact = {
  id: string;
  instrument: "ISAA" | "CASE_SHEET";
  item_id: string;
  recording_id: string;
  value: FactValue;
  status: FactRow["status"];
  evidence: Evidence | null;
};
export type AskCase = { recordings: AskRecording[]; facts: AskFact[]; briefSummary: string | null };

export type AskContext = {
  /** Exactly the text sent to the model. */
  text: string;
  /** Only the ids that survived truncation; citations are validated against these. */
  citable: CitableContext;
};

type Line = { text: string; ref?: ResolvedCitation };
type Group = { title: string; lines: Line[] };

const isRating = (value: FactValue): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;

function factValueText(value: Exclude<FactValue, null>): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function isaaLine(fact: AskFact, recordings: Map<string, CitationRecording>): Line {
  const item = getIsaaItem(fact.item_id);
  let text = `[fact:${fact.id}] ${fact.item_id}. ${item?.text ?? "ISAA item"}: ${ratingLabel(fact.value as number)}`;
  if (fact.evidence) {
    const recording = recordings.get(fact.evidence.recording_id);
    const where =
      recording?.kind === "intake_call"
        ? `Intake call ${clock(fact.evidence.start_sec)}`
        : `Session ${recording?.session_number ?? "?"} ${clock(fact.evidence.start_sec)}`;
    text += ` - "${fact.evidence.quote}" (${where})`;
  }
  return { text, ref: factCitation(fact, recordings) };
}

function caseSheetLine(fact: AskFact, recordings: Map<string, CitationRecording>): Line {
  const label = getCaseSheetField(fact.item_id)?.label ?? fact.item_id;
  return {
    text: `[fact:${fact.id}] (parent-reported) ${label}: ${factValueText(fact.value as Exclude<FactValue, null>)}`,
    ref: factCitation(fact, recordings),
  };
}

function segmentLines(recording: AskRecording): Line[] {
  return recording.segments.map((segment) => {
    const ref = segmentCitation(recording, segment);
    return { text: `[${ref.id} | ${clock(segment.start_sec)} | ${segment.speaker.toUpperCase()}] ${segment.text}`, ref };
  });
}

/** Sessions by number (latest recording wins a duplicate number) and the latest intake call with segments. */
function transcriptRecordings(recordings: AskRecording[]): { sessions: AskRecording[]; intake: AskRecording | null } {
  const newestFirst = [...recordings].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const byNumber = new Map<number, AskRecording>();
  let intake: AskRecording | null = null;
  for (const recording of newestFirst) {
    if (recording.segments.length === 0) continue;
    if (recording.kind === "intake_call") {
      intake ??= recording;
    } else if (recording.session_number !== null && !byNumber.has(recording.session_number)) {
      byNumber.set(recording.session_number, recording);
    }
  }
  const sessions = [...byNumber.values()].sort((a, b) => (a.session_number ?? 0) - (b.session_number ?? 0));
  return { sessions, intake };
}

function groupLength(group: Group): number {
  return group.title.length + group.lines.reduce((sum, line) => sum + line.text.length + 1, 0);
}

function render(groups: Group[]): string {
  return groups
    .filter((group) => group.lines.length > 0)
    .map((group) => [group.title, ...group.lines.map((line) => line.text)].join("\n"))
    .join("\n\n");
}

/**
 * FR-2. Groups are cut from their end, one line at a time, until the text fits: intake transcript first,
 * then session transcripts from the oldest session, then (only if still too long) the brief summary,
 * parent-reported answers and ISAA facts.
 */
export function buildAskContext(input: AskCase, maxChars = MAX_CONTEXT_CHARS): AskContext {
  const recordingMap = new Map<string, CitationRecording>(input.recordings.map((r) => [r.id, r]));
  const isaa = input.facts
    .filter((f) => f.instrument === "ISAA" && (f.status === "confirmed" || f.status === "edited") && isRating(f.value))
    .sort((a, b) => Number(a.item_id) - Number(b.item_id))
    .map((f) => isaaLine(f, recordingMap));
  const caseSheet = input.facts
    .filter((f) => f.instrument === "CASE_SHEET" && f.value !== null)
    .map((f) => caseSheetLine(f, recordingMap));
  const { sessions, intake } = transcriptRecordings(input.recordings);

  const factsGroup: Group = { title: "ISAA facts confirmed by the therapist:", lines: isaa };
  const caseSheetGroup: Group = { title: "Intake answers (parent-reported):", lines: caseSheet };
  const briefGroup: Group = {
    title: "Pre-session brief summary (parent-reported):",
    lines: input.briefSummary?.trim() ? [{ text: input.briefSummary.trim() }] : [],
  };
  const sessionGroups: Group[] = sessions.map((s) => ({
    title: `Session ${s.session_number} transcript:`,
    lines: segmentLines(s),
  }));
  const intakeGroup: Group = { title: "Intake call transcript:", lines: intake ? segmentLines(intake) : [] };

  const groups = [factsGroup, caseSheetGroup, briefGroup, ...sessionGroups, intakeGroup];
  const cutOrder = [intakeGroup, ...sessionGroups, briefGroup, caseSheetGroup, factsGroup];

  const nonEmpty = () => groups.filter((g) => g.lines.length > 0);
  let total = nonEmpty().reduce((sum, g) => sum + groupLength(g), 0) + 2 * Math.max(0, nonEmpty().length - 1);
  for (const group of cutOrder) {
    while (total > maxChars && group.lines.length > 0) {
      const line = group.lines.pop() as Line;
      total -= line.text.length + 1;
      if (group.lines.length === 0) {
        total -= group.title.length;
        if (nonEmpty().length > 0) total -= 2;
      }
    }
  }

  const text = render(groups);
  const citable: CitableContext = { facts: new Map(), segments: new Map() };
  for (const group of groups) {
    for (const line of group.lines) {
      if (!line.ref) continue;
      (line.ref.kind === "fact" ? citable.facts : citable.segments).set(line.ref.id, line.ref);
    }
  }
  return { text, citable };
}

export function buildAskPrompt(question: string, contextText: string): string {
  return [
    "Case record (ids in square brackets; cite them exactly as written):",
    "",
    contextText || "(no documented facts or transcripts)",
    "",
    `Specialist's question: ${question}`,
  ].join("\n");
}

export function askSystemPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "ask.md"), "utf8");
}

function parseSegments(value: unknown): Segment[] {
  const parsed = SegmentSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Server only: everything of one case that may go into the ask context. */
export async function loadAskCase(caseId: string): Promise<AskCase> {
  const db = supabaseAdmin();
  const [recordings, facts, brief] = await Promise.all([
    db.from("recordings").select("id, kind, session_number, segments, created_at").eq("case_id", caseId),
    db
      .from("facts")
      .select("id, instrument, item_id, recording_id, value, status, evidence")
      .eq("case_id", caseId),
    db
      .from("reports")
      .select("content")
      .eq("case_id", caseId)
      .eq("kind", "pre_session_brief")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (recordings.error) throw new Error(`Could not load recordings: ${recordings.error.message}`);
  if (facts.error) throw new Error(`Could not load facts: ${facts.error.message}`);
  if (brief.error) throw new Error(`Could not load brief: ${brief.error.message}`);

  const summary = (brief.data?.content as { summary?: unknown } | null)?.summary;
  return {
    recordings: (recordings.data ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as AskRecording["kind"],
      session_number: (r.session_number as number | null) ?? null,
      segments: parseSegments(r.segments),
      created_at: r.created_at as string,
    })),
    facts: (facts.data ?? []) as AskFact[],
    briefSummary: typeof summary === "string" ? summary : null,
  };
}
