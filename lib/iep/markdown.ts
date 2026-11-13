// Ticket 025 FR-4: renders a plan to the markdown that is published (published_versions.content_md). Pure.
// The published document is English chrome around the provider's own words (goal text is shown as written).
// Plan status is deliberately not part of the document, so publishing a draft and re-rendering the now active
// plan gives the same markdown (used to detect `Unpublished changes`).
import { formatDate } from "@/lib/i18n/format";
import { DOMAIN_LABELS_EN, GOAL_DOMAINS, type GoalDomain, type GoalStatus, type MeasureType } from "@/lib/iep/schema";

const TZ = "Asia/Kolkata";

export type MarkdownPlan = { title: string; start_date: string; review_date: string };
export type MarkdownGoal = {
  domain: GoalDomain;
  statement: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  time_bound: string;
  measure_type: MeasureType;
  baseline_value: number;
  target_value: number;
  target_date: string;
  status: GoalStatus;
  sort: number;
};

export const MEASURE_LABELS_EN: Record<MeasureType, string> = {
  percent: "Percentage of opportunities",
  count: "Count",
  rating_1_5: "Rating from 1 to 5",
  yes_no: "Yes or no",
};

/** A value as plain English text for the measure (`40%`, `3`, `2 of 5`, `Yes`). */
export function formatMeasureValue(measure: MeasureType, value: number): string {
  const n = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  switch (measure) {
    case "percent":
      return `${n}%`;
    case "rating_1_5":
      return `${n} of 5`;
    case "yes_no":
      return value >= 1 ? "Yes" : "No";
    case "count":
      return n;
  }
}

const day = (isoDate: string) => formatDate(`${isoDate}T12:00:00+05:30`, "en", "long", TZ);

/** Keeps provider text on one line and stops it from changing the document structure. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<>#|~])/g, "\\$1");
}

/** Goals in published order: by domain (registry order), then `sort`. Stable for equal keys. */
export function orderGoals<T extends Pick<MarkdownGoal, "domain" | "sort">>(goals: T[]): T[] {
  return goals
    .map((g, i) => ({ g, i }))
    .sort((a, b) => GOAL_DOMAINS.indexOf(a.g.domain) - GOAL_DOMAINS.indexOf(b.g.domain) || a.g.sort - b.g.sort || a.i - b.i)
    .map(({ g }) => g);
}

export function iepPlanMarkdown(plan: MarkdownPlan, goals: MarkdownGoal[]): string {
  const lines = [
    `# ${escapeMarkdown(plan.title)}`,
    "",
    `Plan dates: ${day(plan.start_date)} to ${day(plan.review_date)} (review date).`,
    "",
  ];
  const ordered = orderGoals(goals);
  if (ordered.length === 0) lines.push("No goals yet.", "");
  let n = 0;
  for (const domain of GOAL_DOMAINS) {
    const inDomain = ordered.filter((g) => g.domain === domain);
    if (inDomain.length === 0) continue;
    lines.push(`## ${DOMAIN_LABELS_EN[domain]}`, "");
    for (const g of inDomain) {
      n += 1;
      lines.push(`### Goal ${n}: ${escapeMarkdown(g.statement)}`, "");
      if (g.status !== "active") lines.push(`Status: ${g.status === "achieved" ? "Achieved" : "Discontinued"}`, "");
      lines.push(
        `- **Specific:** ${escapeMarkdown(g.specific)}`,
        `- **Measurable:** ${escapeMarkdown(g.measurable)}`,
        `- **Achievable:** ${escapeMarkdown(g.achievable)}`,
        `- **Relevant:** ${escapeMarkdown(g.relevant)}`,
        `- **Time-bound:** ${escapeMarkdown(g.time_bound)}`,
        `- **How we measure:** ${MEASURE_LABELS_EN[g.measure_type]}`,
        `- **Baseline to target:** ${formatMeasureValue(g.measure_type, g.baseline_value)} to ${formatMeasureValue(
          g.measure_type,
          g.target_value,
        )} by ${day(g.target_date)}`,
        "",
      );
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
