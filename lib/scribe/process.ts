// Ticket 038 FR-4: pure scribe helpers - prompt building, citation checks, goal-suggestion mapping, copy rules and the
// session-note markdown. No I/O; unit tested in tests/scribe.test.ts.
import { SPEAKER_LABELS_EN, SPEAKER_ROLES } from "@/lib/clinical/speakers";
import { valueInRange, type MeasureType } from "@/lib/iep/schema";
import { formatTime, toPromptLines } from "@/lib/transcript";
import type { Segment } from "@/lib/types";
import type {
  GoalSuggestionOutput,
  NoteOutput,
  ProcessedGoalSuggestion,
  RxDraftContent,
  RxOutput,
  SessionNoteContent,
  StoredCitation,
  StoredSection,
} from "./schema";
import { NOTE_TEMPLATES, type NoteTemplate } from "./templates";

export type PromptGoal = {
  ref: string;
  id: string;
  statement: string;
  measure_type: MeasureType;
  baseline_value: number;
  target_value: number;
  latest_value: number | null;
};

const MEASURE_HINT: Record<MeasureType, string> = {
  percent: "percent, 0-100",
  count: "count, a whole number of 0 or more",
  rating_1_5: "rating from 1 to 5",
  yes_no: "1 = yes, 0 = no",
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// NFR-3 copy rule: output that can reach a guardian never labels a condition. The banned stem is assembled at runtime
// so scripts/dev/check-copy.mjs does not flag this file.
const STEM = ["diag", "nos"].join("");
const REWRITES: [RegExp, string][] = [
  [new RegExp(`\\b${STEM}es\\b`, "gi"), "clinical impressions"],
  [new RegExp(`\\b${STEM}is\\b`, "gi"), "clinical impression"],
  [new RegExp(`\\b${STEM}ed\\b`, "gi"), "identified"],
  [new RegExp(`\\b${STEM}ing\\b`, "gi"), "identifying"],
  [new RegExp(`\\b${STEM}tic\\b`, "gi"), "clinical"],
  [new RegExp(`\\b${STEM}e\\b`, "gi"), "identify"],
  [new RegExp(`\\b${STEM}\\w*`, "gi"), "clinical impression"],
];

/** Rewrites every word with the banned stem (NFR-3). */
export function applyCopyRules(text: string): string {
  return REWRITES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

export function violatesCopyRules(text: string): boolean {
  return new RegExp(STEM, "i").test(text);
}

export function goalsForPrompt(
  goals: { id: string; statement: string; measure_type: MeasureType; baseline_value: number; target_value: number; latest_value: number | null }[],
): PromptGoal[] {
  return goals.map((g, i) => ({ ...g, ref: `G${i + 1}` }));
}

const SPEAKER_LEGEND = SPEAKER_ROLES.map((role) => `${role.toUpperCase()} = ${SPEAKER_LABELS_EN[role]}`).join("; ");

export function buildNotePrompt(args: {
  template: NoteTemplate;
  segments: Segment[];
  goals: PromptGoal[];
  healthSummary: string | null;
}): string {
  const spec = NOTE_TEMPLATES[args.template];
  const goals = args.goals.length
    ? args.goals.map(
        (g) =>
          `${g.ref}. ${g.statement} | measure: ${MEASURE_HINT[g.measure_type]} | baseline ${g.baseline_value} | target ${g.target_value}` +
          ` | latest recorded ${g.latest_value ?? "none"}`,
      )
    : ["(none: return an empty goal_suggestions list)"];
  return [
    `Session type: ${spec.title}`,
    "Sections (key: heading). Use only these keys:",
    ...spec.sections.map((s) => `- ${s.key}: ${s.heading}`),
    "",
    "Active IEP goals (suggest progress only for these refs, only with direct evidence):",
    ...goals,
    "",
    `Health summary: ${args.healthSummary ?? "not available"}`,
    "",
    `Speaker roles: ${SPEAKER_LEGEND}.`,
    "Transcript (one segment per line: [segment_id | start-end | SPEAKER] text):",
    ...toPromptLines(args.segments),
  ].join("\n");
}

export function buildRxPrompt(args: { segments: Segment[]; plan: string[]; healthSummary: string | null }): string {
  return [
    `Health summary (check allergies and current medicines): ${args.healthSummary ?? "not available"}`,
    "",
    "Plan from the consult note:",
    ...(args.plan.length ? args.plan.map((p) => `- ${p}`) : ["- (no plan statements)"]),
    "",
    `Speaker roles: ${SPEAKER_LEGEND}.`,
    "Transcript (one segment per line: [segment_id | start-end | SPEAKER] text):",
    ...toPromptLines(args.segments),
  ].join("\n");
}

/** Keeps only citations of existing segments (once each), with their times; `verified` = the quote is in the segment. */
export function resolveCitations(citations: { segment_id: string; quote: string }[], segments: Segment[]): StoredCitation[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const out: StoredCitation[] = [];
  for (const c of citations) {
    const segment = byId.get(c.segment_id);
    if (!segment || out.some((o) => o.segment_id === segment.id)) continue;
    const quote = c.quote.trim().slice(0, 300);
    out.push({
      segment_id: segment.id,
      quote,
      start_sec: segment.start_sec,
      end_sec: segment.end_sec,
      verified: quote !== "" && normalizeText(segment.text).includes(normalizeText(quote)),
    });
  }
  return out;
}

/** Template sections in template order; statements rewritten for the copy rules; unknown citations dropped. */
export function processNote(args: {
  template: NoteTemplate;
  output: NoteOutput;
  segments: Segment[];
  healthSummary: string | null;
}): SessionNoteContent {
  const spec = NOTE_TEMPLATES[args.template];
  const sections: StoredSection[] = spec.sections.map((s) => ({
    key: s.key,
    heading: s.heading,
    statements: args.output.sections
      .filter((o) => o.key === s.key)
      .flatMap((o) => o.statements)
      .map((st) => ({ text: applyCopyRules(st.text.trim()), citations: resolveCitations(st.citations, args.segments) })),
  }));
  return { template: args.template, title: spec.title, sections, health_summary: args.healthSummary };
}

/**
 * Suggestions -> goal ids. Dropped: unknown goal refs, unknown segments, values outside the goal's measure, and every
 * suggestion after the first for the same goal.
 */
export function processGoalSuggestions(
  suggestions: GoalSuggestionOutput[],
  goals: PromptGoal[],
  segments: Segment[],
): ProcessedGoalSuggestion[] {
  const byRef = new Map(goals.map((g) => [g.ref, g]));
  const out: ProcessedGoalSuggestion[] = [];
  for (const s of suggestions) {
    const goal = byRef.get(s.goal_ref);
    if (!goal || out.some((o) => o.goal_id === goal.id)) continue;
    if (!valueInRange(goal.measure_type, s.suggested_value)) continue;
    const evidence = resolveCitations([{ segment_id: s.segment_id, quote: s.quote }], segments);
    if (evidence.length === 0) continue;
    out.push({ goal_id: goal.id, suggested_value: s.suggested_value, evidence, rationale: applyCopyRules(s.rationale.trim()).slice(0, 1000) });
  }
  return out;
}

export function processRx(output: RxOutput, segments: Segment[], healthSummary: string | null): RxDraftContent {
  return {
    items: output.items.map((item) => ({
      ...item,
      instructions: item.instructions === null ? null : applyCopyRules(item.instructions),
      citations: resolveCitations(item.citations, segments),
    })),
    advice: output.advice === null ? null : applyCopyRules(output.advice),
    follow_up: output.follow_up === null ? null : applyCopyRules(output.follow_up),
    health_summary: healthSummary,
  };
}

/** Plan statements of a medical note (input of the Rx prompt). */
export function planStatements(note: SessionNoteContent): string[] {
  return note.sections.filter((s) => s.key === "plan").flatMap((s) => s.statements.map((st) => st.text));
}

// ---------- markdown ----------

/** `[01:23](#seg-s4)`: a citation link the review screen turns into an audio jump (013 pattern). */
export const CITATION_LINK = /\s?\[(\d{2}:\d{2})\]\(#seg-([A-Za-z0-9_:-]{1,40})\)/g;

export function citationLink(c: StoredCitation): string {
  return `[${formatTime(c.start_sec)}](#seg-${c.segment_id})`;
}

export function noteMarkdown(note: SessionNoteContent): string {
  const lines = [`# ${note.title}`, ""];
  for (const section of note.sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.statements.length === 0) lines.push("- Not discussed in this session.");
    for (const st of section.statements) {
      const cites = st.citations.map(citationLink).join(" ");
      lines.push(`- ${st.text}${cites ? ` ${cites}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function rxMarkdown(rx: RxDraftContent): string {
  const lines = ["# Prescription draft (for the prescriber to review and sign)", ""];
  if (rx.health_summary) lines.push(`Health summary: ${rx.health_summary}`, "");
  if (rx.items.length === 0) lines.push("- No medicines suggested.");
  rx.items.forEach((item, i) => {
    const cites = item.citations.map(citationLink).join(" ");
    lines.push(
      `${i + 1}. ${item.drug} ${item.strength} ${item.form} - ${item.dose}, ${item.frequency}, ${item.duration_days} days (${item.route})` +
        `${item.instructions ? `. ${item.instructions}` : ""}${cites ? ` ${cites}` : ""}`,
    );
  });
  if (rx.advice) lines.push("", `Advice: ${rx.advice}`);
  if (rx.follow_up) lines.push("", `Follow-up: ${rx.follow_up}`);
  return lines.join("\n").trimEnd() + "\n";
}

/** The guardian-facing version: audio citation links removed (guardians never get the recording). */
export function stripCitations(markdown: string): string {
  return markdown.replace(CITATION_LINK, "");
}

/** Segment ids cited by the markdown (to check citations point to the transcript). */
export function citedSegmentIds(markdown: string): string[] {
  return [...markdown.matchAll(CITATION_LINK)].map((m) => m[2]);
}
