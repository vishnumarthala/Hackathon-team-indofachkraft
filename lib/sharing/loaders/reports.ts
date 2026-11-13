// Ticket 022 FR-6: the `reports` share scope = finalised assessment reports of the source organisations' cases
// for the child. Drafts, pre-session briefs and parent summaries are never shared.
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import type { ShareContext, ShareLoader, SharedItem, SharedItemDetail } from "@/lib/sharing/registry";

type Row = { id: string; content_md: string; updated_at: string; cases: { org_id: string; child_id: string } };

const COLUMNS = "id, content_md, updated_at, cases!inner(org_id, child_id)";

export function reportTitle(markdown: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return heading ? heading.slice(0, 120) : "Assessment report";
}

function toItem(row: Row): SharedItem {
  return { id: row.id, sourceOrgId: row.cases.org_id, title: reportTitle(row.content_md), date: row.updated_at };
}

function query(ctx: ShareContext) {
  return supabaseAdmin()
    .from("reports")
    .select(COLUMNS)
    .eq("kind", "assessment")
    .eq("status", "final")
    .eq("cases.child_id", ctx.childId)
    .in("cases.org_id", ctx.sourceOrgIds);
}

export const reportsLoader: ShareLoader = {
  async list(ctx) {
    if (ctx.sourceOrgIds.length === 0) return [];
    const { data, error } = await query(ctx).order("updated_at", { ascending: false });
    if (error) throw new Error(`Could not load shared reports: ${error.message}`);
    return ((data ?? []) as unknown as Row[]).map(toItem);
  },
  async get(ctx, itemId): Promise<SharedItemDetail | null> {
    if (ctx.sourceOrgIds.length === 0 || !isUuid(itemId)) return null;
    const { data, error } = await query(ctx).eq("id", itemId).maybeSingle();
    if (error) throw new Error(`Could not load shared report: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as Row;
    return { ...toItem(row), body: { kind: "markdown", markdown: row.content_md } };
  },
};
