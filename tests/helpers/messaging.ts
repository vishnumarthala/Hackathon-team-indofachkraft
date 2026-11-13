// Ticket 027 test helpers: a synthetic messaging world (two organisations treating one child, a linked family,
// an assigned and an unassigned provider) and outbox clean-up. Synthetic data only; removed by world.cleanup().
import type { Sql } from "postgres";
import type { createWorld, TestUser } from "./world";

type World = ReturnType<typeof createWorld>;

export type MessagingWorld = {
  ownerA: TestUser;
  assignedA: TestUser;
  assigned3A: TestUser;
  unassignedA: TestUser;
  ownerB: TestUser;
  guardianA: TestUser;
  guardianA2: TestUser;
  guardianB: TestUser;
  orgA: string;
  orgB: string;
  childId: string;
  caseA: string;
  caseB: string;
  /** A case of org A whose child has no parent account yet. */
  caseNoGuardian: string;
};

/**
 * org A (owner `ownerA`, members `assignedA` + `assigned3A` on the care team of case A, `unassignedA` not on it)
 * and org B (owner `ownerB`) both treat the child of `guardianA` and `guardianA2`; `guardianB` is another family.
 */
export async function buildMessagingWorld(sql: Sql, world: World): Promise<MessagingWorld> {
  const ownerA = await world.user("owner-a", "provider");
  const assignedA = await world.user("assigned-a", "provider");
  const assigned3A = await world.user("assigned3-a", "provider");
  const unassignedA = await world.user("unassigned-a", "provider");
  const ownerB = await world.user("owner-b", "provider");
  const guardianA = await world.user("guardian-a", "guardian");
  const guardianA2 = await world.user("guardian-a2", "guardian");
  const guardianB = await world.user("guardian-b", "guardian");
  const orgA = await world.org(ownerA, "Centre A");
  const orgB = await world.org(ownerB, "Solo B");
  for (const u of [assignedA, assigned3A, unassignedA]) await world.member(orgA, u);
  const a = await world.kase(orgA);
  const b = await world.kase(orgB, { childId: a.childId });
  const lonely = await world.kase(orgA);
  await world.link(a.childId, guardianA, "mother");
  await world.link(a.childId, guardianA2, "father");
  await sql`select public.add_case_assignment(${a.caseId}, ${assignedA.id}, 'member', 'Speech therapist', ${ownerA.id})`;
  await sql`select public.add_case_assignment(${a.caseId}, ${assigned3A.id}, 'member', null, ${ownerA.id})`;
  await sql`update user_profiles set display_name = 'Meera (synthetic)' where id = ${guardianA.id}`;
  await sql`update user_profiles set display_name = 'Dr Rao (synthetic)' where id = ${assignedA.id}`;
  return {
    ownerA,
    assignedA,
    assigned3A,
    unassignedA,
    ownerB,
    guardianA,
    guardianA2,
    guardianB,
    orgA,
    orgB,
    childId: a.childId,
    caseA: a.caseId,
    caseB: b.caseId,
    caseNoGuardian: lonely.caseId,
  };
}

/** Outbox events of the threads of these cases (notifications cascade). Run before world.cleanup(). */
export async function purgeThreadEvents(sql: Sql, caseIds: string[]) {
  if (caseIds.length === 0) return;
  await sql`
    delete from outbox_events
    where aggregate_type = 'thread' and aggregate_id in (select id from message_threads where case_id in ${sql(caseIds)})`;
}

/** A provider upload (023) of the case, `ready`, with or without guardian visibility. Rows only (no object). */
export async function providerDocument(sql: Sql, opts: { childId: string; caseId: string; orgId: string; userId: string; visible: boolean; title: string }) {
  const [row] = await sql<{ id: string }[]>`
    insert into documents (child_id, case_id, org_id, uploaded_by, uploader_kind, category, title, file_name, mime_type,
                           size_bytes, storage_path, status, visible_to_guardian, completed_at)
    values (${opts.childId}, ${opts.caseId}, ${opts.orgId}, ${opts.userId}, 'provider', 'other', ${opts.title}, 'note.pdf',
            'application/pdf', 100, ${`${opts.childId}/${crypto.randomUUID()}.pdf`}, 'ready', ${opts.visible}, now())
    returning id`;
  return row.id;
}

/** A guardian upload (023), `ready`, optionally shared with an organisation. Rows only (no object). */
export async function familyDocument(sql: Sql, opts: { childId: string; userId: string; title: string; shareWithOrg?: string }) {
  const [row] = await sql<{ id: string }[]>`
    insert into documents (child_id, uploaded_by, uploader_kind, category, title, file_name, mime_type, size_bytes,
                           storage_path, status, visible_to_guardian, completed_at)
    values (${opts.childId}, ${opts.userId}, 'guardian', 'school', ${opts.title}, 'letter.pdf', 'application/pdf', 100,
            ${`${opts.childId}/${crypto.randomUUID()}.pdf`}, 'ready', true, now())
    returning id`;
  if (opts.shareWithOrg) {
    await sql`insert into document_org_shares (document_id, org_id, shared_by) values (${row.id}, ${opts.shareWithOrg}, ${opts.userId})`;
  }
  return row.id;
}
