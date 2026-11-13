// Recipient resolution helpers for the topic registry. They run at fan-out time inside the fan-out transaction,
// so access is re-checked when the event is delivered, not when it was produced (FR-2): a guardian whose link
// was revoked, a provider who left the organisation, or a deleted child yields no recipient.
import type { Queryable } from "@/lib/pg";

/** Guardians with an active link to a live child. */
export async function activeGuardians(sql: Queryable, childId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select gl.user_id from public.guardian_links gl
    join public.children c on c.id = gl.child_id
    where gl.child_id = ${childId} and gl.status = 'active' and c.deleted_at is null`;
  return rows.map((r) => r.user_id);
}

/** The subset of `userIds` who can still reach the child: active guardian link, or access to one of the child's
 * cases under 022's rule (`case_access_level`: org owner/admin, or assigned to the case while an active member). */
export async function childAccessFilter(sql: Queryable, childId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<{ id: string }[]>`
    select u.id from unnest(${userIds}::uuid[]) as u(id)
    where exists (select 1 from public.children c where c.id = ${childId} and c.deleted_at is null)
      and (
        exists (select 1 from public.guardian_links gl
                where gl.child_id = ${childId} and gl.user_id = u.id and gl.status = 'active')
        or exists (select 1 from public.cases k
                   where k.child_id = ${childId} and public.case_access_level(u.id, k.id) is not null)
      )`;
  return rows.map((r) => r.id);
}

/** Providers who can access the case under 022's rule (org owners/admins and the assigned care team), only when the
 * case belongs to `childId`. */
export async function caseProviders(sql: Queryable, caseId: string, childId?: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select m.user_id from public.cases k
    join public.org_members m on m.org_id = k.org_id and m.status = 'active'
    join public.user_profiles p on p.id = m.user_id and p.role <> 'guardian'
    where k.id = ${caseId} ${childId ? sql`and k.child_id = ${childId}` : sql``}
      and public.case_access_level(m.user_id, k.id) is not null`;
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

/** 022: owners/admins of the grantee org while the grant is in force (not revoked or expired, live child) and the
 * granting guardian's link is still active. Org and child come from the grant row, never from the payload. */
export async function activeGrantRecipients(sql: Queryable, grantId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select m.user_id from public.sharing_grants g
    join public.children c on c.id = g.child_id and c.deleted_at is null
    join public.guardian_links gl on gl.child_id = g.child_id and gl.user_id = g.granted_by and gl.status = 'active'
    join public.org_members m on m.org_id = g.grantee_org_id and m.status = 'active' and m.org_role in ('owner', 'admin')
    where g.id = ${grantId} and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())`;
  return rows.map((r) => r.user_id);
}

/** 023: active guardians of the child, only while the document is still a `ready`, guardian-visible provider upload
 * of that child. Document and child come from the database; a hidden or deleted document yields nobody. */
export async function visibleDocumentGuardians(sql: Queryable, documentId: string, childId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select gl.user_id from public.documents d
    join public.children c on c.id = d.child_id and c.deleted_at is null
    join public.guardian_links gl on gl.child_id = d.child_id and gl.status = 'active'
    where d.id = ${documentId} and d.child_id = ${childId} and d.status = 'ready'
      and d.uploader_kind = 'provider' and d.visible_to_guardian`;
  return rows.map((r) => r.user_id);
}

/** 041: active platform admins (deletion requests to review). */
export async function platformAdmins(sql: Queryable): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select p.id from public.user_profiles p join auth.users u on u.id = p.id where p.role = 'platform_admin'`;
  return rows.map((r) => r.id);
}

/** 024: the guardian a questionnaire is assigned to, while it is still open, the child is live and their link is
 * active (another guardian of the same child gets nothing). */
export async function assignedAssessmentGuardian(sql: Queryable, assessmentId: string, childId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select a.assigned_to as user_id from public.assessments a
    join public.children c on c.id = a.child_id and c.deleted_at is null
    join public.guardian_links gl on gl.child_id = a.child_id and gl.user_id = a.assigned_to and gl.status = 'active'
    where a.id = ${assessmentId} and a.child_id = ${childId} and a.status in ('assigned', 'in_progress')`;
  return rows.map((r) => r.user_id);
}

/** 030: the booking guardian and the provider bound to the profile, while the appointment is in one of `statuses`
 * (re-read at fan-out: a reminder of a cancelled appointment reaches nobody). `who` narrows to one side. */
export async function appointmentParties(
  sql: Queryable,
  appointmentId: string,
  statuses: string[],
  who: "both" | "guardian" = "both",
): Promise<string[]> {
  const rows = await sql<{ guardian: string | null; provider: string | null }[]>`
    select g.id as guardian, case when ${who} = 'both' then p.user_id end as provider
    from public.appointments a
    join public.provider_profiles p on p.id = a.provider_profile_id
    left join public.user_profiles g on g.id = a.guardian_user_id and g.role = 'guardian'
    where a.id = ${appointmentId} and a.status in ${sql(statuses)}`;
  return rows.flatMap((r) => [r.guardian, r.provider].filter((id): id is string => Boolean(id)));
}
