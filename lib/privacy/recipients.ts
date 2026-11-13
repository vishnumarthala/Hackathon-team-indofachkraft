// 041: outbox recipients for privacy notifications, re-checked at fan-out (032 FR-2).
import type { Queryable } from "@/lib/pg";

/** The guardian who requested a ready export, while still actively linked to the live child. */
export async function exportRequester(sql: Queryable, exportId: string, childId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select e.requested_by as user_id from public.privacy_exports e
    join public.children c on c.id = e.child_id and c.deleted_at is null
    join public.guardian_links gl on gl.child_id = e.child_id and gl.user_id = e.requested_by and gl.status = 'active'
    where e.id = ${exportId} and e.child_id = ${childId} and e.status = 'ready'`;
  return rows.map((r) => r.user_id);
}

/** The guardian who made a deletion request, once it reached `status` (account must still exist). */
export async function deletionRequester(sql: Queryable, requestId: string, status: "completed" | "rejected"): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select r.requested_by as user_id from public.deletion_requests r
    join auth.users u on u.id = r.requested_by
    where r.id = ${requestId} and r.status = ${status}`;
  return rows.map((r) => r.user_id);
}
