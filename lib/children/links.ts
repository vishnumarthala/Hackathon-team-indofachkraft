// 041 FR-2: guardian link changes are security-critical. The link update and its audit row are one transaction
// (`auditStrict`): if the audit row cannot be written nothing changes and the route answers 503.
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { pg } from "@/lib/pg";

/** 020 FR-16: the guardian stops being linked to the child. False when there was no active link. */
export async function leaveChild(childId: string, userId: string, actor: SessionAuditActor): Promise<boolean> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update public.guardian_links set status = 'revoked', revoked_at = now(), revoked_by = ${userId}
      where child_id = ${childId} and user_id = ${userId} and status = 'active'
      returning id`;
    if (rows.length === 0) return false;
    await auditStrict(
      { ...actor, childId, action: "guardian.left_child", entity: "child", entityId: childId, details: { link_id: rows[0].id } },
      tx,
    );
    return true;
  });
}

/** 020 FR-16: a platform admin revokes a guardian link (e.g. a court order). Null when no active link has the id. */
export async function adminRevokeGuardianLink(linkId: string, actor: SessionAuditActor): Promise<{ id: string; child_id: string } | null> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; child_id: string }[]>`
      update public.guardian_links set status = 'revoked', revoked_at = now(), revoked_by = ${actor.actorUserId}
      where id = ${linkId} and status = 'active'
      returning id, child_id`;
    if (!row) return null;
    await auditStrict(
      {
        ...actor,
        childId: row.child_id,
        action: "guardian.link_revoked",
        entity: "guardian_link",
        entityId: row.id,
        details: { child_id: row.child_id },
      },
      tx,
    );
    return row;
  });
}
