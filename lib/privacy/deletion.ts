// 041 FR-8: deletion requests. Guardian requests (strict audit) -> platform admin approves or rejects with a note
// (strict audit; rejection must cite the legal record-keeping obligation, D-5) -> the job `executeDeletion` erases
// the child's data across every organisation, registry category by category:
//   1. processors  - external copies (ElevenLabs conversations) are logged in `processor_deletions` and deleted;
//                    failures are recorded and retried by later runs (the local erasure does not wait for them);
//   2. storage     - objects of every category are removed (before their rows, 023 hand-off);
//   3. database    - one transaction: category `rows()` deleters, consent withdrawal (append), token/link revocation,
//                    cases deleted (cascade), child pseudonymised ('Deleted child'), consent log and audit trail
//                    stripped of free text (both retained: legal obligation), `privacy.deletion_completed` audit.
// Every step is recorded in `deletion_requests.steps`, so a re-run skips finished steps (NFR-1, idempotent and
// resumable); a completed request is never claimed again. The guardian is notified once everything, including the
// processor deletions, is done.
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { deleteConversation, type ConversationDeleter } from "@/lib/elevenlabs/conversations";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon, enqueue } from "@/lib/notify/outbox";
import { pg, type Sql } from "@/lib/pg";
import { categoriesForScope, type DeletionScope, type ErasureContext } from "./registry";
import { removeObjects, type ObjectRemover } from "./retention";

const log = logger("privacy.deletion");

export const DELETION_SCOPES = ["all_ai_processing", "everything"] as const;
export const OPEN_REQUEST = "A deletion request for this child is already open";
export const DELETED_CHILD_NAME = "Deleted child";
export const PROCESSOR_MAX_ATTEMPTS = 10;
/** Consent features that send data to an AI processor (withdrawn by `all_ai_processing`). */
export const AI_FEATURES = ["ai_intake_call", "session_recording", "ai_transcription", "ai_extraction", "ai_voice_note", "ai_follow_up"];

export type DeletionStatus = "requested" | "approved" | "rejected" | "in_progress" | "completed" | "failed";
export type DeletionRequestRow = {
  id: string;
  child_id: string;
  requested_by: string;
  scope: DeletionScope;
  reason: string | null;
  status: DeletionStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  steps: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  completed_at: Date | null;
  created_at: Date;
};

const COLUMNS = (sql: Sql) =>
  sql`id, child_id, requested_by, scope, reason, status, reviewed_by, reviewed_at, review_note, steps, attempts, last_error,
      completed_at, created_at`;

export type CreateResult = { ok: true; request: DeletionRequestRow } | { ok: false; status: 409; error: string };

/** FR-8: guardian request (201). One open request per child (409). Strict audit + admin notification in one transaction. */
export async function createDeletionRequest(
  input: { childId: string; guardianUserId: string; scope: DeletionScope; reason?: string | null },
  actor: SessionAuditActor,
  sql?: Sql,
): Promise<CreateResult> {
  const db = sql ?? (await pg());
  try {
    const result = await db.begin(async (tx) => {
      await tx`select id from public.children where id = ${input.childId} for update`;
      const [open] = await tx`
        select 1 from public.deletion_requests
        where child_id = ${input.childId} and status in ('requested', 'approved', 'in_progress', 'failed')`;
      if (open) return null;
      const [row] = await tx<DeletionRequestRow[]>`
        insert into public.deletion_requests (child_id, requested_by, scope, reason)
        values (${input.childId}, ${input.guardianUserId}, ${input.scope}, ${input.reason?.trim() || null})
        returning ${COLUMNS(tx as unknown as Sql)}`;
      await auditStrict(
        {
          ...actor,
          childId: input.childId,
          action: "privacy.deletion_requested",
          entity: "deletion_request",
          entityId: row.id,
          details: { scope: input.scope },
        },
        tx,
      );
      const eventId = await enqueue(tx, {
        topic: "privacy.deletion_requested",
        aggregateType: "deletion_request",
        aggregateId: row.id,
        payload: { request_id: row.id, child_id: input.childId },
        dedupKey: `privacy.deletion_requested:${row.id}`,
      });
      return { row, eventId };
    });
    if (!result) return { ok: false, status: 409, error: OPEN_REQUEST };
    drainSoon([result.eventId]);
    return { ok: true, request: result.row };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, status: 409, error: OPEN_REQUEST };
    throw err;
  }
}

export async function listChildDeletionRequests(childId: string, sql?: Sql): Promise<DeletionRequestRow[]> {
  const db = sql ?? (await pg());
  return db<DeletionRequestRow[]>`
    select ${COLUMNS(db)} from public.deletion_requests where child_id = ${childId} order by created_at desc limit 10`;
}

export type AdminRequestRow = DeletionRequestRow & { child_name: string; processors_failed: number };

export async function listDeletionRequestsForAdmin(sql?: Sql): Promise<AdminRequestRow[]> {
  const db = sql ?? (await pg());
  return db<AdminRequestRow[]>`
    select r.id, r.child_id, r.requested_by, r.scope, r.reason, r.status, r.reviewed_by, r.reviewed_at, r.review_note,
           r.steps, r.attempts, r.last_error, r.completed_at, r.created_at, c.display_name as child_name,
           (select count(*)::int from public.processor_deletions p where p.request_id = r.id and p.status in ('pending', 'failed'))
             as processors_failed
    from public.deletion_requests r join public.children c on c.id = r.child_id
    order by (r.status = 'requested') desc, r.created_at desc limit 100`;
}

export type ReviewResult =
  | { ok: true; request: DeletionRequestRow }
  | { ok: false; status: 404 | 409; error: string };

/** FR-8 / D-5: platform admin decision. Only `requested` requests can be reviewed. Strict audit. */
export async function reviewDeletionRequest(
  requestId: string,
  decision: "approve" | "reject",
  note: string | null,
  actor: SessionAuditActor,
  sql?: Sql,
): Promise<ReviewResult> {
  const db = sql ?? (await pg());
  const result = await db.begin(async (tx) => {
    const [row] = await tx<DeletionRequestRow[]>`
      select ${COLUMNS(tx as unknown as Sql)} from public.deletion_requests where id = ${requestId} for update`;
    if (!row) return { ok: false, status: 404, error: "Request not found" } as const;
    if (row.status !== "requested") return { ok: false, status: 409, error: "This request was already reviewed" } as const;
    const status = decision === "approve" ? "approved" : "rejected";
    const [updated] = await tx<DeletionRequestRow[]>`
      update public.deletion_requests
      set status = ${status}, reviewed_by = ${actor.actorUserId}, reviewed_at = now(), review_note = ${note?.trim() || null}
      where id = ${requestId}
      returning ${COLUMNS(tx as unknown as Sql)}`;
    await auditStrict(
      {
        ...actor,
        childId: row.child_id,
        action: "privacy.deletion_reviewed",
        entity: "deletion_request",
        entityId: requestId,
        details: { decision: status, scope: row.scope },
      },
      tx,
    );
    let eventId: string | null = null;
    if (status === "rejected") {
      eventId = await enqueue(tx, {
        topic: "privacy.deletion_rejected",
        aggregateType: "deletion_request",
        aggregateId: requestId,
        payload: { request_id: requestId, child_id: row.child_id },
        dedupKey: `privacy.deletion_rejected:${requestId}`,
      });
    }
    return { ok: true, request: updated, eventId } as const;
  });
  if (!result.ok) return result;
  if (result.eventId) drainSoon([result.eventId]);
  return { ok: true, request: result.request };
}

export type DeletionDeps = { deleteConversation?: ConversationDeleter; remove?: ObjectRemover };

type Claimed = { id: string; child_id: string; requested_by: string; reviewed_by: string | null; scope: DeletionScope; steps: Record<string, unknown> };

async function markStep(db: Sql, id: string, step: string) {
  await db`update public.deletion_requests set steps = steps || ${db.json({ [step]: new Date().toISOString() })} where id = ${id}`;
}

async function contextFor(db: Sql, req: Claimed): Promise<ErasureContext> {
  const cases = await db<{ id: string }[]>`select id from public.cases where child_id = ${req.child_id}`;
  return { childId: req.child_id, requestId: req.id, scope: req.scope, requestedBy: req.requested_by, caseIds: cases.map((c) => c.id) };
}

/** Step 1: register processor copies (idempotent), then try every pending/failed one. Returns the number still failing. */
async function processorStep(db: Sql, req: Claimed, ctx: ErasureContext, deleter: ConversationDeleter): Promise<number> {
  if (!req.steps.processors_registered) {
    for (const category of categoriesForScope(req.scope)) {
      for (const ref of (await category.erase?.externalRefs?.(db, ctx)) ?? []) {
        await db`
          insert into public.processor_deletions (request_id, processor, external_ref)
          values (${req.id}, ${ref.processor}, ${ref.ref}) on conflict do nothing`;
      }
    }
    // Gemini has no deletion API (paid tier: no retention for training); recorded as not applicable.
    await db`
      insert into public.processor_deletions (request_id, processor, external_ref, status, attempted_at)
      values (${req.id}, 'gemini', 'no-deletion-api', 'not_applicable', now()) on conflict do nothing`;
    await markStep(db, req.id, "processors_registered");
  }
  return retryProcessorDeletions(db, req.id, deleter);
}

/** Calls the processor for every pending/failed row of the request; each external ref is deleted at most once. */
export async function retryProcessorDeletions(db: Sql, requestId: string, deleter: ConversationDeleter = deleteConversation): Promise<number> {
  const due = await db<{ id: string; processor: string; external_ref: string }[]>`
    select id, processor, external_ref from public.processor_deletions
    where request_id = ${requestId} and status in ('pending', 'failed') and attempts < ${PROCESSOR_MAX_ATTEMPTS}
    order by created_at`;
  let failing = 0;
  for (const row of due) {
    if (row.processor !== "elevenlabs") continue;
    const outcome = await deleter(row.external_ref);
    await db`
      update public.processor_deletions
      set status = ${outcome.status}, response_code = ${outcome.responseCode}, attempts = attempts + 1, attempted_at = now()
      where id = ${row.id}`;
    if (outcome.status === "failed") failing += 1;
  }
  const [left] = await db<{ n: number }[]>`
    select count(*)::int as n from public.processor_deletions where request_id = ${requestId} and status in ('pending', 'failed')`;
  if (failing > 0) log.warn("processor deletions failing", { request_id: requestId, failing });
  return left.n;
}

/** Step 2: storage objects of every category in scope (missing objects are fine). */
async function storageStep(db: Sql, req: Claimed, ctx: ErasureContext, remove: ObjectRemover) {
  if (req.steps.storage) return;
  const byBucket = new Map<string, string[]>();
  for (const category of categoriesForScope(req.scope)) {
    for (const ref of (await category.erase?.objects?.(db, ctx)) ?? []) {
      byBucket.set(ref.bucket, [...(byBucket.get(ref.bucket) ?? []), ref.path]);
    }
  }
  for (const [bucket, paths] of byBucket) await remove(bucket, [...new Set(paths)]);
  await markStep(db, req.id, "storage");
}

/** Step 3: all database changes in one transaction (with the completion audit row). */
async function databaseStep(db: Sql, req: Claimed, ctx: ErasureContext) {
  if (req.steps.database) return;
  await db.begin(async (tx) => {
    const counts: Record<string, number> = {};
    counts.consents_withdrawn = (
      await tx<{ n: number }[]>`
        select public.privacy_withdraw_consents(${req.child_id}::uuid, ${req.requested_by}::uuid,
          ${req.scope === "everything" ? null : AI_FEATURES}::text[]) as n`
    )[0].n;
    for (const category of categoriesForScope(req.scope)) {
      if (category.erase?.rows) counts[category.key] = await category.erase.rows(tx, ctx);
    }
    if (req.scope === "everything") {
      counts.claim_codes = (
        await tx`update public.child_claim_codes set expires_at = now() where child_id = ${req.child_id} and used_at is null and expires_at > now()`
      ).count;
      counts.cases = (await tx`delete from public.cases where child_id = ${req.child_id}`).count;
      counts.guardian_links = (
        await tx`
          update public.guardian_links set status = 'revoked', revoked_at = now(), revoked_by = ${req.reviewed_by ?? req.requested_by}
          where child_id = ${req.child_id} and status = 'active'`
      ).count;
      await tx`
        update public.children set display_name = ${DELETED_CHILD_NAME}, date_of_birth = null, sex = null,
               deleted_at = coalesce(deleted_at, now())
        where id = ${req.child_id}`;
      counts.consent_records_redacted = (
        await tx<{ n: number }[]>`select public.privacy_redact_consent_records(${req.child_id}::uuid) as n`
      )[0].n;
      counts.audit_redacted = (
        await tx<{ n: number }[]>`select public.audit_redact_child(${req.child_id}::uuid, ${ctx.caseIds}::uuid[]) as n`
      )[0].n;
    }
    await tx`update public.deletion_requests set steps = steps || ${tx.json({ database: new Date().toISOString() })} where id = ${req.id}`;
    await auditStrict(
      {
        actor: "system",
        childId: req.child_id,
        action: "privacy.deletion_executed",
        entity: "deletion_request",
        entityId: req.id,
        details: { scope: req.scope, counts },
      },
      tx,
    );
  });
}

/**
 * Job (NFR-1): claims an approved request (or a failed / stale in-progress one), runs the remaining steps and
 * completes it once every processor deletion is done. Returns the resulting status, or null when there was nothing
 * to claim (e.g. already completed - re-running is a no-op).
 */
export async function executeDeletion(requestId: string, deps: DeletionDeps = {}, sql?: Sql): Promise<DeletionStatus | null> {
  const db = sql ?? (await pg());
  const [req] = await db<Claimed[]>`
    update public.deletion_requests
    set status = 'in_progress', attempts = attempts + 1, started_at = coalesce(started_at, now()),
        locked_until = now() + interval '15 minutes'
    where id = ${requestId}
      and (status in ('approved', 'failed') or (status = 'in_progress' and (locked_until is null or locked_until < now())))
    returning id, child_id, requested_by, reviewed_by, scope, steps`;
  if (!req) return null;
  try {
    const ctx = await contextFor(db, req);
    const failing = await processorStep(db, req, ctx, deps.deleteConversation ?? deleteConversation);
    await storageStep(db, req, ctx, deps.remove ?? removeObjects);
    await databaseStep(db, req, ctx);
    if (failing > 0) {
      await db`
        update public.deletion_requests set status = 'failed', locked_until = null, last_error = 'processor deletions pending retry'
        where id = ${req.id}`;
      return "failed";
    }
    const eventId = await db.begin(async (tx) => {
      await tx`
        update public.deletion_requests set status = 'completed', completed_at = now(), locked_until = null, last_error = null
        where id = ${req.id}`;
      await auditStrict(
        { actor: "system", childId: req.child_id, action: "privacy.deletion_completed", entity: "deletion_request", entityId: req.id },
        tx,
      );
      return enqueue(tx, {
        topic: "privacy.deletion_completed",
        aggregateType: "deletion_request",
        aggregateId: req.id,
        payload: { request_id: req.id },
        dedupKey: `privacy.deletion_completed:${req.id}`,
      });
    });
    drainSoon([eventId]);
    log.info("deletion completed", { request_id: req.id, scope: req.scope });
    return "completed";
  } catch (err) {
    await db`
      update public.deletion_requests set status = 'failed', locked_until = null, last_error = ${errorMessage(err).slice(0, 300)}
      where id = ${req.id}`;
    log.error("deletion failed", { request_id: req.id, error: errorMessage(err) });
    return "failed";
  }
}
