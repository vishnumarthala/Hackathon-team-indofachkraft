// Ticket 022 FR-6, 024 FR-10: the `reports` share scope = the current published version (published_versions,
// entity_type 'report') of each finalised assessment report of the source organisations' cases for the child.
// Drafts, pre-session briefs and parent summaries are never shared. Item id = report id (stable across versions).
import { isUuid } from "@/lib/cases/validation";
import { db } from "@/lib/facts";
import type { ShareContext, ShareLoader, SharedItem, SharedItemDetail } from "@/lib/sharing/registry";

type Row = { id: string; org_id: string; content_md: string; published_at: Date | string };

export function reportTitle(markdown: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return heading ? heading.slice(0, 120) : "Assessment report";
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

function toItem(row: Row): SharedItem {
  return { id: row.id, sourceOrgId: row.org_id, title: reportTitle(row.content_md), date: iso(row.published_at) };
}

// Latest version per report, filtered in SQL by child + source orgs, live final assessment reports only.
async function load(ctx: ShareContext, itemId?: string): Promise<Row[]> {
  const sql = await db();
  return sql<Row[]>`
    select distinct on (pv.entity_id) pv.entity_id as id, pv.org_id, pv.content_md, pv.published_at
    from published_versions pv
    join reports r on r.id = pv.entity_id and r.kind = 'assessment' and r.status = 'final'
    join cases c on c.id = r.case_id and c.child_id = ${ctx.childId} and c.org_id = any(${ctx.sourceOrgIds}::uuid[])
    where pv.entity_type = 'report'
      and pv.child_id = ${ctx.childId}
      and pv.org_id = any(${ctx.sourceOrgIds}::uuid[])
      ${itemId ? sql`and pv.entity_id = ${itemId}` : sql``}
    order by pv.entity_id, pv.version desc`;
}

export const reportsLoader: ShareLoader = {
  async list(ctx) {
    if (ctx.sourceOrgIds.length === 0) return [];
    const rows = await load(ctx);
    return rows.map(toItem).sort((a, b) => b.date.localeCompare(a.date));
  },
  async get(ctx, itemId): Promise<SharedItemDetail | null> {
    if (ctx.sourceOrgIds.length === 0 || !isUuid(itemId)) return null;
    const [row] = await load(ctx, itemId);
    if (!row) return null;
    return { ...toItem(row), body: { kind: "markdown", markdown: row.content_md } };
  },
};
