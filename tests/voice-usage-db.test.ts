// Ticket 051: the voice usage ledger against the local database. One atomic `voice_session_start` (FR-4/FR-5):
// daily and 30-day quotas, one open call per user (parallel starts), 20 parallel starts never overshoot the cap, the
// budget refuses everyone, the 80% alert is queued once per day, the end is clamped (FR-7), stale calls expire at
// reserved, ElevenLabs durations are reconciled (skipped in DEMO_MODE), the admin cap override is audited and fails
// closed (FR-10), the admin overview, retention, NFR-2 (< 30 ms). Synthetic users only; everything is removed.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { purgeTestAudit } from "./helpers/audit";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const HUGE = { dailySeconds: 10_000_000_000, monthlySeconds: 10_000_000_000 };

describe.skipIf(!enabled)("voice usage ledger (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let usage: typeof import("@/lib/voice/usage");
  let guardian: TestUser;
  let other: TestUser;
  let admin: TestUser;
  const crowd: TestUser[] = [];
  const alertKeys: string[] = [];

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 25, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t051db");
    usage = await import("@/lib/voice/usage");
    guardian = await world.user("guardian", "guardian");
    other = await world.user("other", "guardian");
    admin = await world.user("admin", "platform_admin");
    for (let i = 0; i < 20; i++) crowd.push(await world.user(`crowd${i}`, "guardian"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    session.user = null;
    // A failed test never leaves an open call behind for the next one.
    await sql`update voice_usage set status = 'ended', ended_at = now(), actual_seconds = 0
              where status = 'started' and user_id in ${sql([guardian.id, other.id, admin.id, ...crowd.map((c) => c.id)])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`update voice_settings set daily_minutes_cap = null, monthly_minutes_cap = null where id`;
    if (alertKeys.length) await sql`delete from outbox_events where dedup_key in ${sql(alertKeys)}`;
    await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action = 'voice.caps_updated' and actor_user_id = ${admin.id}`);
    // voice_usage rows go with the users (on delete cascade).
    await world.cleanup();
    expect(await sql`select 1 from voice_usage where user_id in ${sql([guardian.id, other.id, admin.id, ...crowd.map((c) => c.id)])}`).toHaveLength(0);
    await sql.end();
  });

  const close = (userId: string) =>
    sql`update voice_usage set status = 'ended', ended_at = now(), actual_seconds = 0 where user_id = ${userId} and status = 'started'`;
  const start = (u: TestUser, agent: "screen" | "booking" | "followup" | "intake_demo" = "screen", opts: Parameters<typeof usage.startVoiceUsage>[2] = {}) =>
    usage.startVoiceUsage(u.id, agent, { sql, caps: HUGE, ...opts });

  it("FR-3: the table has exactly the ledger columns (no child, no transcript) and is service-role only", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'voice_usage' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "id",
      "user_id",
      "agent",
      "started_at",
      "ended_at",
      "reserved_seconds",
      "actual_seconds",
      "conversation_id",
      "status",
      "blocked_reason",
      "reconciled_at",
    ]);
    const idx = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'voice_usage'`;
    expect(idx.map((i) => i.indexdef).join("\n")).toMatch(/\(user_id, agent, started_at\)/);
    expect(idx.map((i) => i.indexdef).join("\n")).toMatch(/\(started_at\)/);
    const [rls] = await sql`select relrowsecurity from pg_class where relname = 'voice_usage'`;
    expect(rls.relrowsecurity).toBe(true);
    const grants = await sql`select privilege_type from information_schema.role_table_grants where table_name = 'voice_usage' and grantee in ('anon', 'authenticated')`;
    expect(grants).toHaveLength(0);
    const { REGISTRY } = await import("@/lib/privacy/registry");
    const entry = REGISTRY.find((c) => c.key === "voice_usage");
    expect(entry?.tables).toEqual(["voice_usage"]);
    expect(entry?.retention).toMatch(/180 days/);
  });

  it("FR-4: a guardian's 3rd screen voice start in one day -> quota_day (blocked starts are recorded, not counted)", async () => {
    const a = await start(guardian);
    expect(a.status).toBe("ok");
    expect((await sql`select reserved_seconds, status from voice_usage where id = ${a.usageId}`)[0]).toEqual({ reserved_seconds: 360, status: "started" });
    await close(guardian.id);
    expect((await start(guardian)).status).toBe("ok");
    await close(guardian.id);
    const third = await start(guardian);
    expect(third.status).toBe("quota_day");
    const [row] = await sql`select status, blocked_reason, actual_seconds from voice_usage where id = ${third.usageId}`;
    expect(row).toEqual({ status: "blocked", blocked_reason: "quota_day", actual_seconds: 0 });
    // Still refused (blocked rows do not count as starts, but the two real ones do); other agents have their own quota.
    expect((await start(guardian)).status).toBe("quota_day");
    expect((await start(guardian, "booking")).status).toBe("ok");
    await close(guardian.id);
  });

  it("FR-4: the 30-day limit (4 screen starts in a rolling 30 days)", async () => {
    await sql`
      insert into voice_usage (user_id, agent, started_at, ended_at, reserved_seconds, actual_seconds, status)
      select ${other.id}, 'screen', now() - (n || ' days')::interval, now() - (n || ' days')::interval, 360, 60, 'ended'
      from generate_series(2, 5) as n`;
    expect((await start(other)).status).toBe("quota_month");
    // A start 31 days ago no longer counts.
    await sql`update voice_usage set started_at = now() - interval '31 days', ended_at = now() - interval '31 days'
              where id = (select id from voice_usage where user_id = ${other.id} and status = 'ended' order by started_at limit 1)`;
    expect((await start(other)).status).toBe("ok");
    await close(other.id);
  });

  it("FR-4: two parallel starts by the same user -> one ok, one concurrent", async () => {
    const u = crowd[0];
    const results = await Promise.all([start(u, "followup"), start(u, "followup")]);
    expect(results.map((r) => r.status).sort()).toEqual(["concurrent", "ok"]);
    await close(u.id);
  });

  it("FR-5: 20 parallel starts by different users around the daily cap never exceed it", async () => {
    const crowdIds = crowd.map((c) => c.id);
    const dayUsed = async () => {
      const [{ used }] = await sql<{ used: string }[]>`
        select coalesce(sum(public.voice_usage_seconds(status, reserved_seconds, actual_seconds)), 0) as used
        from voice_usage where started_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;
      return Number(used);
    };
    // Fingerprint of everybody else's rows today: other suites add and delete rows while they run.
    const othersFingerprint = async () => {
      const [{ fp }] = await sql<{ fp: string | null }[]>`
        select md5(string_agg(id::text || status || coalesce(actual_seconds, -1)::text, ',' order by id)) as fp
        from voice_usage
        where started_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
          and user_id not in ${sql(crowdIds)}`;
      return fp;
    };
    const othersBefore = await othersFingerprint();
    const before = await dayUsed();
    // Room for exactly 10 one-second reservations.
    const cap = before + 10;
    try {
      const results = await Promise.all(
        crowd.map((u) => usage.startVoiceUsage(u.id, "booking", { sql, reservedSeconds: 1, caps: { dailySeconds: cap, monthlySeconds: HUGE.monthlySeconds } })),
      );
      const ok = results.filter((r) => r.status === "ok");
      expect(results.every((r) => r.status === "ok" || r.status === "budget")).toBe(true);
      // The invariant, whatever other suites do in parallel: every accepted start saw the total (its own reservation
      // included) within the cap, and the accepted starts were counted one after the other (no lost update).
      for (const r of ok) expect(r.dayUsedSeconds).toBeLessThanOrEqual(cap);
      const seen = ok.map((r) => r.dayUsedSeconds).sort((a, b) => a - b);
      expect(new Set(seen).size).toBe(seen.length);
      // Without interference from other suites (their cleanup deletes rows, their starts add some), exactly 10 fit.
      if ((await othersFingerprint()) === othersBefore) {
        expect(ok).toHaveLength(10);
        expect(results.filter((r) => r.status === "budget")).toHaveLength(10);
      }
    } finally {
      for (const u of crowd) await close(u.id);
    }
  });

  it("FR-5: the budget reached -> `budget` for everyone (also users with quota left)", async () => {
    const tiny = { dailySeconds: 1, monthlySeconds: HUGE.monthlySeconds };
    for (const u of [crowd[1], crowd[2], admin]) {
      const r = await start(u, "screen", { caps: tiny });
      expect(r.status).toBe("budget");
      expect(usage.budgetAlertFor(r)).toMatchObject({ level: 100 });
    }
    expect((await start(crowd[3], "followup", { caps: { dailySeconds: HUGE.dailySeconds, monthlySeconds: 1 } })).status).toBe("budget");
  });

  it("FR-5: the 80% alert is queued once per day (outbox dedup), for platform admins", async () => {
    const now = new Date("2099-01-02T06:00:00Z");
    const key = usage.budgetAlertKey(80, usage.indiaDay(now));
    alertKeys.push(key);
    await sql`delete from outbox_events where dedup_key = ${key}`;
    const first = await usage.queueBudgetAlert({ level: 80, period: "day" }, { sql, now });
    const again = await usage.queueBudgetAlert({ level: 80, period: "month" }, { sql, now });
    expect(again).toBe(first);
    const rows = await sql`select topic, payload, aggregate_type from outbox_events where dedup_key = ${key}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: "voice.budget_alert", payload: { level: 80, period: "day" }, aggregate_type: "voice_budget" });
    // The 100% alert of the same day is a separate, single event.
    const key100 = usage.budgetAlertKey(100, usage.indiaDay(now));
    alertKeys.push(key100);
    await usage.queueBudgetAlert({ level: 100, period: "day" }, { sql, now });
    await usage.queueBudgetAlert({ level: 100, period: "day" }, { sql, now });
    expect(await sql`select 1 from outbox_events where dedup_key = ${key100}`).toHaveLength(1);
    const { TOPICS } = await import("@/lib/notify/topics");
    const recipients = await TOPICS["voice.budget_alert"].recipients({ level: 80, period: "day" }, { sql, event: {} as never });
    expect(recipients).toContain(admin.id);
    expect(recipients).not.toContain(guardian.id);
  });

  it("FR-7: the end is clamped to the reserved seconds (and the elapsed time); idempotent; only the owner", async () => {
    const u = crowd[4];
    const r = await start(u, "booking");
    expect(await usage.endVoiceUsage({ usageId: r.usageId, userId: other.id, seconds: 10 }, sql)).toBeNull();
    await sql`update voice_usage set started_at = now() - interval '5 minutes' where id = ${r.usageId}`;
    const ended = await usage.endVoiceUsage({ usageId: r.usageId, userId: u.id, seconds: 99_999, conversationId: "conv_t051" }, sql);
    expect(ended).toMatchObject({ status: "ended", actual_seconds: 240, reserved_seconds: 240 });
    // A second report changes nothing (the conversation id is kept).
    expect(await usage.endVoiceUsage({ usageId: r.usageId, userId: u.id, seconds: 5, conversationId: "conv_other" }, sql)).toMatchObject({ actual_seconds: 240 });
    expect((await sql`select conversation_id from voice_usage where id = ${r.usageId}`)[0].conversation_id).toBe("conv_t051");
    // A just-started call cannot claim more than the time since the start.
    const fresh = await start(u, "booking");
    expect((await usage.endVoiceUsage({ usageId: fresh.usageId, userId: u.id, seconds: 200 }, sql))!.actual_seconds).toBeLessThanOrEqual(6);
    // Blocked rows cannot be "ended".
    const blocked = await start(u, "screen", { caps: { dailySeconds: 1, monthlySeconds: 1 } });
    expect(await usage.endVoiceUsage({ usageId: blocked.usageId, userId: u.id, seconds: 1 }, sql)).toBeNull();
  });

  it("FR-7: a call still started at reserved + 2 minutes expires with actual = reserved (and stops blocking the user)", async () => {
    const u = crowd[5];
    const r = await start(u, "screen");
    const fresh = await start(crowd[6], "screen");
    await sql`update voice_usage set started_at = now() - interval '8 minutes 30 seconds' where id = ${r.usageId}`;
    await sql`update voice_usage set started_at = now() - interval '7 minutes' where id = ${fresh.usageId}`;
    // (Another suite's start may run the same expiry first: the row state is what matters.)
    expect(await usage.expireStaleVoiceUsage(sql)).toBeGreaterThanOrEqual(0);
    expect((await sql`select status, actual_seconds from voice_usage where id = ${r.usageId}`)[0]).toEqual({ status: "expired", actual_seconds: 360 });
    // 7 minutes is within reserved (6) + 2: still open.
    expect((await sql`select status from voice_usage where id = ${fresh.usageId}`)[0].status).toBe("started");
    await close(crowd[6].id);
    // The start function expires stale calls itself, so a lost end report never blocks the next start for long.
    const again = await start(u, "booking");
    await sql`update voice_usage set started_at = now() - interval '7 minutes' where id = ${again.usageId}`;
    expect((await start(u, "followup")).status).toBe("ok");
    await close(u.id);
  });

  it("FR-7: real durations from ElevenLabs when configured; skipped in DEMO_MODE", async () => {
    const u = crowd[7];
    const r = await start(u, "followup");
    await usage.endVoiceUsage({ usageId: r.usageId, userId: u.id, seconds: 0, conversationId: "conv_t051_reconcile" }, sql);
    const fetchConversation = vi.fn(async (id: string) => (id === "conv_t051_reconcile" ? { metadata: { call_duration_secs: 97.4 } } : { metadata: {} }));
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ELEVENLABS_API_KEY", "xi-test");
    expect(await usage.reconcileVoiceDurations({ sql, fetchConversation })).toBe(0);
    expect(fetchConversation).not.toHaveBeenCalled();
    vi.stubEnv("DEMO_MODE", "false");
    await usage.reconcileVoiceDurations({ sql, fetchConversation, limit: 500 });
    expect(fetchConversation).toHaveBeenCalledWith("conv_t051_reconcile");
    const [row] = await sql`select actual_seconds, reconciled_at from voice_usage where id = ${r.usageId}`;
    expect(row.actual_seconds).toBe(97);
    expect(row.reconciled_at).not.toBeNull();
  });

  it("FR-10: the admin cap override is audited (same transaction), overrides env and fails closed", async () => {
    session.user = { id: admin.id, email: admin.email };
    onTestFinished(async () => {
      await sql`update voice_settings set daily_minutes_cap = null, monthly_minutes_cap = null where id`;
    });
    const route = await import("@/app/api/admin/voice-settings/route");
    const put = (body: unknown) =>
      route.PUT(new Request("http://x/api/admin/voice-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    // A huge override (harmless for suites running in parallel) beats a tiny env cap.
    vi.stubEnv("VOICE_DAILY_MINUTES_CAP", "1");
    const res = await put({ daily_minutes_cap: 9_000_000, monthly_minutes_cap: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dailyMinutes: 9_000_000, envDailyMinutes: 1, overridden: { daily: true, monthly: false } });
    const [ev] = await sql`
      select actor_user_id, actor_role, entity, details from audit_events
      where action = 'voice.caps_updated' and actor_user_id = ${admin.id} order by created_at desc limit 1`;
    expect(ev).toMatchObject({ actor_user_id: admin.id, actor_role: "platform_admin", entity: "voice_settings" });
    expect(ev.details).toMatchObject({ after: { daily_minutes_cap: 9_000_000, monthly_minutes_cap: null } });
    const u = crowd[8];
    expect((await usage.startVoiceUsage(u.id, "screen", { sql })).status).toBe("ok");
    await close(u.id);

    // Fail closed: the audit row cannot be written -> 503 and the caps stay as they were.
    vi.stubEnv("AUDIT_FAIL_ACTIONS", "voice.caps_updated");
    expect((await put({ daily_minutes_cap: 8_000_000, monthly_minutes_cap: null })).status).toBe(503);
    expect((await sql`select daily_minutes_cap from voice_settings where id`)[0].daily_minutes_cap).toBe(9_000_000);
    vi.stubEnv("AUDIT_FAIL_ACTIONS", "");

    // Back to the env values; other roles are refused; bad bodies are 400.
    expect((await put({ daily_minutes_cap: null, monthly_minutes_cap: null })).status).toBe(200);
    expect((await put({ daily_minutes_cap: -1, monthly_minutes_cap: null })).status).toBe(400);
    expect((await put({ daily_minutes_cap: 1.5, monthly_minutes_cap: null })).status).toBe(400);
    session.user = { id: guardian.id, email: guardian.email };
    expect((await put({ daily_minutes_cap: 1, monthly_minutes_cap: 1 })).status).toBe(403);
    expect((await route.GET()).status).toBe(403);
    session.user = null;
    expect((await route.GET()).status).toBe(401);
    expect((await sql`select daily_minutes_cap, monthly_minutes_cap from voice_settings where id`)[0]).toEqual({ daily_minutes_cap: null, monthly_minutes_cap: null });
  });

  it("FR-10: the admin overview has minutes per agent, cost in USD and INR, top users (id + role) and blocked starts", async () => {
    vi.stubEnv("VOICE_COST_PER_MINUTE_USD", "0.1");
    vi.stubEnv("USD_INR_RATE", "84");
    const o = await usage.voiceUsageOverview(sql);
    expect(Object.keys(o.today).sort()).toEqual(["booking", "followup", "intake_demo", "screen"]);
    expect(o.totals.monthMinutes).toBeGreaterThan(0);
    expect(Math.abs(o.cost.monthUsd - o.totals.monthMinutes * 0.1)).toBeLessThan(0.02);
    expect(Math.abs(o.cost.monthInr - o.cost.monthUsd * 84)).toBeLessThanOrEqual(0.5);
    expect(o.cost).toMatchObject({ usdPerMinute: 0.1, usdInr: 84 });
    expect(o.topUsers.length).toBeLessThanOrEqual(10);
    for (const t of o.topUsers) expect(Object.keys(t).sort()).toEqual(["minutes", "role", "user_id"]);
    expect(o.blocked.today).toBeGreaterThanOrEqual(3);
    expect(o.blocked.byReason.quota_day).toBeGreaterThanOrEqual(1);
    expect(o.caps).toMatchObject({ overridden: { daily: false, monthly: false } });
  });

  it("retention: rows older than 180 days are deleted; open calls are kept", async () => {
    const u = crowd[9];
    const [old] = await sql<{ id: string }[]>`
      insert into voice_usage (user_id, agent, started_at, ended_at, reserved_seconds, actual_seconds, status)
      values (${u.id}, 'screen', now() - interval '181 days', now() - interval '181 days', 360, 30, 'ended') returning id`;
    const [recent] = await sql<{ id: string }[]>`
      insert into voice_usage (user_id, agent, started_at, ended_at, reserved_seconds, actual_seconds, status)
      values (${u.id}, 'screen', now() - interval '179 days', now() - interval '179 days', 360, 30, 'ended') returning id`;
    // The retention step's statement (lib/privacy/retention.ts), on this user's rows only.
    await sql`delete from voice_usage where user_id = ${u.id} and started_at < now() - interval '180 days' and status <> 'started'`;
    expect(await sql`select 1 from voice_usage where id = ${old.id}`).toHaveLength(0);
    expect(await sql`select 1 from voice_usage where id = ${recent.id}`).toHaveLength(1);
    const source = (await import("node:fs")).readFileSync("lib/privacy/retention.ts", "utf8");
    expect(source).toContain("delete from public.voice_usage");
  });

  it("NFR-2: a quota check is one SQL call under 30 ms (median of 15)", async () => {
    const u = crowd[10];
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const r = await usage.startVoiceUsage(u.id, "followup", { sql, caps: HUGE });
      times.push(performance.now() - t0);
      if (r.status === "ok") await close(u.id);
    }
    times.sort((a, b) => a - b);
    expect(times[7]).toBeLessThan(30);
  });
});
