// Ticket 024 FR-10: the `assessments` share scope = the current published summary (published_versions,
// entity_type 'assessment') of each reviewed questionnaire of the source organisations' cases for the child.
// Open, submitted-but-unreviewed and cancelled questionnaires are never shared; neither are raw answers or the
// reviewer's internal note. Item id = assessment id.
import { isUuid } from "@/lib/cases/validation";
import { db } from "@/lib/facts";
import type { ShareContext, ShareLoader, SharedItem, SharedItemDetail } from "@/lib/sharing/registry";

type Row = { id: string; org_id: string; title: string; content_md: string; published_at: Date | string };

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

function toItem(row: Row): SharedItem {
  return { id: row.id, sourceOrgId: row.org_id, title: row.title, date: iso(row.published_at) };
}

async function load(ctx: ShareContext, itemId?: string): Promise<Row[]> {
  const sql = await db();
  return sql<Row[]>`
    select distinct on (pv.entity_id) pv.entity_id as id, pv.org_id, t.title, pv.content_md, pv.published_at
    from published_versions pv
    join assessments a on a.id = pv.entity_id and a.status = 'reviewed'
    join assessment_templates t on t.id = a.template_id
    join cases c on c.id = a.case_id and c.child_id = ${ctx.childId} and c.org_id = any(${ctx.sourceOrgIds}::uuid[])
    where pv.entity_type = 'assessment'
      and pv.child_id = ${ctx.childId}
      and pv.org_id = any(${ctx.sourceOrgIds}::uuid[])
      ${itemId ? sql`and pv.entity_id = ${itemId}` : sql``}
    order by pv.entity_id, pv.version desc`;
}

export const assessmentsLoader: ShareLoader = {
  async list(ctx) {
    if (ctx.sourceOrgIds.length === 0) return [];
    return (await load(ctx)).map(toItem).sort((a, b) => b.date.localeCompare(a.date));
  },
  async get(ctx, itemId): Promise<SharedItemDetail | null> {
    if (ctx.sourceOrgIds.length === 0 || !isUuid(itemId)) return null;
    const [row] = await load(ctx, itemId);
    if (!row) return null;
    return { ...toItem(row), body: { kind: "markdown", markdown: row.content_md } };
  },
};
