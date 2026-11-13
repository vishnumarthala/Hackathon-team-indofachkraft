// Ticket 027 FR-2/FR-3/FR-6: thread and message reads and writes. Server only. Every write is one database
// function (message + outbox event + strict audit in one transaction); callers have passed lib/messaging/access.ts.
// Message bodies are never logged (NFR-3): errors carry the Postgres error code only.
import { auditWouldFail } from "@/lib/audit";
import { getDocumentAccess, loadDocument } from "@/lib/documents/access";
import { logger } from "@/lib/log";
import { supabaseAdmin } from "@/lib/db";
import type { Result } from "@/lib/orgs";
import type { ProviderType } from "@/lib/providers/constants";
import { DELETE_WINDOW_MINUTES, DELETED_BODY, MESSAGING_ERRORS } from "./constants";
import type { ThreadRow } from "./access";
import type { MessageDocument, MessageView, ThreadJson, ThreadListItem } from "./types";
import type { MessageCreateInput, ThreadCreateInput } from "./schemas";

export type { MessageDocument, MessageView, ThreadJson, ThreadListItem } from "./types";

if (typeof window !== "undefined") {
  throw new Error("lib/messaging/store.ts is server-only");
}

type MessageRow = {
  id: string;
  thread_id: string;
  sender_id: string | null;
  sender_kind: "guardian" | "provider";
  sender_name: string | null;
  discipline_label: string | null;
  provider_type: ProviderType | null;
  body: string;
  document_id: string | null;
  created_at: string;
  deleted_at: string | null;
};

const log = logger("messaging");

function failed(op: string, error: { code?: string } | null): { ok: false; status: number; error: string } {
  log.error(`${op} failed`, { code: error?.code ?? "error" });
  return { ok: false, status: 503, error: MESSAGING_ERRORS.saveFailed };
}

export function threadJson(row: ThreadRow | ThreadJson): ThreadJson {
  return {
    id: row.id,
    subject: row.subject,
    case_id: row.case_id,
    org_id: row.org_id,
    child_id: row.child_id,
    created_at: row.created_at,
    last_message_at: row.last_message_at,
    archived_at: row.archived_at,
  };
}

/** FR-2 `GET /api/threads`: threads the user can access, optionally of one case or one child. */
export async function listThreads(userId: string, filter: { caseId?: string; childId?: string } = {}): Promise<ThreadListItem[]> {
  const { data, error } = await supabaseAdmin().rpc("list_message_threads", {
    p_user: userId,
    p_case: filter.caseId ?? null,
    p_child: filter.childId ?? null,
  });
  if (error) throw new Error(`Could not load conversations: ${error.code ?? "error"}`);
  return ((data ?? []) as ThreadListItem[]).map((r) => ({ ...r, unread: Number(r.unread) || 0 }));
}

async function documentViews(viewerId: string, ids: string[]): Promise<Map<string, MessageDocument>> {
  const out = new Map<string, MessageDocument>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const access = await getDocumentAccess(viewerId, id);
      const doc = access ? await loadDocument(id) : null;
      out.set(
        id,
        doc && doc.status === "ready"
          ? { id, available: true, title: doc.title, file_name: doc.file_name, mime_type: doc.mime_type, url: `/api/documents/${id}/download` }
          : { id, available: false },
      );
    }),
  );
  return out;
}

async function toViews(rows: MessageRow[], thread: Pick<ThreadRow, "archived_at">, viewerId: string): Promise<MessageView[]> {
  const docs = await documentViews(viewerId, rows.flatMap((r) => (r.document_id && !r.deleted_at ? [r.document_id] : [])));
  const deleteAfter = Date.now() - DELETE_WINDOW_MINUTES * 60_000;
  return rows.map((r) => {
    const deleted = r.deleted_at !== null;
    const own = r.sender_id === viewerId;
    return {
      id: r.id,
      thread_id: r.thread_id,
      sender_id: r.sender_id,
      sender_kind: r.sender_kind,
      sender_name: r.sender_name,
      discipline_label: r.discipline_label,
      provider_type: r.provider_type,
      body: deleted ? DELETED_BODY : r.body,
      deleted,
      created_at: r.created_at,
      own,
      can_delete: own && !deleted && !thread.archived_at && new Date(r.created_at).getTime() > deleteAfter,
      document: r.document_id && !deleted ? (docs.get(r.document_id) ?? null) : null,
    };
  });
}

async function messageRows(threadId: string, opts: { before?: string | null; limit: number; messageId?: string }): Promise<MessageRow[]> {
  const { data, error } = await supabaseAdmin().rpc("thread_messages", {
    p_thread: threadId,
    p_before: opts.before ?? null,
    p_limit: opts.limit,
    p_message: opts.messageId ?? null,
  });
  if (error) throw new Error(`Could not load messages: ${error.code ?? "error"}`);
  return (data ?? []) as MessageRow[];
}

/** FR-2 `GET /api/threads/:id/messages`: the newest `limit` messages before `before`, oldest -> newest. */
export async function listMessages(
  thread: ThreadRow,
  viewerId: string,
  opts: { before?: string | null; limit: number },
): Promise<{ messages: MessageView[]; has_more: boolean }> {
  const rows = await messageRows(thread.id, { before: opts.before, limit: opts.limit + 1 });
  const has_more = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).reverse();
  return { messages: await toViews(page, thread, viewerId), has_more };
}

export async function getMessageView(thread: ThreadRow, viewerId: string, messageId: string): Promise<MessageView | null> {
  const [row] = await messageRows(thread.id, { limit: 1, messageId });
  return row ? ((await toViews([row], thread, viewerId))[0] ?? null) : null;
}

const WRITE_ERRORS: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: MESSAGING_ERRORS.threadNotFound },
  no_guardian: { status: 422, error: MESSAGING_ERRORS.noGuardian },
  rate_limited: { status: 429, error: MESSAGING_ERRORS.tooFast },
  archived: { status: 409, error: MESSAGING_ERRORS.archived },
  document_not_attachable: { status: 422, error: MESSAGING_ERRORS.documentNotAttachable },
  client_id_conflict: { status: 409, error: MESSAGING_ERRORS.clientIdConflict },
  forbidden: { status: 403, error: MESSAGING_ERRORS.notOwn },
  too_late: { status: 409, error: MESSAGING_ERRORS.tooLate },
};

type WriteResult = { result: string; thread?: ThreadRow; message?: { id: string; thread_id: string } };

/** FR-2 `POST /api/threads`. `created: false` = the same `client_id` was sent before (idempotent replay). */
export async function createThread(
  userId: string,
  input: ThreadCreateInput,
): Promise<Result<{ thread: ThreadJson; message: MessageView; created: boolean }>> {
  // 041 E-2 dev/test hook: behave as if the audit row (written by the database function) could not be saved.
  if (auditWouldFail("thread.created")) return failed("create thread", { code: "audit_hook" });
  const { data, error } = await supabaseAdmin().rpc("create_message_thread", {
    p_case: input.case_id,
    p_user: userId,
    p_subject: input.subject,
    p_body: input.body,
    p_client_id: input.client_id,
    p_document: input.document_id,
  });
  if (error) return failed("create thread", error);
  const out = data as WriteResult;
  if (out.result === "not_found") return { ok: false, status: 404, error: MESSAGING_ERRORS.caseNotFound };
  if (out.result !== "created" && out.result !== "existing") return { ok: false, ...(WRITE_ERRORS[out.result] ?? WRITE_ERRORS.not_found) };
  const thread = out.thread as ThreadRow;
  const message = await getMessageView(thread, userId, (out.message as { id: string }).id);
  if (!message) return failed("create thread", null);
  return { ok: true, data: { thread: threadJson(thread), message, created: out.result === "created" } };
}

/** FR-2 `POST /api/threads/:id/messages`. */
export async function sendMessage(
  thread: ThreadRow,
  userId: string,
  input: MessageCreateInput,
): Promise<Result<{ message: MessageView; created: boolean }>> {
  // 041 E-2 dev/test hook: behave as if the audit row (written by the database function) could not be saved.
  if (auditWouldFail("message.sent")) return failed("send message", { code: "audit_hook" });
  const { data, error } = await supabaseAdmin().rpc("send_thread_message", {
    p_thread: thread.id,
    p_user: userId,
    p_body: input.body,
    p_client_id: input.client_id,
    p_document: input.document_id,
  });
  if (error) return failed("send message", error);
  const out = data as WriteResult;
  if (out.result !== "created" && out.result !== "existing") return { ok: false, ...(WRITE_ERRORS[out.result] ?? WRITE_ERRORS.not_found) };
  const message = await getMessageView(thread, userId, (out.message as { id: string }).id);
  if (!message) return failed("send message", null);
  return { ok: true, data: { message, created: out.result === "created" } };
}

/** FR-2 `DELETE /api/messages/:id`: own message within 15 minutes; the body is replaced for everyone. */
export async function deleteMessage(thread: ThreadRow, messageId: string, userId: string): Promise<Result<{ message: MessageView }>> {
  // 041 E-2 dev/test hook: behave as if the audit row (written by the database function) could not be saved.
  if (auditWouldFail("message.deleted")) return failed("delete message", { code: "audit_hook" });
  const { data, error } = await supabaseAdmin().rpc("delete_thread_message", { p_message: messageId, p_user: userId });
  if (error) return failed("delete message", error);
  const out = data as WriteResult;
  if (out.result === "not_found") return { ok: false, status: 404, error: MESSAGING_ERRORS.messageNotFound };
  if (out.result !== "deleted") return { ok: false, ...(WRITE_ERRORS[out.result] ?? WRITE_ERRORS.not_found) };
  const message = await getMessageView(thread, userId, messageId);
  if (!message) return { ok: false, status: 404, error: MESSAGING_ERRORS.messageNotFound };
  return { ok: true, data: { message } };
}

/** FR-2 `POST /api/threads/:id/read`: moves the user's read marker to now (never backwards). */
export async function markThreadRead(threadId: string, userId: string): Promise<Result<{ last_read_at: string }>> {
  const { data, error } = await supabaseAdmin().rpc("mark_thread_read", { p_thread: threadId, p_user: userId });
  if (error) return failed("mark read", error);
  const out = data as { result: string; last_read_at?: string };
  if (out.result !== "read") return { ok: false, status: 404, error: MESSAGING_ERRORS.threadNotFound };
  return { ok: true, data: { last_read_at: out.last_read_at as string } };
}

/** FR-6 `POST /api/threads/:id/archive`: owners/admins of the case's org; archived threads are read-only. */
export async function archiveThread(threadId: string, userId: string): Promise<Result<{ thread: ThreadJson }>> {
  // 041 E-2 dev/test hook: behave as if the audit row (written by the database function) could not be saved.
  if (auditWouldFail("thread.archived")) return failed("archive thread", { code: "audit_hook" });
  const { data, error } = await supabaseAdmin().rpc("archive_message_thread", { p_thread: threadId, p_user: userId });
  if (error) return failed("archive thread", error);
  const out = data as WriteResult;
  if (out.result === "forbidden") return { ok: false, status: 403, error: MESSAGING_ERRORS.archiveForbidden };
  if (out.result !== "archived") return { ok: false, status: 404, error: MESSAGING_ERRORS.threadNotFound };
  return { ok: true, data: { thread: threadJson(out.thread as ThreadRow) } };
}

/** Documents of the thread's child the viewer can read, with whether every participant could read them too. */
export async function attachableDocuments(
  caseId: string,
  docs: { id: string; title: string }[],
): Promise<{ id: string; title: string; attachable: boolean }[]> {
  const admin = supabaseAdmin();
  return Promise.all(
    docs.map(async (d) => {
      const { data, error } = await admin.rpc("case_document_attachable", { p_case: caseId, p_doc: d.id });
      if (error) throw new Error(`Could not check document: ${error.code ?? "error"}`);
      return { id: d.id, title: d.title, attachable: data === true };
    }),
  );
}

/** Organisation and child names for a thread header (the caller has passed the thread gate). */
export async function threadContext(thread: Pick<ThreadRow, "org_id" | "child_id">): Promise<{ orgName: string; childName: string }> {
  const admin = supabaseAdmin();
  const [org, child] = await Promise.all([
    admin.from("organizations").select("name").eq("id", thread.org_id).maybeSingle(),
    admin.from("children").select("display_name").eq("id", thread.child_id).maybeSingle(),
  ]);
  if (org.error || child.error) throw new Error("Could not load conversation details");
  return {
    orgName: (org.data as { name: string } | null)?.name ?? "",
    childName: (child.data as { display_name: string } | null)?.display_name ?? "",
  };
}

export type CaseOption = { id: string; child_id: string; org_id: string; org_name: string; created_at: string };

/** FR-4: the cases (one per treating organisation episode) a guardian can write about, per child. */
export async function listCasesForChildren(childIds: string[]): Promise<CaseOption[]> {
  if (childIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("cases")
    .select("id, child_id, org_id, created_at, organizations(name)")
    .in("child_id", childIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load care teams: ${error.code ?? "error"}`);
  type Row = { id: string; child_id: string; org_id: string; created_at: string; organizations: { name: string } | { name: string }[] | null };
  return ((data ?? []) as Row[]).map((r) => {
    const org = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
    return { id: r.id, child_id: r.child_id, org_id: r.org_id, org_name: org?.name ?? "", created_at: r.created_at };
  });
}

/** FR-2: a case can have threads only once a parent account is linked to its child. */
export async function caseHasGuardian(caseId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().from("cases").select("child_id").eq("id", caseId).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.code ?? "error"}`);
  const childId = (data as { child_id: string | null } | null)?.child_id;
  if (!childId) return false;
  const links = await supabaseAdmin()
    .from("guardian_links")
    .select("id", { count: "exact", head: true })
    .eq("child_id", childId)
    .eq("status", "active");
  if (links.error) throw new Error(`Could not load guardian links: ${links.error.code ?? "error"}`);
  return (links.count ?? 0) > 0;
}
