// Ticket 026 FR-7: the `home_program` share scope = the CURRENT published home program of each of the source
// organisations' cases for the child (latest published version, activities stopped since left out), followed by an
// adherence table (last 7 days and the last 4 Monday-start weeks in the guardian's time zone). Draft activities and
// guardian notes never leave. Item id = program id.
import { listSharedPrograms, type SharedProgramView } from "@/lib/home-program";
import { escapeMarkdown } from "@/lib/iep/markdown";
import type { ShareLoader, SharedItem, SharedItemDetail } from "@/lib/sharing/registry";

function toItem(program: SharedProgramView): SharedItem {
  return { id: program.program_id, sourceOrgId: program.org_id, title: program.title, date: program.published_at };
}

/** Published program markdown + `## Adherence` (done of expected, last 7 days and per week). */
export function sharedProgramMarkdown(program: SharedProgramView): string {
  const lines = [program.content_md.trimEnd(), "", "## Adherence", "", `Weeks start on Monday (${program.time_zone}).`, ""];
  if (program.activities.length === 0) lines.push("No activities in this program right now.", "");
  else {
    const weeks = program.activities[0].weeks.map((w) => `Week of ${w.week_start}`);
    lines.push(`| Activity | Last 7 days | ${weeks.join(" | ")} |`, `| --- | --- | ${weeks.map(() => "---").join(" | ")} |`);
    for (const a of program.activities) {
      const cells = a.weeks.map((w) => `${w.done} of ${w.expected}`);
      lines.push(`| ${escapeMarkdown(a.title)} | ${a.last_7_days.done} of ${a.last_7_days.expected} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export const homeProgramLoader: ShareLoader = {
  async list(ctx) {
    return (await listSharedPrograms(ctx.childId, ctx.sourceOrgIds)).map(toItem);
  },
  async get(ctx, itemId): Promise<SharedItemDetail | null> {
    const [program] = await listSharedPrograms(ctx.childId, ctx.sourceOrgIds, itemId);
    if (!program) return null;
    return { ...toItem(program), body: { kind: "markdown", markdown: sharedProgramMarkdown(program) } };
  },
};
