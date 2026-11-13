// Ticket 051: the voice cost guard through the real route handlers (local database; ElevenLabs mocked at the boundary).
// DEMO_MODE off with fake agent ids, so every route would reach the ElevenLabs client: anonymous starts -> 401 and the
// client is never called (NFR-1); quota (E-2), one call at a time, the platform budget (E-3) for everyone; the end
// report; the landing live demo (guardian 403, provider once per day, verified demo lead); Turnstile on / off (FR-8)
// on voice starts and phone codes; the booking cron expires stale calls. Synthetic users only, removed afterwards.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startScreen } from "@/lib/screen/client";
import { TURNSTILE_VERIFY_URL } from "@/lib/turnstile";
import { TURNSTILE_HEADER } from "@/lib/voice/client";
import { purgeTestAudit } from "./helpers/audit";
import { nextIp } from "./helpers/screen";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

type SessionUser = { id: string; email: string; email_confirmed_at?: string | null };
const session = vi.hoisted(() => ({ user: null as null | SessionUser, cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
const agent = vi.hoisted(() => ({ startAgentSession: vi.fn() }));
vi.mock("@/lib/elevenlabs/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/elevenlabs/agent")>();
  return { ...actual, startAgentSession: agent.startAgentSession };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    getAll: () => [...session.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => session.cookies.has(name),
    set: () => {},
  }),
  headers: async () => ({ get: () => null }),
}));

type Json = Record<string, unknown>;
const CRON_SECRET = "t051-cron-secret";

const voiceReq = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "x-forwarded-for": nextIp(), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function json(res: Response): Promise<{ status: number; body: Json }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

describe.skipIf(!enabled)("voice cost guard routes (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let guardian: TestUser;
  let guardian2: TestUser;
  let provider: TestUser;
  let provider2: TestUser;
  let admin: TestUser;
  let lead: TestUser;
  let r: {
    screen: typeof import("@/app/api/screen/sessions/route");
    booking: typeof import("@/app/api/agents/booking/session/route");
    demo: typeof import("@/app/api/demo/voice-token/route");
    end: typeof import("@/app/api/voice/usage/[id]/end/route");
    phone: typeof import("@/app/api/auth/phone/send/route");
    cron: typeof import("@/app/api/cron/booking/route");
  };
  const screenSessions: string[] = [];
  const bookingTokens: string[] = [];

  const as = (u: TestUser | null, extra: Partial<SessionUser> = {}) => {
    session.user = u ? { id: u.id, email: u.email, email_confirmed_at: new Date().toISOString(), ...extra } : null;
  };
  const close = (userId: string) =>
    sql`update voice_usage set status = 'ended', ended_at = now(), actual_seconds = 0 where user_id = ${userId} and status = 'started'`;
  const startScreenVoice = async (headers: Record<string, string> = {}) => {
    const res = await json(await r.screen.POST(voiceReq("/api/screen/sessions", { age_band: "31-71m", mode: "voice" }, headers)));
    if (res.status === 201) screenSessions.push(res.body.session_id as string);
    return res;
  };
  const startBooking = async (headers: Record<string, string> = {}) => {
    session.cookies.clear();
    const res = await json(await r.booking.POST(voiceReq("/api/agents/booking/session", undefined, headers)));
    if (res.status === 201) bookingTokens.push(res.body.booking_session as string);
    return res;
  };
  const startDemo = async () => json(await r.demo.POST(voiceReq("/api/demo/voice-token")));
  const end = async (id: string, body: unknown) =>
    json(await r.end.POST(voiceReq(`/api/voice/usage/${id}/end`, body), { params: Promise.resolve({ id }) }));

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t051r");
    guardian = await world.user("guardian", "guardian");
    guardian2 = await world.user("guardian2", "guardian");
    provider = await world.user("provider", "provider");
    provider2 = await world.user("provider2", "provider");
    admin = await world.user("admin", "platform_admin");
    lead = await world.user("lead", "guardian");
    await sql`insert into pilot_signups (name, email, role, country) values ('t051 Lead (synthetic)', ${lead.email.toUpperCase()}, 'centre_owner', 'India')`;
    r = {
      screen: await import("@/app/api/screen/sessions/route"),
      booking: await import("@/app/api/agents/booking/session/route"),
      demo: await import("@/app/api/demo/voice-token/route"),
      end: await import("@/app/api/voice/usage/[id]/end/route"),
      phone: await import("@/app/api/auth/phone/send/route"),
      cron: await import("@/app/api/cron/booking/route"),
    };
  });

  beforeEach(async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_intake_test");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "agent_screen_test");
    vi.stubEnv("ELEVENLABS_BOOKING_AGENT_ID", "agent_booking_test");
    vi.stubEnv("ELEVENLABS_FOLLOWUP_AGENT_ID", "agent_followup_test");
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", "t051-tool-secret");
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    agent.startAgentSession.mockReset();
    agent.startAgentSession.mockImplementation(async (id: string) => ({ agent_id: id, conversation_token: "conv_tok_test" }));
    (await import("@/lib/screen/rate-limit")).screenSessionLimiter.reset();
    (await import("@/lib/agents/booking/rate-limit")).agentSessionLimiter.reset();
    (await import("@/lib/voiceDemoLimit")).resetVoiceDemoLimits();
    as(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (!sql) return;
    if (screenSessions.length) await sql`delete from screen_sessions where id in ${sql(screenSessions)}`;
    if (bookingTokens.length) {
      const { hashAgentToken } = await import("@/lib/agents/booking/session");
      await sql`delete from booking_agent_sessions where token_hash in ${sql(bookingTokens.map(hashAgentToken))}`;
    }
    await sql`delete from pilot_signups where lower(email) = ${lead.email.toLowerCase()}`;
    await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action = 'landing.voice_demo_started' and created_at > now() - interval '1 hour' and entity = 'voice_demo'`);
    await world.cleanup();
    await sql.end();
  });

  it("FR-1 / NFR-1: anonymous voice starts (screen, booking, live demo) -> 401 sign_in_required; ElevenLabs never called", async () => {
    for (const res of [await startScreenVoice(), await startBooking(), await startDemo()]) {
      expect(res).toEqual({ status: 401, body: { error: "sign_in_required" } });
    }
    expect(agent.startAgentSession).not.toHaveBeenCalled();
    // Tapping stays anonymous.
    const form = await json(await r.screen.POST(voiceReq("/api/screen/sessions", { age_band: "31-71m", mode: "form" })));
    expect(form.status).toBe(201);
    screenSessions.push(form.body.session_id as string);
    expect(await sql`select 1 from voice_usage where started_at > now() - interval '1 minute' and user_id is null`).toHaveLength(0);
  });

  it("E-2 / FR-4: a guardian's 3rd voice check-in in one day -> 429 quota_day (tap path still works); the client maps it", async () => {
    as(guardian);
    for (let i = 0; i < 2; i++) {
      const res = await startScreenVoice();
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ conversation_token: "conv_tok_test", max_seconds: 360 });
      const ended = await end(res.body.voice_usage_id as string, { duration_seconds: 42, conversation_id: `conv_t051_${i}` });
      expect(ended.status).toBe(200);
      expect(ended.body.status).toBe("ended");
    }
    expect(agent.startAgentSession).toHaveBeenCalledTimes(2);
    expect(await startScreenVoice()).toEqual({ status: 429, body: { error: "quota_day" } });
    expect(agent.startAgentSession).toHaveBeenCalledTimes(2);
    // The browser shows the friendly quota message (screen.errors.quotaDay) next to the tap button.
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) =>
      r.screen.POST(new Request(new URL(String(input), "http://localhost"), { ...init, headers: { ...(init?.headers as Record<string, string>), "x-forwarded-for": nextIp() } }))) as typeof fetch;
    expect(await startScreen("31-71m", "voice", { fetchFn })).toEqual({ kind: "error", error: "quotaDay" });
    const tap = await startScreen("31-71m", "form", { fetchFn });
    expect(tap.kind).toBe("form");
    if (tap.kind === "form") screenSessions.push(tap.session.session_id);
  });

  it("FR-4: one open voice call per user, across agents -> 429 concurrent until the first one ends", async () => {
    as(guardian2);
    const first = await startBooking();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ max_seconds: 240 });
    expect(await startScreenVoice()).toEqual({ status: 429, body: { error: "concurrent" } });
    expect(await startBooking()).toEqual({ status: 429, body: { error: "concurrent" } });
    await end(first.body.voice_usage_id as string, { duration_seconds: 10 });
    expect((await startScreenVoice()).status).toBe(201);
    await close(guardian2.id);
  });

  it("E-3 / FR-5: the budget reached -> 503 voice_paused for everyone, before ElevenLabs; a 100% alert is queued", async () => {
    const { budgetAlertKey } = await import("@/lib/voice/usage");
    const key = budgetAlertKey(100);
    await sql`delete from outbox_events where dedup_key = ${key}`;
    vi.stubEnv("VOICE_DAILY_MINUTES_CAP", "1");
    vi.stubEnv("VOICE_MONTHLY_MINUTES_CAP", "1");
    as(provider2);
    expect(await startScreenVoice()).toEqual({ status: 503, body: { error: "voice_paused" } });
    expect(await startBooking()).toEqual({ status: 503, body: { error: "voice_paused" } });
    expect(await startDemo()).toEqual({ status: 503, body: { error: "voice_paused" } });
    as(admin);
    expect(await startScreenVoice()).toEqual({ status: 503, body: { error: "voice_paused" } });
    expect(agent.startAgentSession).not.toHaveBeenCalled();
    expect(await sql`select 1 from outbox_events where dedup_key = ${key} and topic = 'voice.budget_alert'`).toHaveLength(1);
    await sql`delete from outbox_events where dedup_key = ${key}`;
    const blocked = await sql`select blocked_reason from voice_usage where user_id in ${sql([provider2.id, admin.id])} and status = 'blocked'`;
    expect(blocked.length).toBeGreaterThanOrEqual(4);
    expect(blocked.every((b) => b.blocked_reason === "budget")).toBe(true);
  });

  it("FR-7: the end route is for the caller's own call only (404 otherwise) and clamps the duration", async () => {
    as(provider);
    const started = await startBooking();
    expect(started.status).toBe(201);
    const id = started.body.voice_usage_id as string;
    as(guardian2);
    expect((await end(id, { duration_seconds: 5 })).status).toBe(404);
    expect((await end("not-a-uuid", { duration_seconds: 5 })).status).toBe(404);
    as(null);
    expect((await end(id, { duration_seconds: 5 })).status).toBe(401);
    as(provider);
    expect((await end(id, { duration_seconds: -1 })).status).toBe(400);
    expect((await end(id, { duration_seconds: 5, extra: 1 })).status).toBe(400);
    await sql`update voice_usage set started_at = now() - interval '5 minutes' where id = ${id}`;
    expect(await end(id, { duration_seconds: 10_000 })).toEqual({ status: 200, body: { status: "ended", actual_seconds: 240 } });
  });

  it("FR-2: the live demo -> guardian 403; provider once per day; a verified demo lead allowed; provider failure releases", async () => {
    as(guardian);
    expect(await startDemo()).toEqual({ status: 403, body: { error: "live_demo_not_allowed" } });
    // A lead whose email is not verified is a plain guardian.
    as(lead, { email_confirmed_at: null });
    expect((await startDemo()).status).toBe(403);
    expect(agent.startAgentSession).not.toHaveBeenCalled();

    as(provider);
    await close(provider.id);
    const first = await startDemo();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ conversation_token: "conv_tok_test", max_seconds: 180, dynamic_variables: { child_name: "Ravi" } });
    await end(first.body.voice_usage_id as string, { duration_seconds: 120 });
    expect(await startDemo()).toEqual({ status: 429, body: { error: "quota_day" } });
    expect(agent.startAgentSession).toHaveBeenCalledTimes(1);

    as(lead);
    const leadStart = await startDemo();
    expect(leadStart.status).toBe(200);
    await end(leadStart.body.voice_usage_id as string, { duration_seconds: 30 });

    // ElevenLabs fails: 502 without details, and the reservation is released (the admin can try again).
    as(admin);
    await close(admin.id);
    agent.startAgentSession.mockRejectedValueOnce(new Error("HTTP 500 xi-secret"));
    const failed = await startDemo();
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain("xi-secret");
    expect(await sql`select 1 from voice_usage where user_id = ${admin.id} and agent = 'intake_demo'`).toHaveLength(0);
    const retry = await startDemo();
    expect(retry.status).toBe(200);
    await close(admin.id);
  });

  it("FR-8: Turnstile on -> a missing or invalid token is 400 on voice starts and phone codes; a valid token passes", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "site-t051");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-t051");
    vi.stubEnv("DEMO_MODE", "true");
    const realFetch = globalThis.fetch;
    const verify = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json({ success: (init?.body as URLSearchParams).get("response") === "good-token" }),
    );
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(TURNSTILE_VERIFY_URL) ? verify(input, init) : realFetch(input, init),
    );
    as(guardian2);
    await close(guardian2.id);
    const bot = { status: 400, body: { error: "bot_check_failed" } };
    expect(await startScreenVoice()).toEqual(bot);
    expect(await startScreenVoice({ [TURNSTILE_HEADER]: "bad-token" })).toEqual(bot);
    expect(await startBooking()).toEqual(bot);
    expect(await sql`select 1 from voice_usage where user_id = ${guardian2.id} and status = 'started'`).toHaveLength(0);
    const ok = await startBooking({ [TURNSTILE_HEADER]: "good-token" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await close(guardian2.id);

    as(null);
    const phone = (headers: Record<string, string> = {}) => r.phone.POST(voiceReq("/api/auth/phone/send", { phone: "9000000005" }, headers));
    expect(await json(await phone())).toEqual(bot);
    expect(await json(await phone({ [TURNSTILE_HEADER]: "bad-token" }))).toEqual(bot);
    const passed = await json(await phone({ [TURNSTILE_HEADER]: "good-token" }));
    expect(passed.body.error).not.toBe("bot_check_failed");
    expect(verify).toHaveBeenCalled();
  });

  it("FR-8: Turnstile off -> no check at all (local / DEMO_MODE)", async () => {
    const fetchSpy = vi.fn();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(TURNSTILE_VERIFY_URL)) fetchSpy();
      return realFetch(input, init);
    });
    as(provider);
    await close(provider.id);
    const res = await startScreenVoice();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await close(provider.id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("FR-7: the booking cron expires calls that never reported their end (actual = reserved)", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into voice_usage (user_id, agent, started_at, reserved_seconds) values (${guardian.id}, 'followup', now() - interval '13 minutes', 600) returning id`;
    const unauthorized = await r.cron.POST(new Request("http://localhost/api/cron/booking", { method: "POST" }));
    expect(unauthorized.status).toBe(401);
    const run = await json(await r.cron.POST(new Request("http://localhost/api/cron/booking", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } })));
    expect(run.status).toBe(200);
    expect(typeof run.body.voice_expired).toBe("number");
    expect(run.body.voice_reconciled).toBe(0);
    expect((await sql`select status, actual_seconds from voice_usage where id = ${row.id}`)[0]).toEqual({ status: "expired", actual_seconds: 600 });
  });
});
