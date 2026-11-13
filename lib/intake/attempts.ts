// Ticket 035: appointment-bound intake attempts (data access + pure link rules). Server only.
// Every caller passes its gate first: the token pages/routes are public by design (the token is the capability);
// provider views go through requireCasePage / the provider's own schedule; guardian views through requireGuardian.
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { pg, type Queryable } from "@/lib/pg";
import { ATTEMPT_TOKEN_PATTERN, hashIntakeToken, intakeAttemptToken } from "./attempt-token";

export type AgentKind = "child_dev" | "generic";
export type AttemptStatus = "issued" | "started" | "completed" | "expired" | "revoked";
export type AttemptLinkState = "active" | "completed" | "expired" | "revoked";

export type IntakeAttempt = {
  id: string;
  appointment_id: string;
  case_id: string;
  agent_kind: AgentKind;
  status: AttemptStatus;
  expires_at: string;
  conversation_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  appointment_status: string;
  starts_at: string;
  child_id: string | null;
  child_name: string | null;
  case_language: "en" | "hi" | "te";
  provider_name: string;
  service_name: string;
  org_id: string;
  org_name: string;
  guardian_user_id: string | null;
  guardian_name: string | null;
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function toAttempt(row: Record<string, unknown>): IntakeAttempt {
  return {
    ...(row as unknown as IntakeAttempt),
    expires_at: iso(row.expires_at),
    started_at: isoOrNull(row.started_at),
    completed_at: isoOrNull(row.completed_at),
    created_at: iso(row.created_at),
    starts_at: iso(row.starts_at),
  };
}

const ATTEMPT_SELECT = (sql: Queryable) => sql`
  select t.id, t.appointment_id, t.case_id, t.agent_kind, t.status, t.expires_at, t.conversation_id, t.started_at,
         t.completed_at, t.created_at, a.status as appointment_status, lower(a.slot) as starts_at, c.child_id,
         ch.display_name as child_name, c.language as case_language,
         coalesce(a.service_snapshot ->> 'provider_name', p.display_name) as provider_name,
         a.service_snapshot ->> 'name' as service_name, a.org_id, coalesce(o.public_name, o.name) as org_name,
         a.guardian_user_id, nullif(btrim(g.display_name), '') as guardian_name
  from public.intake_attempts t
  join public.appointments a on a.id = t.appointment_id
  join public.cases c on c.id = t.case_id
  join public.provider_profiles p on p.id = a.provider_profile_id
  join public.organizations o on o.id = a.org_id
  left join public.user_profiles g on g.id = a.guardian_user_id
  left join public.children ch on ch.id = c.child_id and ch.deleted_at is null`;

/** The attempt for a link token (only its hash is looked up). Null for malformed or unknown tokens. */
export async function getAttemptByToken(token: string, sql?: Queryable): Promise<IntakeAttempt | null> {
  if (!ATTEMPT_TOKEN_PATTERN.test(token)) return null;
  const db = sql ?? (await pg());
  const rows = await db`${ATTEMPT_SELECT(db)} where t.token_hash = ${hashIntakeToken(token)}`;
  return rows[0] ? toAttempt(rows[0]) : null;
}

export async function getAttemptById(id: string, sql?: Queryable): Promise<IntakeAttempt | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = sql ?? (await pg());
  const rows = await db`${ATTEMPT_SELECT(db)} where t.id = ${id}`;
  return rows[0] ? toAttempt(rows[0]) : null;
}

/**
 * FR-4 link rule (pure). Expires at the appointment start; revoked when the appointment is no longer confirmed.
 * `graceMs` (completion/webhook only): a call that was started before the start may still be delivered a little
 * later, also once the provider marked the appointment completed.
 */
export function attemptLinkState(
  a: Pick<IntakeAttempt, "status" | "expires_at" | "appointment_status">,
  now: number = Date.now(),
  graceMs = 0,
): AttemptLinkState {
  if (a.status === "completed") return "completed";
  if (a.status === "revoked") return "revoked";
  const allowed = graceMs > 0 && a.status === "started" ? ["confirmed", "completed"] : ["confirmed"];
  if (!allowed.includes(a.appointment_status)) return "revoked";
  if (a.status === "expired") return "expired";
  const grace = a.status === "started" ? graceMs : 0;
  return Date.parse(a.expires_at) + grace > now ? "active" : "expired";
}

/** Agent configured for a kind (null = not configured; only DEMO_MODE can then run the flow). */
export function agentIdFor(kind: AgentKind): string | null {
  const id = kind === "generic" ? env.ELEVENLABS_GENERIC_INTAKE_AGENT_ID : process.env.ELEVENLABS_AGENT_ID;
  return id && id.trim() !== "" ? id : null;
}

export type IssueResult =
  | { result: "issued" | "existing"; attempt_id: string; agent_kind: AgentKind }
  | { result: "consent_needed" | "completed" | "not_applicable"; agent_kind: string }
  | { result: "not_found" };

/** FR-3: issues (or returns the active) intake attempt of a confirmed appointment; see appointment_issue_intake. */
export async function issueIntakeAttempt(sql: Queryable, appointmentId: string): Promise<IssueResult> {
  const id = randomUUID();
  const [row] = await sql<{ r: IssueResult }[]>`
    select public.appointment_issue_intake(${appointmentId}, ${id}, ${hashIntakeToken(intakeAttemptToken(id))}) as r`;
  return row.r;
}

/** The start route marks the attempt started (first start only). */
export async function markAttemptStarted(attemptId: string): Promise<void> {
  const sql = await pg();
  await sql`
    update public.intake_attempts set status = 'started', started_at = now(), updated_at = now()
    where id = ${attemptId} and status = 'issued'`;
}

// ---------- views ----------

export type AgendaIntake = { status: "not_started" | "completed"; case_id: string; agent_kind: AgentKind };

/** FR-6: intake per appointment for the provider agenda (only appointments with an attempt). */
export async function agendaIntakeStatus(appointmentIds: string[]): Promise<Map<string, AgendaIntake>> {
  const out = new Map<string, AgendaIntake>();
  if (appointmentIds.length === 0) return out;
  const sql = await pg();
  const rows = await sql<{ appointment_id: string; case_id: string; agent_kind: AgentKind; completed: boolean }[]>`
    select distinct on (appointment_id) appointment_id, case_id, agent_kind, (status = 'completed') as completed
    from public.intake_attempts
    where appointment_id in ${sql(appointmentIds)} and status in ('issued', 'started', 'completed')
    order by appointment_id, (status = 'completed') desc, created_at desc`;
  for (const r of rows) {
    out.set(r.appointment_id, { status: r.completed ? "completed" : "not_started", case_id: r.case_id, agent_kind: r.agent_kind });
  }
  return out;
}

export type GuardianIntakeNotice =
  | { kind: "link"; path: string; agent_kind: AgentKind }
  | { kind: "consent_needed"; child_id: string }
  | { kind: "completed" };

/**
 * The guardian's view on /family/appointments: the call link (re-derived from the attempt id), the consent hint, or
 * "done". Only the guardian's own confirmed, upcoming appointments with an intake service.
 */
export async function guardianIntakeNotices(guardianUserId: string): Promise<Map<string, GuardianIntakeNotice>> {
  const sql = await pg();
  const rows = await sql<{ id: string; child_id: string; attempt_id: string | null; attempt_status: string | null; agent_kind: AgentKind | null; granted: boolean | null }[]>`
    select a.id, a.child_id, t.id as attempt_id, t.status as attempt_status, t.agent_kind, s.granted
    from public.appointments a
    left join lateral (
      select id, status, agent_kind from public.intake_attempts
      where appointment_id = a.id and status in ('issued', 'started', 'completed')
      order by (status = 'completed') desc, created_at desc limit 1
    ) t on true
    left join public.child_consent_state s on s.child_id = a.child_id and s.feature = 'ai_intake_call'
    where a.guardian_user_id = ${guardianUserId} and a.status = 'confirmed' and lower(a.slot) > now()
      and a.child_id is not null and coalesce(a.service_snapshot ->> 'intake_kind', 'none') in ('child_dev', 'generic')`;
  const out = new Map<string, GuardianIntakeNotice>();
  for (const r of rows) {
    if (r.attempt_status === "completed") out.set(r.id, { kind: "completed" });
    else if (r.attempt_id && r.agent_kind) out.set(r.id, { kind: "link", path: `/intake/a/${intakeAttemptToken(r.attempt_id)}`, agent_kind: r.agent_kind });
    else if (!r.granted) out.set(r.id, { kind: "consent_needed", child_id: r.child_id });
  }
  return out;
}

export type CaseIntakeEntry = {
  attempt_id: string;
  appointment_id: string;
  starts_at: string;
  service_name: string;
  agent_kind: AgentKind;
  status: AttemptStatus;
  appointment_status: string;
  recording_id: string | null;
  segments: unknown;
  report: { id: string; kind: string; content: unknown; content_md: string; status: string } | null;
};

/** The case's appointment intakes (newest first) with their recording and brief, for the case Brief tab. */
export async function listCaseIntakes(caseId: string): Promise<CaseIntakeEntry[]> {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) return [];
  const sql = await pg();
  const rows = await sql`
    select t.id as attempt_id, t.appointment_id, lower(a.slot) as starts_at, a.service_snapshot ->> 'name' as service_name,
           t.agent_kind, t.status, a.status as appointment_status, r.id as recording_id, r.segments,
           case when rep.id is null then null else jsonb_build_object('id', rep.id, 'kind', rep.kind, 'content', rep.content,
             'content_md', rep.content_md, 'status', rep.status) end as report
    from public.intake_attempts t
    join public.appointments a on a.id = t.appointment_id
    left join public.recordings r on r.external_id = t.conversation_id and r.case_id = t.case_id
    left join lateral (
      select id, kind, content, content_md, status from public.reports
      where recording_id = r.id and kind in ('pre_session_brief', 'generic_intake_brief') order by created_at desc limit 1
    ) rep on true
    where t.case_id = ${caseId} and t.status in ('issued', 'started', 'completed')
    order by lower(a.slot) desc, t.created_at desc`;
  return rows.map((r) => ({ ...(r as unknown as CaseIntakeEntry), starts_at: iso(r.starts_at) }));
}

/** Conversation ids of the case's generic intake calls (the Child Development Brief tab skips those recordings). */
export async function genericIntakeConversationIds(caseId: string): Promise<string[]> {
  const sql = await pg();
  const rows = await sql<{ conversation_id: string }[]>`
    select conversation_id from public.intake_attempts
    where case_id = ${caseId} and agent_kind = 'generic' and conversation_id is not null`;
  return rows.map((r) => r.conversation_id);
}

/** Recipients of `appointment.intake_link`: the booking guardian, while confirmed and the attempt still active. */
export async function intakeLinkRecipients(sql: Queryable, appointmentId: string, attemptId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select g.id from public.appointments a
    join public.intake_attempts t on t.appointment_id = a.id and t.id = ${attemptId}
    join public.user_profiles g on g.id = a.guardian_user_id and g.role = 'guardian'
    where a.id = ${appointmentId} and a.status = 'confirmed' and t.status in ('issued', 'started') and t.expires_at > now()`;
  return rows.map((r) => r.id);
}
