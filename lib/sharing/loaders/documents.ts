// Ticket 023 FR-4: the `documents` share scope = `ready` documents that providers of the source organisations
// uploaded to their cases for the child (read only). Guardian uploads are never shared by a grant: guardians
// share those one by one with `document_org_shares`. Pending and deleted documents are never shared.
// The file is opened through GET /api/documents/:id/download, which re-checks access (`document_access`),
// writes the strict `document.downloaded` audit row and only then redirects to a 300 s signed URL.
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import type { ShareContext, ShareLoader, SharedItem, SharedItemDetail } from "@/lib/sharing/registry";

type Row = { id: string; org_id: string; title: string; file_name: string; mime_type: string; created_at: string };

const COLUMNS = "id, org_id, title, file_name, mime_type, created_at";

function toItem(row: Row): SharedItem {
  return { id: row.id, sourceOrgId: row.org_id, title: row.title, date: row.created_at };
}

function query(ctx: ShareContext) {
  return supabaseAdmin()
    .from("documents")
    .select(COLUMNS)
    .eq("child_id", ctx.childId)
    .in("org_id", ctx.sourceOrgIds)
    .eq("uploader_kind", "provider")
    .eq("status", "ready");
}

export const documentsLoader: ShareLoader = {
  async list(ctx) {
    if (ctx.sourceOrgIds.length === 0) return [];
    const { data, error } = await query(ctx).order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load shared documents: ${error.message}`);
    return ((data ?? []) as Row[]).map(toItem);
  },
  async get(ctx, itemId): Promise<SharedItemDetail | null> {
    if (ctx.sourceOrgIds.length === 0 || !isUuid(itemId)) return null;
    const { data, error } = await query(ctx).eq("id", itemId).maybeSingle();
    if (error) throw new Error(`Could not load shared document: ${error.message}`);
    if (!data) return null;
    const row = data as Row;
    return {
      ...toItem(row),
      body: { kind: "file", url: `/api/documents/${row.id}/download`, fileName: row.file_name, mimeType: row.mime_type },
    };
  },
};
