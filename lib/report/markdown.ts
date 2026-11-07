// FR-4: the assessment report Markdown. Every number comes from the server-side score object
// (lib/scoring.ts); the model only supplies background, observation text and recommendations.
import { formatIsaaScore, type IsaaScore, type RedFlag, type Recommendation } from "@/lib/scoring";
import { ISAA } from "@/lib/isaa";
import type { CaseRow, ReportDraft } from "@/lib/types";

export const RED_FLAG_LABELS: Record<RedFlag["type"], string> = {
  lost_speech: "Lost speech",
  self_injury: "Self-injury",
};

export const PROVISIONAL_DOMAIN_NOTE =
  "Domain scores are sums of confirmed items only; they are not domain totals.";
export const NO_OBSERVATIONS = "No observations could be supported by confirmed items.";

export function reportFooter(therapist: string): string {
  return `AI-drafted from confirmed observations. Reviewed and decided by ${therapist}. This is not a diagnosis by AI.`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export type ComposeReportInput = {
  caseRow: Pick<CaseRow, "child_alias">;
  sessionNumber: number;
  date: string; // YYYY-MM-DD
  draft: ReportDraft;
  score: IsaaScore;
  redFlags: RedFlag[];
  recommendation: Pick<Recommendation, "action">;
  therapist: string;
};

export function composeReportMarkdown({
  caseRow,
  sessionNumber,
  date,
  draft,
  score,
  redFlags,
  recommendation,
  therapist,
}: ComposeReportInput): string {
  const lines: string[] = [
    `# Assessment report - ${caseRow.child_alias}`,
    "",
    `Session ${sessionNumber} · ${date} · ${therapist}`,
    "",
    "## Background",
    "",
    draft.background.trim(),
    "",
    "## ISAA result",
    "",
    formatIsaaScore(score),
    "",
  ];
  if (score.total === null) lines.push(PROVISIONAL_DOMAIN_NOTE, "");
  lines.push("| Domain | Score | Max |", "| --- | --- | --- |");
  for (const d of score.by_domain) lines.push(`| ${cell(d.name)} | ${d.score} | ${d.max} |`);

  lines.push("", "## Observations", "");
  let observed = 0;
  for (const domain of ISAA.domains) {
    const obs = draft.observations.filter((o) => o.domain_id === domain.id && o.text.trim() !== "");
    if (obs.length === 0) continue;
    observed++;
    const ids = [...new Set(obs.flatMap((o) => o.item_ids))].sort((a, b) => a - b);
    const text = obs.map((o) => o.text.trim()).join(" ");
    lines.push(`### ${domain.name}`, "", ids.length ? `${text} (items ${ids.join(", ")})` : text, "");
  }
  if (observed === 0) lines.push(NO_OBSERVATIONS, "");

  lines.push("## Red flags", "");
  if (redFlags.length === 0) lines.push("- None");
  for (const flag of redFlags) lines.push(`- ${RED_FLAG_LABELS[flag.type]}`);

  lines.push("", "## Suggested next steps", "", `- ${recommendation.action}`);
  for (const rec of draft.recommendations) {
    if (rec.trim()) lines.push(`- ${rec.trim()}`);
  }

  lines.push("", reportFooter(therapist));
  return lines.join("\n") + "\n";
}
