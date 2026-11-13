// Ticket 027 FR-1/FR-2: who may read and write a message thread. Server only. The rule is defined once in SQL
// (`thread_access_level(user, thread)`, supabase/migrations/20261113002700_messaging.sql) and used by every
// messaging route, page, the list functions and RLS/Realtime (`can_access_thread`). Missing, malformed and
// other people's threads all give the same 404.
import { notFound } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getAuthenticatedUser, getUserRole, type UserRole } from "@/lib/auth";
import { getCaseAccessLevel, requireGuardianPage, requireProviderPage } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { getActiveGuardianLink } from "@/lib/children";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";
import { MESSAGING_ERRORS } from "./constants";

if (typeof window !== "undefined") {
  throw new Error("lib/messaging/access.ts is server-only");
}

/** `guardian` = active guardian of the thread's child; `manage` / `assigned` = 022 case access to its case. */
export type ThreadAccessLevel = "guardian" | "manage" | "assigned";

export type ThreadRow = {
  id: string;
  case_id: string;
  org_id: string;
  child_id: string;
  subject: string;
  created_by: string | null;
  created_at: string;
  last_message_at: string;
  archived_at: string | null;
  archived_by: string | null;
};

export const THREAD_COLUMNS = "id, case_id, org_id, child_id, subject, created_by, created_at, last_message_at, archived_at, archived_by";

export async function getThreadAccessLevel(userId: string, threadId: string): Promise<ThreadAccessLevel | null> {
  if (!isUuid(threadId)) return null;
  const { data, error } = await supabaseAdmin().rpc("thread_access_level", { p_user: userId, p_thread: threadId });
  if (error) throw new Error(`Could not check conversation access: ${error.code ?? "error"}`);
  return (data as ThreadAccessLevel | null) ?? null;
}

export async function loadThread(threadId: string): Promise<ThreadRow | null> {
  if (!isUuid(threadId)) return null;
  const { data, error } = await supabaseAdmin().from("message_threads").select(THREAD_COLUMNS).eq("id", threadId).maybeSingle();
  if (error) throw new Error(`Could not load conversation: ${error.code ?? "error"}`);
  return (data as ThreadRow | null) ?? null;
}

export type ThreadGate = { user: User; role: UserRole; level: ThreadAccessLevel; thread: ThreadRow };

/** Every `/api/threads/:id/**` handler calls this first. 401 anonymous, 404 no access (re-checked per request). */
export async function requireThreadAccess(threadId: string): Promise<ThreadGate | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const level = await getThreadAccessLevel(user.id, threadId);
  if (!level) return fail(404, MESSAGING_ERRORS.threadNotFound);
  const thread = await loadThread(threadId);
  if (!thread) return fail(404, MESSAGING_ERRORS.threadNotFound);
  return { user, role: await getUserRole(user.id), level, thread };
}

/** `DELETE /api/messages/:id`: the message's thread must be reachable (the database function re-checks). */
export async function requireMessageAccess(messageId: string): Promise<(ThreadGate & { messageId: string }) | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  if (!isUuid(messageId)) return fail(404, MESSAGING_ERRORS.messageNotFound);
  const { data, error } = await supabaseAdmin().from("messages").select("thread_id").eq("id", messageId).maybeSingle();
  if (error) throw new Error(`Could not load message: ${error.code ?? "error"}`);
  const threadId = (data as { thread_id: string } | null)?.thread_id;
  const level = threadId ? await getThreadAccessLevel(user.id, threadId) : null;
  const thread = threadId && level ? await loadThread(threadId) : null;
  if (!level || !thread) return fail(404, MESSAGING_ERRORS.messageNotFound);
  return { user, role: await getUserRole(user.id), level, thread, messageId };
}

export type MessagingUser = { user: User; role: UserRole };

/** `/api/threads` (list/create): any signed-in user; resources are checked per case/child below. */
export async function requireMessagingUser(): Promise<MessagingUser | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  return { user, role: await getUserRole(user.id) };
}

/** A guardian may message about a case of a child they are actively linked to; a provider needs 022 case access. */
export async function canUseCase(who: MessagingUser, caseId: string): Promise<boolean> {
  if (!isUuid(caseId)) return false;
  if (who.role !== "guardian") return (await getCaseAccessLevel(who.user.id, caseId)) !== null;
  const { data, error } = await supabaseAdmin().from("cases").select("child_id").eq("id", caseId).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.code ?? "error"}`);
  const childId = (data as { child_id: string | null } | null)?.child_id;
  return childId ? (await getActiveGuardianLink(childId, who.user.id)) !== null : false;
}

/** Pages: guardians open threads of their children under `/family`, providers threads of their cases elsewhere. */
export async function requireThreadPage(threadId: string, area: "family" | "provider"): Promise<Omit<ThreadGate, "role">> {
  const { user } = area === "family" ? await requireGuardianPage() : await requireProviderPage();
  const level = await getThreadAccessLevel(user.id, threadId);
  if (!level || (area === "family") !== (level === "guardian")) notFound();
  const thread = await loadThread(threadId);
  if (!thread) notFound();
  return { user, level, thread };
}
