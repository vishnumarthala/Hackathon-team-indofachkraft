// Recipient resolution helpers for the topic registry. They run at fan-out time inside the fan-out transaction,
// so access is re-checked when the event is delivered, not when it was produced (FR-2): a guardian whose link
// was revoked, a provider who left the organisation, or a deleted child yields no recipient.
// 022 (care team) may narrow provider access to case assignments; change `childAccessFilter` / `caseProviders`.
import type { Queryable } from "@/lib/pg";

/** Guardians with an active link to a live child. */
export async function activeGuardians(sql: Queryable, childId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select gl.user_id from public.guardian_links gl
    join public.children c on c.id = gl.child_id
    where gl.child_id = ${childId} and gl.status = 'active' and c.deleted_at is null`;
  return rows.map((r) => r.user_id);
}

/** The subset of `userIds` who can still reach the child: active guardian link, or active member of an org that
 * holds a case for the child. */
export async function childAccessFilter(sql: Queryable, childId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<{ id: string }[]>`
    select u.id from unnest(${userIds}::uuid[]) as u(id)
    where exists (select 1 from public.children c where c.id = ${childId} and c.deleted_at is null)
      and (
        exists (select 1 from public.guardian_links gl
                where gl.child_id = ${childId} and gl.user_id = u.id and gl.status = 'active')
        or exists (select 1 from public.cases k join public.org_members m on m.org_id = k.org_id
                   where k.child_id = ${childId} and m.user_id = u.id and m.status = 'active')
      )`;
  return rows.map((r) => r.id);
}

/** Active members of the organisation that owns the case (only when the case belongs to `childId`). */
export async function caseProviders(sql: Queryable, caseId: string, childId?: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select m.user_id from public.cases k
    join public.org_members m on m.org_id = k.org_id and m.status = 'active'
    join public.user_profiles p on p.id = m.user_id and p.role <> 'guardian'
    where k.id = ${caseId} ${childId ? sql`and k.child_id = ${childId}` : sql``}`;
  return rows.map((r) => r.user_id);
}

/** Active organisation members, optionally only some org roles (e.g. owners/admins). */
export async function orgMembers(sql: Queryable, orgId: string, roles?: string[]): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select user_id from public.org_members
    where org_id = ${orgId} and status = 'active' ${roles?.length ? sql`and org_role in ${sql(roles)}` : sql``}`;
  return rows.map((r) => r.user_id);
}

/** The provider bound to a profile (028), if any. */
export async function profileOwner(sql: Queryable, profileId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select user_id from public.provider_profiles where id = ${profileId} and user_id is not null`;
  return rows.map((r) => r.user_id);
}

/** The user, if the account still exists. */
export async function existingUser(sql: Queryable, userId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`select id from auth.users where id = ${userId}`;
  return rows.map((r) => r.id);
}
