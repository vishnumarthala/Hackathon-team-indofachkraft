// Ticket 025 FR-8: the `iep` share scope = the latest PUBLISHED version of each IEP plan of the source
// organisations' cases for the child, followed by a live progress table per published goal (D-3: values and dates
// only, no provider notes). Draft wording never leaves: goal statements come from the publication snapshot.
// Item id = plan id.
import { listSharedPlans, type PublishedPlanView } from "@/lib/iep";
import { escapeMarkdown, formatMeasureValue } from "@/lib/iep/markdown";
import type { ShareLoader, SharedItem, SharedItemDetail } from "@/lib/sharing/registry";

function toItem(plan: PublishedPlanView): SharedItem {
  return { id: plan.plan_id, sourceOrgId: plan.org_id, title: plan.title, date: plan.published_at };
}

/** Published plan markdown + `## Progress` (one table per goal, live values). */
export function sharedPlanMarkdown(plan: PublishedPlanView): string {
  const lines = [plan.content_md.trimEnd(), "", "## Progress", ""];
  plan.goals.forEach((goal, i) => {
    lines.push(`### Goal ${i + 1}: ${escapeMarkdown(goal.statement)}`, "");
    if (goal.points.length === 0) {
      lines.push("No progress recorded yet.", "");
      return;
    }
    lines.push("| Date | Value |", "| --- | --- |");
    for (const p of goal.points) lines.push(`| ${p.observed_on} | ${formatMeasureValue(goal.measure_type, p.value)} |`);
    lines.push("");
  });
  return lines.join("\n").trimEnd() + "\n";
}

export const iepLoader: ShareLoader = {
  async list(ctx) {
    return (await listSharedPlans(ctx.childId, ctx.sourceOrgIds)).map(toItem);
  },
  async get(ctx, itemId): Promise<SharedItemDetail | null> {
    const [plan] = await listSharedPlans(ctx.childId, ctx.sourceOrgIds, itemId);
    if (!plan) return null;
    return { ...toItem(plan), body: { kind: "markdown", markdown: sharedPlanMarkdown(plan) } };
  },
};
