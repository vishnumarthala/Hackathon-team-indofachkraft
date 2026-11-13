// Ticket 026 FR-3: renders a home program to the markdown that is published (published_versions.content_md). Pure.
// English chrome around the provider's own words (titles and instructions are shown as written, NFR-3). Program
// status is not part of the document, so a re-render of an unchanged published program gives the same hash
// (used for `Unpublished changes`). Only ACTIVE activities are published; linked goals use their PUBLISHED wording
// (025 iep_publications), never live goal drafts.
import { escapeMarkdown } from "@/lib/iep/markdown";

export type MarkdownProgram = { title: string };
export type MarkdownActivity = {
  title: string;
  instructions_md: string;
  frequency_per_week: number;
  duration_min: number;
  materials: string | null;
  /** Published wording of the linked goal, or null (no goal, or the goal is not published yet). */
  goal_statement: string | null;
  has_guide: boolean;
};

/** Provider markdown kept as a block: headings are flattened so they cannot change the document structure. */
export function instructionsBlock(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/^\s{0,3}(=+|-{3,})\s*$/, ""))
    .join("\n")
    .trim();
}

const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);
const minutes = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);

export function homeProgramMarkdown(program: MarkdownProgram, activities: MarkdownActivity[]): string {
  const lines = [`# ${escapeMarkdown(program.title)}`, ""];
  if (activities.length === 0) lines.push("No activities yet.", "");
  activities.forEach((a, i) => {
    lines.push(`## ${i + 1}. ${escapeMarkdown(a.title)}`, "");
    if (a.goal_statement) lines.push(`- **Linked goal:** ${escapeMarkdown(a.goal_statement)}`);
    lines.push(`- **How often:** ${times(a.frequency_per_week)} a week, ${minutes(a.duration_min)} each time`);
    if (a.materials) lines.push(`- **Materials:** ${escapeMarkdown(a.materials)}`);
    if (a.has_guide) lines.push("- **Guide:** a picture or PDF guide is attached");
    lines.push("", "**How to do it**", "", instructionsBlock(a.instructions_md), "");
  });
  return lines.join("\n").trimEnd() + "\n";
}
