// Ticket 034 FR-2 / FR-3: voice booking sessions (server-only). The browser starts a session and passes the random
// `booking_session` token to the ElevenLabs agent as a dynamic variable; the agent sends it with every server tool
// call. Only its SHA-256 is stored. The same token is kept in the httpOnly `dnm_booking_session` cookie so only this
// browser can read the session's hold (widget card) or end it. Hold ownership is the browser's 030 booking session
// (`dnm_booking` cookie), never the agent token: whoever sees the agent's variables cannot attach the hold.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { pg, type Queryable } from "@/lib/pg";
import { AGENT_SECRET_HEADER, AGENT_SESSION_TTL_MS, MAX_TOOL_CALLS } from "./constants";
import { BOOKING_SESSION_RE } from "./schemas";

export const AGENT_SESSION_COOKIE = "dnm_booking_session";
const COOKIE_PATH = "/api/agents/booking";

export type AgentSession = {
  id: string;
  owner_session_hash: string;
  demo: boolean;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  tool_calls: number;
  hold_appointment_id: string | null;
};

export function newAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(`booking-agent:${token}`).digest("hex");
}

/** FR-3 / D-4: constant-time check of `X-Agent-Secret`. No secret configured -> every call is refused. */
export function verifyAgentSecret(req: Request, secret: string | undefined = env.ELEVENLABS_TOOL_SECRET): boolean {
  const given = req.headers.get(AGENT_SECRET_HEADER);
  if (!secret || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toSession = (row: Record<string, unknown>): AgentSession => ({
  ...(row as unknown as AgentSession),
  created_at: iso(row.created_at),
  expires_at: iso(row.expires_at),
  ended_at: row.ended_at ? iso(row.ended_at) : null,
});

/** Creates a session owned by the browser's booking session hash. Also purges sessions expired over a day ago. */
export async function createAgentSession(ownerSessionHash: string, opts: { demo: boolean; sql?: Queryable }): Promise<{ token: string; session: AgentSession }> {
  const sql = opts.sql ?? (await pg());
  await sql`delete from public.booking_agent_sessions where expires_at < now() - interval '1 day'`;
  const token = newAgentToken();
  const [row] = await sql`
    insert into public.booking_agent_sessions (token_hash, owner_session_hash, demo, expires_at)
    values (${hashAgentToken(token)}, ${ownerSessionHash}, ${opts.demo}, now() + ${`${AGENT_SESSION_TTL_MS / 1000} seconds`}::interval)
    returning id, owner_session_hash, demo, created_at, expires_at, ended_at, tool_calls, hold_appointment_id`;
  return { token, session: toSession(row) };
}

export type ToolCallGate = { ok: true; session: AgentSession } | { ok: false; status: 401 | 429 };

/**
 * FR-3: counts one tool call against a valid session, atomically. Unknown, expired or ended -> 401; the 21st call
 * and later -> 429 (still counted, so a client hammering the limit stays limited).
 */
export async function chargeToolCall(token: string, sql?: Queryable): Promise<ToolCallGate> {
  if (!BOOKING_SESSION_RE.test(token)) return { ok: false, status: 401 };
  const db = sql ?? (await pg());
  const [row] = await db`
    update public.booking_agent_sessions set tool_calls = tool_calls + 1
    where token_hash = ${hashAgentToken(token)} and expires_at > now() and ended_at is null
    returning id, owner_session_hash, demo, created_at, expires_at, ended_at, tool_calls, hold_appointment_id`;
  if (!row) return { ok: false, status: 401 };
  const session = toSession(row);
  if (session.tool_calls > MAX_TOOL_CALLS) return { ok: false, status: 429 };
  return { ok: true, session };
}

/** The session for a token (any state), or null. */
export async function getAgentSession(token: string | null | undefined): Promise<AgentSession | null> {
  if (!token || !BOOKING_SESSION_RE.test(token)) return null;
  const sql = await pg();
  const [row] = await sql`
    select id, owner_session_hash, demo, created_at, expires_at, ended_at, tool_calls, hold_appointment_id
    from public.booking_agent_sessions where token_hash = ${hashAgentToken(token)}`;
  return row ? toSession(row) : null;
}

/** Ends a session (the parent ended the call, or a red flag stopped it): later tool calls get 401. */
export async function endAgentSession(token: string): Promise<boolean> {
  if (!BOOKING_SESSION_RE.test(token)) return false;
  const sql = await pg();
  const done = await sql`
    update public.booking_agent_sessions set ended_at = now()
    where token_hash = ${hashAgentToken(token)} and ended_at is null`;
  return done.count > 0;
}

export async function setSessionHold(sessionId: string, appointmentId: string, sql: Queryable): Promise<void> {
  await sql`update public.booking_agent_sessions set hold_appointment_id = ${appointmentId} where id = ${sessionId}`;
}

/** The agent token from this browser's cookie (status, end and the DEMO_MODE tool route). */
export async function cookieAgentToken(): Promise<string | null> {
  const value = (await cookies()).get(AGENT_SESSION_COOKIE)?.value;
  return value && BOOKING_SESSION_RE.test(value) ? value : null;
}

export function agentSessionCookie(token: string) {
  return {
    name: AGENT_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: AGENT_SESSION_TTL_MS / 1000,
  };
}
