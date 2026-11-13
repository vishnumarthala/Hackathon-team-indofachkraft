// Ticket 023: server-side mapping of listed documents to the props of <DocumentList>. Safe anywhere (pure).
import type { TFunction } from "@/lib/i18n/keys";
import type { ListedDocument } from "@/lib/documents/store";
import type { DocumentView } from "./DocumentList";

/** Guardian view (FR-7): `You` / `Your family` for family uploads, the organisation for provider uploads. */
export function guardianDocumentView(row: ListedDocument, userId: string, t: TFunction<"documents">): DocumentView {
  const family = row.uploader_kind === "guardian";
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    category: row.category,
    createdAt: row.created_at,
    uploadedBy: family ? (row.uploaded_by === userId ? t("byYou") : t("byFamily")) : (row.org_name ?? ""),
    canDelete: family && row.uploaded_by === userId,
    canShare: family,
    canEdit: false,
    visibleToGuardian: row.visible_to_guardian,
    sharedWithOrgIds: row.shared_with_org_ids,
  };
}

/**
 * Provider view of the case `Documents` tab (FR-8). Mirrors SQL `document_access` for the `case` path: the
 * uploader or an owner/admin (`manage`) deletes, any provider of the case switches parent visibility.
 * Family uploads shared with the org are read only.
 */
export function caseDocumentView(row: ListedDocument, userId: string, manage: boolean, t: TFunction<"documents">): DocumentView {
  const provider = row.uploader_kind === "provider";
  return {
    id: row.id,
    childId: row.child_id,
    title: row.title,
    category: row.category,
    createdAt: row.created_at,
    uploadedBy: provider ? (row.uploader_name ?? row.org_name ?? "") : t("byParent"),
    canDelete: provider && (row.uploaded_by === userId || manage),
    canShare: false,
    canEdit: provider,
    visibleToGuardian: row.visible_to_guardian,
    sharedWithOrgIds: [],
  };
}
