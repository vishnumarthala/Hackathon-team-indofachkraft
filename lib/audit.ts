// Audit log (017, hardened by 041). Two writers:
//   * `audit(event)`       - best effort, never throws: low-risk events (views, AI pipeline steps, profile edits).
//   * `auditStrict(event, tx?)` - fail closed: throws `AuditWriteError` when the row cannot be written. Pass the
//     caller's `sql.begin` transaction so the audit row commits or rolls back with the change; routes turn the
//     error into 503 `{ error: "Could not save. Please try again." }` (`auditFailure(err)`). The actions that must
//     use it are listed in lib/audit/strict-actions.ts (a test enforces the list).
// The actor always comes from the server-side session (`getAuditActor()`), or from a caller that already resolved
// the session user (`auditActorOf(user, role)`); never from a request body. Omit `actor` to use the session.
// The database fills `actor_role` (from user_profiles), `case_ref`, `child_id` and `org_id` (migration
// 20261113004100_audit_hardening.sql) and refuses updates/deletes for every role.
import { createHash } from "node:crypto";
import { getAuthenticatedUser, getUserRole, type UserRole } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";
import { errorMessage, logger } from "@/lib/log";
import { pg, type Queryable } from "@/lib/pg";

/** `actor` column: legacy kinds (therapist/parent/specialist) stay valid for history and SQL-function writers. */
export type AuditActor =
  | "therapist"
  | "parent"
  | "specialist"
  | "ai"
  | "system"
  | "provider"
  | "guardian"
  | "platform_admin"
  | "anonymous";

export type AuditActorRole = "platform_admin" | "provider" | "guardian" | "system" | "ai" | "anonymous";

export type SessionAuditActor = { actor: AuditActor; actorUserId: string | null; actorRole: AuditActorRole };

export type AuditEvent = {
  caseId?: string | null;
  /** Omit to attribute the event to the signed-in user (or `anonymous`), or when `actorUserId` is given. */
  actor?: AuditActor;
  actorUserId?: string | null;
  actorRole?: AuditActorRole;
  orgId?: string | null;
  childId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
};

export const AUDIT_SAVE_FAILED = "Could not save. Please try again.";

export class AuditWriteError extends Error {
  readonly action: string;
  constructor(action: string, cause: unknown) {
    super(`Audit write failed for ${action}: ${errorMessage(cause)}`);
    this.name = "AuditWriteError";
    this.action = action;
  }
}

const log = logger("audit");

const ANONYMOUS: SessionAuditActor = { actor: "anonymous", actorUserId: null, actorRole: "anonymous" };

/** For callers that already hold the session user and its role. */
export function auditActorOf(user: { id: string } | null | undefined, role: UserRole): SessionAuditActor {
  if (!user) return ANONYMOUS;
  return { actor: role, actorUserId: user.id, actorRole: role };
}

/** FR-2: the signed-in user and role from the server-side session; `anonymous` without one. Never throws. */
export async function getAuditActor(): Promise<SessionAuditActor> {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return ANONYMOUS;
    return auditActorOf(user, await getUserRole(user.id));
  } catch {
    return ANONYMOUS;
  }
}

/**
 * Dev/test hook (E-2): `AUDIT_FAIL_ACTIONS=consent.granted,org.member_revoked` makes those audit writes fail.
 * Ignored in production builds.
 */
export function auditWouldFail(action: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const list = process.env.AUDIT_FAIL_ACTIONS;
  if (!list) return false;
  return list
    .split(",")
    .map((s) => s.trim())
    .some((a) => a === action || a === "*");
}

/** Strict actions implemented by a SQL function (audit row inside the function): call before the RPC. */
export function assertAuditWritable(action: string): void {
  if (auditWouldFail(action)) throw new AuditWriteError(action, "AUDIT_FAIL_ACTIONS test hook");
}

/** 503 `Could not save. Please try again.` for a failed strict write (the audit row or the change it guards). */
export function auditFailure(err: unknown): Response {
  log.error(err instanceof AuditWriteError ? err.message : `strict write failed: ${errorMessage(err)}`);
  return fail(503, AUDIT_SAVE_FAILED);
}

/** Attributes audit rows written later in this transaction by SQL that names a human actor kind but no id. */
export async function setTxAuditActor(tx: Queryable, actor: SessionAuditActor | null | undefined): Promise<void> {
  await tx`select set_config('dnm.actor_user_id', ${actor?.actorUserId ?? ""}, true)`;
}

function hashIp(ip: string): string {
  const salt = process.env.CONSENT_IP_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || "dnm";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

async function requestContext(): Promise<{ request_id?: string; ip_hash?: string }> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const requestId = h.get("x-request-id") ?? h.get("x-vercel-id");
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim();
    return {
      ...(requestId ? { request_id: requestId.slice(0, 200) } : {}),
      ...(ip ? { ip_hash: hashIp(ip) } : {}),
    };
  } catch {
    return {};
  }
}

type AuditRow = {
  case_id: string | null;
  actor?: AuditActor;
  actor_user_id?: string;
  actor_role?: AuditActorRole;
  org_id?: string;
  child_id?: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: Record<string, unknown>;
  request_id?: string;
  ip_hash?: string;
};

async function buildRow(event: AuditEvent): Promise<AuditRow> {
  let actor: Partial<SessionAuditActor>;
  if (event.actor) actor = { actor: event.actor, actorUserId: event.actorUserId ?? null, actorRole: event.actorRole };
  else if (event.actorUserId) actor = { actorUserId: event.actorUserId, actorRole: event.actorRole };
  else actor = await getAuditActor();
  return {
    case_id: event.caseId ?? null,
    ...(actor.actor ? { actor: actor.actor } : {}),
    ...(actor.actorUserId ? { actor_user_id: actor.actorUserId } : {}),
    ...(actor.actorRole ? { actor_role: actor.actorRole } : {}),
    ...(event.orgId ? { org_id: event.orgId } : {}),
    ...(event.childId ? { child_id: event.childId } : {}),
    action: event.action,
    entity: event.entity ?? null,
    entity_id: event.entityId ?? null,
    details: event.details ?? {},
    ...(await requestContext()),
  };
}

// Best effort: a failed audit write must not break a low-risk action.
export async function audit(event: AuditEvent): Promise<void> {
  try {
    if (auditWouldFail(event.action)) throw new Error("AUDIT_FAIL_ACTIONS test hook");
    const { error } = await supabaseAdmin().from("audit_events").insert(await buildRow(event));
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`audit failed: ${errorMessage(err)}`);
  }
}

/** Fail-closed audit write; inside `tx` when given (same transaction as the change). */
export async function auditStrict(event: AuditEvent, tx?: Queryable): Promise<void> {
  assertAuditWritable(event.action);
  const row = await buildRow(event);
  try {
    const sql = tx ?? (await pg());
    await sql`
      insert into public.audit_events
        (case_id, actor, actor_user_id, actor_role, org_id, child_id, action, entity, entity_id, details, request_id, ip_hash)
      values (${row.case_id}, ${row.actor ?? null}, ${row.actor_user_id ?? null}, ${row.actor_role ?? null},
              ${row.org_id ?? null}, ${row.child_id ?? null}, ${row.action}, ${row.entity}, ${row.entity_id},
              ${sql.json(row.details as Parameters<typeof sql.json>[0])}, ${row.request_id ?? null}, ${row.ip_hash ?? null})`;
  } catch (err) {
    throw new AuditWriteError(event.action, err);
  }
}
