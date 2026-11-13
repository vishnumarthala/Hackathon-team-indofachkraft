// Ticket 023 FR-4: who may read, change or delete a document. Server only. The rule is defined once in SQL
// (`document_access(user, document)`, supabase/migrations/20261113002300_documents.sql) and every document
// route, page and the `documents` share loader go through it. Missing, malformed, pending, deleted and
// other people's documents all give the same 404; a reader who may not do something gets 403.
import type { User } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/auth";
import { getCaseAccessLevel } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { getActiveGuardianLink } from "@/lib/children";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";
import { DOCUMENT_NOT_FOUND, type DocumentCategory, type DocumentMime } from "./constants";

if (typeof window !== "undefined") {
  throw new Error("lib/documents/access.ts is server-only");
}

export type DocumentStatus = "pending" | "ready" | "deleted";

export type DocumentRow = {
  id: string;
  child_id: string;
  case_id: string | null;
  org_id: string | null;
  uploaded_by: string | null;
  uploader_kind: "guardian" | "provider";
  category: DocumentCategory;
  title: string;
  file_name: string;
  mime_type: DocumentMime;
  size_bytes: number;
  storage_path: string;
  sha256: string | null;
  status: DocumentStatus;
  visible_to_guardian: boolean;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
};

export const DOCUMENT_COLUMNS =
  "id, child_id, case_id, org_id, uploaded_by, uploader_kind, category, title, file_name, mime_type, size_bytes, " +
  "storage_path, sha256, status, visible_to_guardian, created_at, completed_at, deleted_at, deleted_by";

/** `guardian` (linked parent), `case` (provider of the document's case), `org_share` (guardian upload shared
 * with the provider's org), `grant` (022 `documents` sharing grant, read only). */
export type DocumentAccessPath = "guardian" | "case" | "org_share" | "grant";

export type DocumentAccess = {
  path: DocumentAccessPath;
  grant_id?: string;
  can_delete: boolean;
  can_edit: boolean;
  can_share: boolean;
};

export async function getDocumentAccess(userId: string, documentId: string): Promise<DocumentAccess | null> {
  if (!isUuid(documentId)) return null;
  const { data, error } = await supabaseAdmin().rpc("document_access", { p_user: userId, p_doc: documentId });
  if (error) throw new Error(`Could not check document access: ${error.message}`);
  return (data as DocumentAccess | null) ?? null;
}

export async function loadDocument(documentId: string): Promise<DocumentRow | null> {
  if (!isUuid(documentId)) return null;
  const { data, error } = await supabaseAdmin().from("documents").select(DOCUMENT_COLUMNS).eq("id", documentId).maybeSingle();
  if (error) throw new Error(`Could not load document: ${error.message}`);
  return (data as DocumentRow | null) ?? null;
}

export type DocumentGate = { user: User; access: DocumentAccess; document: DocumentRow };

/** Every `/api/documents/:docId` handler calls this first. 401 anonymous, 404 no read access. */
export async function requireDocumentAccess(documentId: string): Promise<DocumentGate | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const access = await getDocumentAccess(user.id, documentId);
  if (!access) return fail(404, DOCUMENT_NOT_FOUND);
  const document = await loadDocument(documentId);
  if (!document || document.status !== "ready") return fail(404, DOCUMENT_NOT_FOUND);
  return { user, access, document };
}

/**
 * FR-3 step 2: only the uploader completes a pending upload, and only while they still have the access they
 * uploaded with (guardian: active link to the child; provider: access to the case). Else 404.
 */
export async function requirePendingUpload(documentId: string): Promise<{ user: User; document: DocumentRow } | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const document = await loadDocument(documentId);
  if (!document || document.status !== "pending" || document.uploaded_by !== user.id) return fail(404, DOCUMENT_NOT_FOUND);
  const allowed =
    document.uploader_kind === "guardian"
      ? (await getActiveGuardianLink(document.child_id, user.id)) !== null
      : (await getCaseAccessLevel(user.id, document.case_id)) !== null;
  return allowed ? { user, document } : fail(404, DOCUMENT_NOT_FOUND);
}
