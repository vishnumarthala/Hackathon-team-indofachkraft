// Ticket 023: document vault operations (upload, complete, download, delete, visibility, guardian shares, lists).
// Server only. Callers have passed the access gates (requireChildGuardian / requireCaseActor /
// requireDocumentAccess / requirePendingUpload); every multi-step write is one database function with its
// audit row (strict: an audit failure saves nothing -> 503).
import { createHash, randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/db";
import { drainSoon } from "@/lib/notify/outbox";
import type { Result } from "@/lib/orgs";
import { orgNames } from "@/lib/sharing/shared";
import { DOCUMENT_COLUMNS, type DocumentAccess, type DocumentRow } from "./access";
import {
  checkFile,
  DOCUMENTS_BUCKET,
  DOCUMENT_NOT_FOUND,
  DOWNLOAD_URL_TTL_SEC,
  MAX_DOCUMENT_BYTES,
  NOT_TREATING,
  NOT_UPLOADED,
  OPEN_FAILED,
  SAVE_FAILED,
  STORED_EXTENSION,
  TOO_LARGE,
  TYPE_MISMATCH,
  type DocumentMime,
} from "./constants";
import { SNIFF_BYTES, sniffDocumentType } from "./magic";
import type { GuardianUploadInput, ProviderUploadInput } from "./schemas";

if (typeof window !== "undefined") {
  throw new Error("lib/documents/store.ts is server-only");
}

export type UploadTicket = { document_id: string; signed_upload_url: string; token: string; path: string };

type CreateInput =
  | { kind: "guardian"; childId: string; userId: string; input: GuardianUploadInput }
  | { kind: "provider"; childId: string; caseId: string; orgId: string; userId: string; input: ProviderUploadInput };

const CREATE_ERRORS: Record<string, { status: number; error: string }> = {
  child_not_found: { status: 404, error: "Child not found" },
  case_not_found: { status: 404, error: "Case not found" },
  no_case: { status: 422, error: NOT_TREATING },
};

export function storagePath(childId: string, documentId: string, mime: DocumentMime): string {
  return `${childId}/${documentId}.${STORED_EXTENSION[mime]}`;
}

/** FR-3 step 1: validates the file (415/413), creates the `pending` row and a signed upload URL. */
export async function createUpload(args: CreateInput): Promise<Result<UploadTicket>> {
  const { input } = args;
  const bad = checkFile({ fileName: input.file_name, mimeType: input.mime_type, sizeBytes: input.size_bytes });
  if (bad) return { ok: false, ...bad };
  const mime = input.mime_type as DocumentMime;
  const id = randomUUID();
  const path = storagePath(args.childId, id, mime);
  const db = supabaseAdmin();

  const { error } = await db.rpc("create_document", {
    p: {
      id,
      child_id: args.childId,
      uploaded_by: args.userId,
      uploader_kind: args.kind,
      category: input.category,
      title: input.title,
      file_name: input.file_name,
      mime_type: mime,
      size_bytes: input.size_bytes,
      storage_path: path,
      ...(args.kind === "guardian"
        ? { share_with_org_ids: args.input.share_with_org_ids }
        : { case_id: args.caseId, org_id: args.orgId, visible_to_guardian: args.input.visible_to_guardian }),
    },
  });
  if (error) {
    const code = /documents:([a-z_]+)/.exec(error.message)?.[1];
    if (code && CREATE_ERRORS[code]) return { ok: false, ...CREATE_ERRORS[code] };
    console.error(`create_document failed: ${error.message}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }

  const signed = await db.storage.from(DOCUMENTS_BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) {
    console.error(`document upload URL failed: ${signed.error?.message ?? "no data"}`);
    await db.rpc("reject_document", { p_doc: id, p_user: args.userId, p_reason: "upload_url_failed" });
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
  return { ok: true, data: { document_id: id, signed_upload_url: signed.data.signedUrl, token: signed.data.token, path } };
}

async function removeObject(path: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(DOCUMENTS_BUCKET).remove([path]);
  if (error) console.error(`document object cleanup failed: ${error.message}`);
}

async function reject(document: DocumentRow, userId: string, reason: string): Promise<void> {
  const { error } = await supabaseAdmin().rpc("reject_document", { p_doc: document.id, p_user: userId, p_reason: reason });
  if (error) console.error(`reject_document failed: ${error.message}`);
  await removeObject(document.storage_path);
}

/**
 * FR-3 step 2 / FR-2: the object must exist, be at most 20 MB and its first bytes must match the declared type;
 * else the document is `deleted` and the object removed. Computes the sha256 and sets `ready`.
 */
export async function completeUpload(document: DocumentRow, userId: string): Promise<Result<DocumentRow>> {
  const { data: blob, error } = await supabaseAdmin().storage.from(DOCUMENTS_BUCKET).download(document.storage_path);
  if (error || !blob) return { ok: false, status: 409, error: NOT_UPLOADED };
  if (blob.size > MAX_DOCUMENT_BYTES) {
    await reject(document, userId, "too_large");
    return { ok: false, status: 413, error: TOO_LARGE };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0 || sniffDocumentType(bytes.subarray(0, SNIFF_BYTES)) !== document.mime_type) {
    await reject(document, userId, "type_mismatch");
    return { ok: false, status: 422, error: TYPE_MISMATCH };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const done = await supabaseAdmin().rpc("complete_document", {
    p_doc: document.id,
    p_user: userId,
    p_size: bytes.length,
    p_sha256: sha256,
  });
  if (done.error) {
    console.error(`complete_document failed: ${done.error.message}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
  if (!done.data) return { ok: false, status: 404, error: DOCUMENT_NOT_FOUND };
  const { outbox_event_id, ...row } = done.data as DocumentRow & { outbox_event_id: number | string | null };
  deliver(outbox_event_id);
  return { ok: true, data: row as DocumentRow };
}

// FR-9: `document.shared_with_guardian` was enqueued by the database function in the same transaction as the
// change (ids only); deliver it right after the response. The cron picks it up if this does not run.
function deliver(eventId: number | string | null | undefined): void {
  if (eventId !== null && eventId !== undefined) drainSoon([String(eventId)]);
}

/**
 * FR-5 (D-4): records `document.downloaded` (re-checking access in the same database call), then mints a 300 s
 * signed URL that downloads as the original file name. No audit row -> no URL. The URL is never logged.
 */
export async function downloadUrl(documentId: string, userId: string): Promise<Result<string>> {
  const db = supabaseAdmin();
  const logged = await db.rpc("log_document_download", { p_doc: documentId, p_user: userId });
  if (logged.error) {
    console.error(`log_document_download failed: ${logged.error.message}`);
    return { ok: false, status: 503, error: OPEN_FAILED };
  }
  if (!logged.data) return { ok: false, status: 404, error: DOCUMENT_NOT_FOUND };
  const { storage_path, file_name } = logged.data as { storage_path: string; file_name: string };
  const signed = await db.storage.from(DOCUMENTS_BUCKET).createSignedUrl(storage_path, DOWNLOAD_URL_TTL_SEC, { download: file_name });
  if (signed.error || !signed.data?.signedUrl) {
    console.error(`document signed URL failed for ${documentId}`);
    return { ok: false, status: 503, error: OPEN_FAILED };
  }
  return { ok: true, data: signed.data.signedUrl };
}

/** FR-6: soft delete (re-checked under a row lock) + `document.deleted`; the object is removed immediately. */
export async function deleteDocument(documentId: string, userId: string): Promise<Result<null>> {
  const { data, error } = await supabaseAdmin().rpc("delete_document", { p_doc: documentId, p_user: userId });
  if (error) {
    console.error(`delete_document failed: ${error.message}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
  const outcome = data as { result: "deleted" | "not_found" | "forbidden"; storage_path?: string };
  if (outcome.result === "not_found") return { ok: false, status: 404, error: DOCUMENT_NOT_FOUND };
  if (outcome.result === "forbidden") return { ok: false, status: 403, error: "You cannot delete this document" };
  if (outcome.storage_path) await removeObject(outcome.storage_path);
  return { ok: true, data: null };
}

/** E-2: a provider of the document's case changes whether the parent sees it. */
export async function setVisibility(documentId: string, userId: string, visible: boolean): Promise<Result<DocumentRow>> {
  const { data, error } = await supabaseAdmin().rpc("set_document_visibility", { p_doc: documentId, p_user: userId, p_visible: visible });
  if (error) {
    console.error(`set_document_visibility failed: ${error.message}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
  const outcome = data as {
    result: "updated" | "not_found" | "forbidden";
    changed?: boolean;
    document?: DocumentRow;
    outbox_event_id?: number | string | null;
  };
  if (outcome.result === "not_found" || !outcome.document) {
    return outcome.result === "forbidden"
      ? { ok: false, status: 403, error: "Only the case's providers can change this" }
      : { ok: false, status: 404, error: DOCUMENT_NOT_FOUND };
  }
  deliver(outcome.outbox_event_id);
  return { ok: true, data: outcome.document };
}

/** FR-7: a linked guardian shares one of the family's uploads with a treating organisation, or stops it. */
export async function shareDocument(documentId: string, orgId: string, userId: string): Promise<Result<null>> {
  const { data, error } = await supabaseAdmin().rpc("share_document", { p_doc: documentId, p_org: orgId, p_user: userId });
  if (error) {
    console.error(`share_document failed: ${error.message}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
  const result = (data as { result: string }).result;
  if (result === "shared" || result === "unchanged") return { ok: true, data: null };
  if (result === "no_case") return { ok: false, status: 422, error: NOT_TREATING };
  if (result === "forbidden") return { ok: false, status: 403, error: "Only documents your family uploaded can be shared" };
  return { ok: false, status: 404, error: DOCUMENT_NOT_FOUND };
}

export async function unshareDocument(documentId: string, orgId: string, userId: string): Promise<Result<null>> {
  const { data, error } = await supabaseAdmin().rpc("unshare_document", { p_doc: documentId, p_org: orgId, p_user: userId });
  if (error) {
    console.error(`unshare_document failed: ${error.message}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
  const result = (data as { result: string }).result;
  if (result === "revoked") return { ok: true, data: null };
  if (result === "forbidden") return { ok: false, status: 403, error: "Only documents your family uploaded can be shared" };
  return { ok: false, status: 404, error: "Sharing not found" };
}

// ---------- reads ----------

/** What the API returns about a document. `case_id` only to providers of that case; never the storage path. */
export function documentJson(row: DocumentRow, access: DocumentAccess | null, userId: string, sharedWithOrgIds?: string[]) {
  return {
    id: row.id,
    child_id: row.child_id,
    case_id: access?.path === "case" ? row.case_id : null,
    org_id: row.org_id,
    uploader_kind: row.uploader_kind,
    uploaded_by_me: row.uploaded_by === userId,
    category: row.category,
    title: row.title,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status,
    visible_to_guardian: row.visible_to_guardian,
    created_at: row.created_at,
    ...(access ? { access: access.path, can_delete: access.can_delete, can_edit: access.can_edit, can_share: access.can_share } : {}),
    ...(sharedWithOrgIds ? { shared_with_org_ids: sharedWithOrgIds } : {}),
  };
}

export type ListedDocument = DocumentRow & { org_name: string | null; uploader_name: string | null; shared_with_org_ids: string[] };

async function uploaderNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin().from("user_profiles").select("id, display_name").in("id", ids);
  if (error) throw new Error(`Could not load uploader names: ${error.message}`);
  return new Map(((data ?? []) as { id: string; display_name: string | null }[]).filter((p) => p.display_name).map((p) => [p.id, p.display_name as string]));
}

/** Active shares of guardian uploads, counting only shares by guardians still linked to the child. */
export async function activeShareOrgIds(rows: DocumentRow[]): Promise<Map<string, string[]>> {
  const guardianDocs = rows.filter((r) => r.uploader_kind === "guardian");
  if (guardianDocs.length === 0) return new Map();
  const db = supabaseAdmin();
  const [shares, links] = await Promise.all([
    db.from("document_org_shares").select("document_id, org_id, shared_by").in("document_id", guardianDocs.map((r) => r.id)).is("revoked_at", null),
    db.from("guardian_links").select("child_id, user_id").in("child_id", [...new Set(guardianDocs.map((r) => r.child_id))]).eq("status", "active"),
  ]);
  if (shares.error) throw new Error(`Could not load document shares: ${shares.error.message}`);
  if (links.error) throw new Error(`Could not load guardian links: ${links.error.message}`);
  const linked = new Set(((links.data ?? []) as { child_id: string; user_id: string }[]).map((l) => `${l.child_id}:${l.user_id}`));
  const childOf = new Map(guardianDocs.map((r) => [r.id, r.child_id]));
  const out = new Map<string, string[]>();
  for (const s of (shares.data ?? []) as { document_id: string; org_id: string; shared_by: string | null }[]) {
    if (!s.shared_by || !linked.has(`${childOf.get(s.document_id)}:${s.shared_by}`)) continue;
    out.set(s.document_id, [...(out.get(s.document_id) ?? []), s.org_id]);
  }
  return out;
}

async function decorate(rows: DocumentRow[]): Promise<ListedDocument[]> {
  const [names, people, shares] = await Promise.all([
    orgNames([...new Set(rows.map((r) => r.org_id).filter((id): id is string => id !== null))]),
    uploaderNames([...new Set(rows.map((r) => r.uploaded_by).filter((id): id is string => id !== null))]),
    activeShareOrgIds(rows),
  ]);
  return rows.map((r) => ({
    ...r,
    org_name: r.org_id ? (names.get(r.org_id) ?? null) : null,
    uploader_name: r.uploaded_by ? (people.get(r.uploaded_by) ?? null) : null,
    shared_with_org_ids: shares.get(r.id) ?? [],
  }));
}

/** FR-7: a guardian's view of a child's documents (ready only; provider uploads only when visible). */
export async function listGuardianDocuments(childIds: string[]): Promise<ListedDocument[]> {
  if (childIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .in("child_id", childIds)
    .eq("status", "ready")
    .or("uploader_kind.eq.guardian,visible_to_guardian.eq.true")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load documents: ${error.message}`);
  return decorate((data ?? []) as unknown as DocumentRow[]);
}

/** FR-8: the case's own documents and guardian uploads shared with the case's organisation. */
export async function listCaseDocuments(caseId: string): Promise<ListedDocument[]> {
  const { data, error } = await supabaseAdmin().rpc("case_documents", { p_case: caseId });
  if (error) throw new Error(`Could not load case documents: ${error.message}`);
  return decorate((data ?? []) as DocumentRow[]);
}

/** Organisations treating the child (a case exists), for the guardian's `Share with` choices. */
export async function listTreatingOrgs(childId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabaseAdmin().from("cases").select("org_id").eq("child_id", childId);
  if (error) throw new Error(`Could not load treating organisations: ${error.message}`);
  const ids = [...new Set(((data ?? []) as { org_id: string }[]).map((c) => c.org_id))];
  const names = await orgNames(ids);
  return ids.map((id) => ({ id, name: names.get(id) ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
}
