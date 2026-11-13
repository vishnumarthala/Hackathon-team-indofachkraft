// 041 FR-4: the platform admin's audit log view. Filters and keyset pagination (newest first); returns columns only,
// never `details` (which may hold field names, scopes or ids of health/consent records).
import { isUuid } from "@/lib/cases/validation";
import { pg, type Sql } from "@/lib/pg";

export const AUDIT_PAGE_SIZE = 50;
export const ACTOR_ROLES = ["platform_admin", "provider", "guardian", "system", "ai", "anonymous"] as const;

export type AuditFilters = {
  action?: string;
  actor?: string; // user id or role
  org?: string;
  child?: string;
  case?: string;
  from?: string; // YYYY-MM-DD (inclusive, UTC)
  to?: string; // YYYY-MM-DD (inclusive, UTC)
  before?: string; // id cursor
};

export type AuditListRow = {
  id: string;
  created_at: Date;
  actor: string;
  actor_role: string;
  actor_user_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  case_ref: string | null;
  child_id: string | null;
  org_id: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Keeps only well-formed filter values (anything else is ignored, never interpolated). */
export function cleanFilters(input: Record<string, string | string[] | undefined>): AuditFilters {
  const one = (k: string) => {
    const v = input[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const f: AuditFilters = {};
  const action = one("action");
  if (action && /^[a-z0-9_.*-]{1,80}$/.test(action)) f.action = action;
  const actor = one("actor");
  if (actor && (isUuid(actor) || (ACTOR_ROLES as readonly string[]).includes(actor))) f.actor = actor;
  for (const key of ["org", "child", "case"] as const) {
    const v = one(key);
    if (v && isUuid(v)) f[key] = v;
  }
  const from = one("from");
  if (from && DATE.test(from)) f.from = from;
  const to = one("to");
  if (to && DATE.test(to)) f.to = to;
  const before = one("before");
  if (before && /^\d{1,18}$/.test(before)) f.before = before;
  return f;
}

export async function listAuditEvents(filters: AuditFilters, sql?: Sql): Promise<{ rows: AuditListRow[]; nextBefore: string | null }> {
  const db = sql ?? (await pg());
  const conds = [db`true`];
  if (filters.action) {
    conds.push(filters.action.endsWith("*") ? db`action like ${`${filters.action.slice(0, -1)}%`}` : db`action = ${filters.action}`);
  }
  if (filters.actor) conds.push(isUuid(filters.actor) ? db`actor_user_id = ${filters.actor}` : db`actor_role = ${filters.actor}`);
  if (filters.org) conds.push(db`org_id = ${filters.org}`);
  if (filters.child) conds.push(db`child_id = ${filters.child}`);
  if (filters.case) conds.push(db`case_ref = ${filters.case}`);
  if (filters.from) conds.push(db`created_at >= ${filters.from}::date`);
  if (filters.to) conds.push(db`created_at < ${filters.to}::date + 1`);
  if (filters.before) conds.push(db`id < ${filters.before}`);
  const where = conds.reduce((acc, c) => db`${acc} and ${c}`);
  const rows = await db<AuditListRow[]>`
    select id::text as id, created_at, actor, actor_role, actor_user_id, action, entity, entity_id, case_ref, child_id, org_id
    from public.audit_events where ${where}
    order by id desc limit ${AUDIT_PAGE_SIZE + 1}`;
  const more = rows.length > AUDIT_PAGE_SIZE;
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  return { rows: page, nextBefore: more ? page[page.length - 1].id : null };
}
