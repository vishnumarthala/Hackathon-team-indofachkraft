// Ticket 040 FR-5: voice sessions of the follow-up agent (server only). `POST /api/agents/followup/session` (signed-in
// guardian, active link, `ai_follow_up` consent) creates a 15-minute session bound to (guardian, child) and returns a
// random token. The browser passes it to the ElevenLabs agent as the dynamic variable `followup_session`; the agent
// sends it with every `answer_question` tool call. Only its SHA-256 is stored. No child or guardian name ever goes to
// the agent: the token is the only thing it learns.
import { createHash, randomBytes } from "node:crypto";
import { pg, type Queryable } from "@/lib/pg";
import { AGENT_SESSION_TTL_MS, MAX_TOOL_CALLS } from "./constants";

export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type FollowupSession = {
  id: string;
  guardian_user_id: string;
  child_id: string;
  demo: boolean;
  tool_calls: number;
  conversation_id: string | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
};

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(`followup-agent:${token}`).digest("hex");
}

const COLS = "id, guardian_user_id, child_id, demo, tool_calls, conversation_id, created_at, expires_at, ended_at";
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toSession = (row: Record<string, unknown>): FollowupSession => ({
  ...(row as unknown as FollowupSession),
  created_at: iso(row.created_at),
  expires_at: iso(row.expires_at),
  ended_at: row.ended_at ? iso(row.ended_at) : null,
});

/** Creates a session for (guardian, child). Also purges sessions that expired more than a day ago without a conversation id. */
export async function createFollowupSession(
  input: { guardianUserId: string; childId: string; demo: boolean; ttlMs?: number },
  sql?: Queryable,
): Promise<{ token: string; session: FollowupSession }> {
  const db = sql ?? (await pg());
  await db`delete from public.followup_agent_sessions where expires_at < now() - interval '1 day' and conversation_id is null`;
  const token = newSessionToken();
  const ttl = `${Math.round((input.ttlMs ?? AGENT_SESSION_TTL_MS) / 1000)} seconds`;
  const [row] = await db.unsafe(
    `insert into public.followup_agent_sessions (token_hash, guardian_user_id, child_id, demo, expires_at)
     values ($1, $2, $3, $4, now() + $5::interval) returning ${COLS}`,
    [hashSessionToken(token), input.guardianUserId, input.childId, input.demo, ttl],
  );
  return { token, session: toSession(row) };
}

export type SessionGate = { ok: true; session: FollowupSession } | { ok: false; status: 401 | 429 };

/**
 * Counts one tool call against a valid session, atomically. Unknown, expired or ended -> 401; more than
 * MAX_TOOL_CALLS -> 429. `guardianUserId` (DEMO route) additionally requires the session to be the caller's own.
 */
export async function chargeToolCall(token: string, opts: { guardianUserId?: string } = {}, sql?: Queryable): Promise<SessionGate> {
  if (!SESSION_TOKEN_RE.test(token)) return { ok: false, status: 401 };
  const db = sql ?? (await pg());
  const rows = await db.unsafe(
    `update public.followup_agent_sessions set tool_calls = tool_calls + 1
     where token_hash = $1 and expires_at > now() and ended_at is null
       and ($2::uuid is null or guardian_user_id = $2::uuid)
     returning ${COLS}`,
    [hashSessionToken(token), opts.guardianUserId ?? null],
  );
  if (!rows[0]) return { ok: false, status: 401 };
  const session = toSession(rows[0]);
  if (session.tool_calls > MAX_TOOL_CALLS) return { ok: false, status: 429 };
  return { ok: true, session };
}

/** Ends the guardian's own session (the call ended, or a red flag stopped it); later tool calls get 401. */
export async function endFollowupSession(
  token: string,
  input: { guardianUserId?: string; conversationId?: string | null } = {},
  sql?: Queryable,
): Promise<boolean> {
  if (!SESSION_TOKEN_RE.test(token)) return false;
  const db = sql ?? (await pg());
  const rows = await db.unsafe(
    `update public.followup_agent_sessions
     set ended_at = coalesce(ended_at, now()), conversation_id = coalesce(conversation_id, $3)
     where token_hash = $1 and ($2::uuid is null or guardian_user_id = $2::uuid)
     returning id`,
    [hashSessionToken(token), input.guardianUserId ?? null, input.conversationId ?? null],
  );
  return rows.length > 0;
}
