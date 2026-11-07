// 011: pure rules for drafting the assessment report (no I/O except reading the prompt file).
// Only confirmed/edited ISAA facts reach the model, the score and the report (D-1, NFR-1), and the
// model output is filtered so nothing unsupported is presented as observed (FR-3).
import { readFileSync } from "node:fs";
import path from "node:path";
import { getIsaaItem, ratingLabel } from "@/lib/isaa";
import { collectRedFlags, recommend, scoreIsaa, type IsaaScore, type RedFlag, type Recommendation } from "@/lib/scoring";
import { composeReportMarkdown } from "@/lib/report/markdown";
import type { CaseRow, Evidence, FactRow, ReportDraft } from "@/lib/types";

export type DecidedFact = { item_id: number; value: number; status: "confirmed" | "edited"; evidence: Evidence | null };

export function ratingOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

// Confirmed/edited ISAA facts with a rating, one per item 1..40, sorted by item.
export function decidedFacts(facts: Pick<FactRow, "instrument" | "item_id" | "value" | "status" | "evidence">[]): DecidedFact[] {
  const out = new Map<number, DecidedFact>();
  for (const fact of facts) {
    if (fact.instrument !== "ISAA") continue;
    if (fact.status !== "confirmed" && fact.status !== "edited") continue;
    if (!/^[1-9]\d*$/.test(fact.item_id)) continue;
    const id = Number(fact.item_id);
    const value = ratingOf(fact.value);
    if (id > 40 || value === null || out.has(id)) continue;
    out.set(id, { item_id: id, value, status: fact.status, evidence: fact.evidence ?? null });
  }
  return [...out.values()].sort((a, b) => a.item_id - b.item_id);
}

// A quote is usable only when it was recorded and matched its transcript segment.
export function evidenceQuote(fact: DecidedFact): string | null {
  const quote = fact.evidence?.quote?.trim();
  return quote && fact.evidence?.verified !== false ? quote : null;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// `<n>. <item text>: <rating label> - "<quote>" (<mm:ss>)`; no quote is invented when there is no evidence.
export function factLine(fact: DecidedFact): string {
  const item = getIsaaItem(fact.item_id);
  const head = `${fact.item_id}. ${item?.text ?? `Item ${fact.item_id}`}: ${ratingLabel(fact.value)}`;
  const quote = evidenceQuote(fact);
  if (!quote || !fact.evidence) return `${head} (no quote recorded)`;
  return `${head} - "${quote}" (${formatClock(fact.evidence.start_sec)})`;
}

export function buildReportPrompt(input: {
  caseRow: Pick<CaseRow, "child_alias" | "child_age_months" | "parent_alias" | "language" | "therapist_name">;
  sessionNumber: number;
  facts: DecidedFact[];
  briefSummary: string | null;
}): string {
  const { caseRow, sessionNumber, facts, briefSummary } = input;
  const lines = [
    "Case details:",
    `- Child: ${caseRow.child_alias}`,
    `- Age: ${caseRow.child_age_months != null ? `${caseRow.child_age_months} months` : "not recorded"}`,
    `- Parent: ${caseRow.parent_alias}`,
    `- Family language: ${caseRow.language}`,
    `- Therapist: ${caseRow.therapist_name}`,
    `- Session: ${sessionNumber}`,
    "",
    "Confirmed ISAA observations (the therapist confirmed or edited these; use nothing else):",
    ...facts.map(factLine),
  ];
  if (briefSummary && briefSummary.trim()) {
    lines.push("", "Pre-session brief summary (parent-reported, from the intake call):", briefSummary.trim());
  }
  lines.push(
    "",
    "Write the background, observations per domain (cite only the item numbers listed above) and up to 5 recommendations.",
  );
  return lines.join("\n");
}

let cachedSystem: string | null = null;
export function reportSystemPrompt(): string {
  cachedSystem ??= readFileSync(path.join(process.cwd(), "prompts", "report.md"), "utf8");
  return cachedSystem;
}

// ------------------------------------------------------------------------------------------
// Output filter

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const QUOTE_PATTERN = /["“”]([^"“”]+)["“”]/g;
// The server owns every number: model text that talks about scores, totals or bands is not kept.
const SCORE_CLAIM = /\b(isaa|total|totals|score|scores|scored|scoring|band|bands|cut-?off)\b|\/\s*\d+|\bout of \d+/i;

export function quotesIn(text: string): string[] {
  return [...text.matchAll(QUOTE_PATTERN)].map((m) => m[1].trim()).filter(Boolean);
}

function hasUnsupportedQuote(text: string, allowed: string[]): boolean {
  return quotesIn(text).some((q) => {
    const nq = normalize(q);
    return nq === "" || !allowed.some((a) => a.includes(nq));
  });
}

function isSupportedText(text: string, allowed: string[]): boolean {
  return !SCORE_CLAIM.test(text) && !hasUnsupportedQuote(text, allowed);
}

function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+["”]?|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

export type DraftRejections = { observations: number; recommendations: number; background_sentences: number };

export function filterDraft(draft: ReportDraft, facts: DecidedFact[]): { draft: ReportDraft; rejected: DraftRejections } {
  const decided = new Map(facts.map((f) => [f.item_id, f]));
  const allowedQuotes = facts.map(evidenceQuote).filter((q): q is string => q !== null).map(normalize);
  const rejected: DraftRejections = { observations: 0, recommendations: 0, background_sentences: 0 };

  const backgroundKept = sentences(draft.background).filter((s) => {
    const ok = isSupportedText(s, allowedQuotes);
    if (!ok) rejected.background_sentences++;
    return ok;
  });

  const observations = draft.observations.flatMap((obs) => {
    const ids = [...new Set(obs.item_ids)];
    const supported =
      ids.length > 0 &&
      ids.every((id) => decided.has(id) && getIsaaItem(id)?.domain === obs.domain_id) &&
      obs.text.trim() !== "" &&
      isSupportedText(obs.text, allowedQuotes);
    if (!supported) {
      rejected.observations++;
      return [];
    }
    return [{ domain_id: obs.domain_id, text: obs.text.trim(), item_ids: ids.sort((a, b) => a - b) }];
  });

  const recommendations = draft.recommendations
    .map((r) => r.trim())
    .filter((r) => {
      const ok = r !== "" && isSupportedText(r, allowedQuotes);
      if (!ok) rejected.recommendations++;
      return ok;
    })
    .slice(0, 5);

  return { draft: { background: backgroundKept.join(" "), observations, recommendations }, rejected };
}

// ------------------------------------------------------------------------------------------
// Numbers and Markdown

export type ComputedReport = {
  score: IsaaScore;
  redFlags: RedFlag[];
  recommendation: Recommendation;
  content_md: string;
};

export function computeReport(input: {
  caseRow: CaseRow;
  sessionNumber: number;
  date: string;
  facts: DecidedFact[];
  draft: ReportDraft;
}): ComputedReport {
  const { caseRow, sessionNumber, date, facts, draft } = input;
  // Only confirmed/edited facts: unconfirmed ratings never reach totals, domain sums or red flags.
  const scoringFacts = facts.map((f) => ({ item_id: String(f.item_id), value: f.value, status: f.status }));
  const score = scoreIsaa(scoringFacts);
  const redFlags = collectRedFlags({ isaaFacts: scoringFacts });
  const recommendation = recommend({ isaa: score, facpScore: caseRow.facp_score ?? null, redFlags });
  const content_md = composeReportMarkdown({
    caseRow,
    sessionNumber,
    date,
    draft,
    score,
    redFlags,
    recommendation,
    therapist: caseRow.therapist_name,
  });
  return { score, redFlags, recommendation, content_md };
}
