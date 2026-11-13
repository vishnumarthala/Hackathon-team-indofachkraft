// Ticket 032: transactional outbox, fan-out with access re-check, leases, retries, cancel, inbox/preferences/admin
// APIs and the cron route. Runs against the configured local Supabase (skipped without DATABASE_URL or with
// SKIP_DB_TESTS=1). Synthetic users only; WhatsApp/email senders are mocked (nothing leaves the machine).
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

type Outbox = typeof import("@/lib/notify/outbox");
type Worker = typeof import("@/lib/notify/worker");
type Types = typeof import("@/lib/notify/types");

const APP = "http://localhost:3000";

describe.skipIf(!enabled)("notifications outbox (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let sql2: Sql;
  let world: ReturnType<typeof createWorld>;
  let outbox: Outbox;
  let worker: Worker;
  let types: Types;
  let guardianA: TestUser;
  let guardianB: TestUser;
  let provider: TestUser;
  let admin: TestUser;
  const prefix = `t032-${randomUUID().slice(0, 8)}`;
  const key = (name: string) => `${prefix}:${name}`;
  const as = (user: TestUser | null) => {
    session.user = user;
  };

  /** Mock senders: count every delivery per notification id. */
  function countingSenders(counts: Map<string, number>, outcome: () => Promise<import("@/lib/notify/types").SendOutcome> = async () => ({ status: "sent", providerMessageId: "mock" })) {
    const sender = async ({ notification }: { notification: { id: string } }) => {
      counts.set(notification.id, (counts.get(notification.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return outcome();
    };
    return { email: sender, whatsapp: sender };
  }

  async function ping(user: TestUser, name: string, deliverAfter?: Date) {
    return outbox.enqueue(sql, {
      topic: "test.ping",
      aggregateType: "user",
      aggregateId: user.id,
      payload: {},
      dedupKey: key(name),
      deliverAfter,
    });
  }

  const rowsFor = (eventId: string) =>
    sql<{ id: string; recipient_user_id: string; channel: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date }[]>`
      select id, recipient_user_id, channel, status, attempts, last_error, next_attempt_at
      from notifications where event_id = ${eventId} order by channel, recipient_user_id`;

  beforeAll(async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 6, prepare: false, onnotice: () => {} });
    sql2 = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t032");
    outbox = await import("@/lib/notify/outbox");
    worker = await import("@/lib/notify/worker");
    types = await import("@/lib/notify/types");
    guardianA = await world.user("ga", "guardian");
    guardianB = await world.user("gb", "guardian");
    provider = await world.user("prov", "provider");
    admin = await world.user("admin", "platform_admin");
  });

  afterEach(() => as(null));

  afterAll(async () => {
    await sql`delete from outbox_events where dedup_key like ${`${prefix}:%`}`;
    await sql`delete from audit_events where action like 'notification.%' and actor_user_id in ${sql([guardianA.id, guardianB.id, provider.id, admin.id])}`;
    await world.cleanup();
    await sql.end({ timeout: 5 });
    await sql2.end({ timeout: 5 });
    vi.unstubAllEnvs();
  });

  it("enqueue commits with the caller's transaction: rollback -> no event; same dedup key -> one event", async () => {
    await expect(
      sql.begin(async (tx) => {
        await outbox.enqueue(tx, { topic: "test.ping", aggregateType: "user", aggregateId: guardianA.id, payload: {}, dedupKey: key("rollback") });
        throw new Error("domain write failed");
      }),
    ).rejects.toThrow("domain write failed");
    expect(await sql`select id from outbox_events where dedup_key = ${key("rollback")}`).toHaveLength(0);

    const first = await ping(guardianA, "dedup");
    const second = await ping(guardianA, "dedup");
    expect(second).toBe(first);
    expect(await sql`select id from outbox_events where dedup_key = ${key("dedup")}`).toHaveLength(1);

    // Non-transactional helper (supabase-js rpc) dedups the same way.
    const viaRpc = await outbox.enqueueEvent(
      { topic: "test.ping", aggregateType: "user", aggregateId: guardianA.id, payload: {}, dedupKey: key("dedup") },
      { drain: false },
    );
    expect(viaRpc).toBe(first);

    await expect(
      outbox.enqueue(sql, { topic: "iep.published", aggregateType: "iep_plan", aggregateId: randomUUID(), payload: { plan_id: randomUUID(), child_id: randomUUID(), child_name: "x" } as never, dedupKey: key("bad") }),
    ).rejects.toThrow(/Invalid payload/);
    await sql`delete from outbox_events where dedup_key = ${key("dedup")}`;
  });

  it("E-2: a scheduled event is not fanned out before deliver_after; outbox_cancel cancels it and its deliveries", async () => {
    const later = await ping(guardianA, "sched", new Date(Date.now() + 2 * 60_000));
    expect((await worker.fanOutDue(sql, { eventIds: [later], appUrl: APP })).events).toBe(0);
    expect(await rowsFor(later)).toHaveLength(0);
    await sql`update outbox_events set deliver_after = now() - interval '1 second' where id = ${later}`;
    expect((await worker.fanOutDue(sql, { eventIds: [later], appUrl: APP })).events).toBe(1);
    expect((await rowsFor(later)).map((r) => `${r.channel}:${r.status}`)).toEqual(["email:pending", "in_app:sent", "whatsapp:pending"]);

    // Cancel by prefix: a pending scheduled event and the unsent deliveries of a fanned-out one. `_` is literal.
    const pending = await ping(guardianA, "cancel-x_1", new Date(Date.now() + 60 * 60_000));
    await sql`update outbox_events set dedup_key = ${key("cancel-x_2")} where id = ${later}`;
    const other = await ping(guardianA, "cancel-xa3", new Date(Date.now() + 60 * 60_000));
    expect(await outbox.cancelEvents(key("cancel-x_"), sql)).toBe(1);
    const [p, o] = await Promise.all([pending, other].map(async (id) => (await sql`select status from outbox_events where id = ${id}`)[0].status));
    expect([p, o]).toEqual(["cancelled", "pending"]);
    expect((await rowsFor(later)).map((r) => `${r.channel}:${r.status}`)).toEqual(["email:cancelled", "in_app:sent", "whatsapp:cancelled"]);
    const counts = new Map<string, number>();
    await worker.sendDue(sql, { eventIds: [later], senders: countingSenders(counts) });
    expect(counts.size).toBe(0);
  });

  it("fan-out re-checks access: a guardian whose link was revoked after enqueue gets no row", async () => {
    const owner = await world.user("owner", "provider");
    const orgId = await world.org(owner, "Clinic");
    const { childId, caseId } = await world.kase(orgId);
    await world.link(childId, guardianA);
    const linkB = await world.link(childId, guardianB, "father");
    const id = await outbox.enqueue(sql, {
      topic: "iep.published",
      aggregateType: "iep_plan",
      aggregateId: randomUUID(),
      payload: { plan_id: randomUUID(), child_id: childId, case_id: caseId },
      dedupKey: key("iep"),
    });
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${linkB}`;
    await worker.fanOutDue(sql, { eventIds: [id], appUrl: APP });
    const rows = await rowsFor(id);
    expect(new Set(rows.map((r) => r.recipient_user_id))).toEqual(new Set([guardianA.id]));
    expect(rows.map((r) => r.channel)).toEqual(["email", "in_app", "whatsapp"]);
    const [inApp] = await sql`select title, body, link, locale from notifications where event_id = ${id} and channel = 'in_app'`;
    expect(inApp).toEqual({ title: "New plan", body: "Your child's therapist shared a new plan.", link: `/family/children/${childId}`, locale: "en" });

    // assessment.red_flag goes to the case org's providers only (not guardians, not other orgs).
    const flag = await outbox.enqueue(sql, {
      topic: "assessment.red_flag",
      aggregateType: "assessment",
      aggregateId: randomUUID(),
      payload: { assessment_id: randomUUID(), child_id: childId, case_id: caseId },
      dedupKey: key("flag"),
    });
    await worker.fanOutDue(sql, { eventIds: [flag], appUrl: APP });
    expect(new Set((await rowsFor(flag)).map((r) => r.recipient_user_id))).toEqual(new Set([owner.id]));
    expect((await rowsFor(flag)).map((r) => r.channel)).toEqual(["email", "in_app"]);
  });

  it("022 sharing.granted: enqueued in the grant transaction; grantee owners/admins only, re-checked at fan-out", async () => {
    const ownerA = await world.user("sowner", "provider");
    const ownerB = await world.user("gowner", "provider");
    const adminB = await world.user("gadmin", "provider");
    const memberB = await world.user("gmember", "provider");
    const orgA = await world.org(ownerA, "Source");
    const orgB = await world.org(ownerB, "Grantee");
    await world.member(orgB, memberB);
    await sql`insert into org_members (org_id, user_id, org_role) values (${orgB}, ${adminB.id}, 'admin')`;
    const { childId } = await world.kase(orgA);
    const { caseId: caseB } = await world.kase(orgB, { childId });
    const guardian = await world.user("sguardian", "guardian");
    const linkId = await world.link(childId, guardian);
    const grant = async () => {
      const [row] = await sql<{ g: { id: string } }[]>`
        select public.create_sharing_grant(${childId}, ${orgA}, ${orgB}, ${["reports"]}::text[], null, ${guardian.id}) as g`;
      const [event] = await sql<{ id: string; payload: Record<string, unknown> }[]>`
        select id, payload from outbox_events where topic = 'sharing.granted' and aggregate_id = ${row.g.id}`;
      return { grantId: row.g.id, event };
    };
    const recipients = async (eventId: string) =>
      (await sql<{ recipient_user_id: string; channel: string; link: string }[]>`
        select recipient_user_id, channel, link from notifications where event_id = ${eventId} order by channel`);

    // A failed grant transaction leaves no event.
    await expect(sql`select public.create_sharing_grant(${childId}, ${orgA}, ${orgA}, ${["reports"]}::text[], null, ${guardian.id})`).rejects.toThrow(/same_org/);

    const active = await grant();
    expect(active.event.payload).toEqual({ grant_id: active.grantId, child_id: childId, source_org_id: orgA, grantee_org_id: orgB, grantee_case_id: caseB });
    await worker.fanOutDue(sql, { eventIds: [active.event.id], appUrl: APP });
    const rows = await recipients(active.event.id);
    expect(new Set(rows.map((r) => r.recipient_user_id))).toEqual(new Set([ownerB.id, adminB.id]));
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(["email", "in_app"]));
    expect(rows.every((r) => r.link === `/cases/${caseB}/shared`)).toBe(true);
    const [inApp] = await sql`select title, body from notifications where event_id = ${active.event.id} and channel = 'in_app' limit 1`;
    expect(inApp.body).not.toContain("(synthetic)");

    // Revoked before fan-out -> no rows.
    const revoked = await grant();
    await sql`select public.revoke_sharing_grant(${childId}, ${revoked.grantId}, ${guardian.id})`;
    await worker.fanOutDue(sql, { eventIds: [revoked.event.id], appUrl: APP });
    expect(await recipients(revoked.event.id)).toHaveLength(0);

    // The granting guardian's link revoked before fan-out -> no rows.
    const unlinked = await grant();
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${linkId}`;
    await worker.fanOutDue(sql, { eventIds: [unlinked.event.id], appUrl: APP });
    expect(await recipients(unlinked.event.id)).toHaveLength(0);
    await sql`delete from outbox_events where topic = 'sharing.granted' and aggregate_id in ${sql([active.grantId, revoked.grantId, unlinked.grantId])}`;
  });

  it("NFR-2: two concurrent notifications_claim calls on two connections never return the same row", async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => ping(guardianB, `claim-${i}`)));
    await worker.fanOutDue(sql, { eventIds: ids, eventBatch: 100, appUrl: APP });
    const claimLoop = async (db: Sql) => {
      const got: string[] = [];
      for (;;) {
        const rows = await db<{ id: string }[]>`select id from notifications_claim(7, 60, ${ids}::bigint[])`;
        if (rows.length === 0) return got;
        got.push(...rows.map((r) => r.id));
      }
    };
    const [a, b] = await Promise.all([claimLoop(sql), claimLoop(sql2)]);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
    expect(a.length + b.length).toBe(60);

    // Crashed worker: its lease expires, another worker reclaims the row; the old lease can no longer record.
    const [victim] = await sql<{ id: string; locked_until: Date }[]>`select id, locked_until from notifications where id = ${a[0]}`;
    expect(await sql`select id from notifications_claim(100, 60, ${ids}::bigint[])`).toHaveLength(0);
    await sql`update notifications set locked_until = now() - interval '1 second' where id = ${victim.id}`;
    const reclaimed = await sql2<{ id: string; attempts: number; locked_until: Date }[]>`select id, attempts, locked_until from notifications_claim(100, 60, ${ids}::bigint[])`;
    expect(reclaimed.map((r) => [r.id, r.attempts])).toEqual([[victim.id, 2]]);
    const [stale] = await sql`select notification_complete(${victim.id}, ${victim.locked_until}, 'sent') as ok`;
    expect(stale.ok).toBe(false);
    const [fresh] = await sql`select notification_complete(${victim.id}, ${reclaimed[0].locked_until}, 'sent', 'mock') as ok`;
    expect(fresh.ok).toBe(true);
    await sql`delete from outbox_events where id in ${sql(ids)}`;
  });

  it("FR-5: transient failures retry after 1 min, 5 min, 30 min, 2 h, 12 h, then dead (audited); permanent -> dead at once", async () => {
    const id = await ping(provider, "retry");
    await worker.fanOutDue(sql, { eventIds: [id], appUrl: APP });
    const failing = { email: async () => { throw new types.NotifyError("email_internal", false, "Resend 500 for parent@example.test"); }, whatsapp: async () => ({ status: "skipped", reason: "whatsapp_not_configured" }) as const };
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const before = Date.now();
      await worker.sendDue(sql, { eventIds: [id], senders: failing });
      const [email] = (await rowsFor(id)).filter((r) => r.channel === "email");
      expect(email.attempts).toBe(attempt);
      if (attempt < 6) {
        expect(email.status).toBe("failed");
        expect(email.last_error).toMatch(/^email_internal: /);
        expect(email.last_error).not.toContain("example.test");
        delays.push(Math.round((email.next_attempt_at.getTime() - before) / 60_000));
        await sql`update notifications set next_attempt_at = now() where id = ${email.id}`;
      } else {
        expect(email.status).toBe("dead");
        const audit = await sql`select details from audit_events where action = 'notification.dead' and entity_id = ${email.id}`;
        expect(audit).toHaveLength(1);
        expect(audit[0].details).toMatchObject({ channel: "email", template: "test_ping", attempts: 6 });
        await sql`delete from audit_events where action = 'notification.dead' and entity_id = ${email.id}`;
      }
    }
    expect(delays).toEqual([1, 5, 30, 120, 720]);
    const [wa] = (await rowsFor(id)).filter((r) => r.channel === "whatsapp");
    expect([wa.status, wa.last_error]).toEqual(["skipped", "whatsapp_not_configured"]);

    const perm = await ping(provider, "permanent");
    await worker.fanOutDue(sql, { eventIds: [perm], appUrl: APP });
    await worker.sendDue(sql, {
      eventIds: [perm],
      senders: { email: async () => { throw new types.NotifyError("email_validation_error", true, "Invalid `to` field"); } },
    });
    const [email] = (await rowsFor(perm)).filter((r) => r.channel === "email");
    expect([email.status, email.attempts]).toEqual(["dead", 1]);
    await sql`delete from audit_events where action = 'notification.dead' and entity_id = ${email.id}`;
  });

  it("E-5 / NFR-2: two concurrent workers deliver 200 queued notifications exactly once", async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, (_, i) => ping(guardianB, `burst-${i}`)));
    await worker.fanOutDue(sql, { eventIds: ids, eventBatch: 200, appUrl: APP });
    const counts = new Map<string, number>();
    const senders = countingSenders(counts);
    const run = (db: Sql) => worker.runOutbox({ sql: db, eventIds: ids, sendBatch: 15, timeBudgetMs: 60_000, senders, appUrl: APP });
    const [r1, r2] = await Promise.all([run(sql), run(sql2)]);
    expect(counts.size).toBe(200);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(r1.sent + r2.sent).toBe(200);
    expect(r1.sent).toBeGreaterThan(0);
    expect(r2.sent).toBeGreaterThan(0);
    const [{ n }] = await sql`select count(*)::int as n from notifications where event_id in ${sql(ids)} and channel <> 'in_app' and status = 'sent'`;
    expect(n).toBe(200);
    await sql`delete from outbox_events where id in ${sql(ids)}`;
  });

  it("E-3: email off -> email skipped (opted_out), in-app still delivered; WhatsApp skipped without config", async () => {
    const { PUT, GET } = await import("@/app/api/notification-preferences/route");
    as(null);
    expect((await PUT(post("http://x/api/notification-preferences", { email: false, whatsapp: true }, "PUT"))).status).toBe(401);
    as(guardianA);
    expect((await PUT(post("http://x/api/notification-preferences", { email: false, whatsapp: true, role: "x" }, "PUT"))).status).toBe(400);
    const res = await PUT(post("http://x/api/notification-preferences", { email: false, whatsapp: true }, "PUT"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preferences: { email: false, whatsapp: true } });
    expect(await (await GET()).json()).toEqual({ preferences: { email: false, whatsapp: true } });

    vi.stubEnv("WHATSAPP_TOKEN", "");
    const id = await ping(guardianA, "prefs");
    await worker.runOutbox({ eventIds: [id], sql, appUrl: APP });
    const rows = await rowsFor(id);
    expect(rows.map((r) => `${r.channel}:${r.status}:${r.last_error}`)).toEqual([
      "email:skipped:opted_out",
      "in_app:sent:null",
      "whatsapp:skipped:whatsapp_not_configured",
    ]);
    await PUT(post("http://x/api/notification-preferences", { email: true, whatsapp: false }, "PUT"));
  });

  it("E-1 / E-4: inbox API returns own in-app rows only; read with someone else's ids changes nothing; pagination", async () => {
    const { GET } = await import("@/app/api/notifications/route");
    const { POST: READ } = await import("@/app/api/notifications/read/route");
    const ids = [];
    for (let i = 0; i < 22; i += 1) ids.push(await ping(guardianA, `inbox-${i}`));
    await worker.fanOutDue(sql, { eventIds: ids, eventBatch: 100, appUrl: APP });
    const aRows = await sql<{ id: string }[]>`select id from notifications where event_id in ${sql(ids)} and channel = 'in_app'`;

    as(null);
    expect((await GET(new Request("http://x/api/notifications"))).status).toBe(401);

    as(guardianB);
    const bView = await (await GET(new Request("http://x/api/notifications"))).json();
    expect(bView.items.map((i: { id: string }) => i.id).filter((id: string) => aRows.some((r) => r.id === id))).toEqual([]);
    const tamper = await READ(post("http://x/api/notifications/read", { ids: aRows.slice(0, 3).map((r) => r.id) }));
    expect(tamper.status).toBe(200);
    expect((await tamper.json()).updated).toBe(0);
    expect(await sql`select id from notifications where id in ${sql(aRows.map((r) => r.id))} and read_at is not null`).toHaveLength(0);

    as(guardianA);
    const page1 = await (await GET(new Request("http://x/api/notifications"))).json();
    expect(page1.items).toHaveLength(20);
    expect(page1.unread).toBeGreaterThanOrEqual(22);
    expect(Object.keys(page1.items[0]).sort()).toEqual(["body", "created_at", "id", "link", "read_at", "title"]);
    const page2 = await (await GET(new Request(`http://x/api/notifications?cursor=${page1.next_cursor}`))).json();
    const seen = [...page1.items, ...page2.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    for (const row of aRows) expect(seen).toContain(row.id);
    expect((await GET(new Request("http://x/api/notifications?cursor=nope"))).status).toBe(400);

    expect((await READ(post("http://x/api/notifications/read", {}))).status).toBe(400);
    const one = await (await READ(post("http://x/api/notifications/read", { ids: [aRows[0].id] }))).json();
    expect(one.updated).toBe(1);
    const all = await (await READ(post("http://x/api/notifications/read", { all: true }))).json();
    expect(all.unread).toBe(0);

    const { unreadCount } = await import("@/lib/notify/inbox");
    expect(await unreadCount(guardianA.id)).toBe(0);
  });

  it("FR-9: platform admin retries a dead notification (audited); other roles are refused", async () => {
    const { POST } = await import("@/app/api/admin/notifications/[id]/retry/route");
    const id = await ping(provider, "admin-retry");
    await worker.fanOutDue(sql, { eventIds: [id], appUrl: APP });
    const [email] = (await rowsFor(id)).filter((r) => r.channel === "email");
    await sql`update notifications set status = 'dead', attempts = 6, last_error = 'email_internal: x' where id = ${email.id}`;
    const call = (nid: string) => POST(post(`http://x/api/admin/notifications/${nid}/retry`), ctx({ id: nid }));
    as(provider);
    expect((await call(email.id)).status).toBe(403);
    as(admin);
    expect((await call(randomUUID())).status).toBe(404);
    expect((await call(email.id)).status).toBe(200);
    const [row] = await sql`select status, attempts, last_error from notifications where id = ${email.id}`;
    expect(row).toEqual({ status: "pending", attempts: 0, last_error: null });
    expect(await sql`select 1 from audit_events where action = 'notification.retried' and entity_id = ${email.id} and actor_user_id = ${admin.id}`).toHaveLength(1);
    expect((await call(email.id)).status).toBe(404);

    const { adminOverview } = await import("@/lib/notify/inbox");
    await sql`update notifications set status = 'dead' where id = ${email.id}`;
    const overview = await adminOverview(sql);
    const problem = overview.problems.find((p) => p.id === email.id);
    expect(problem).toMatchObject({ channel: "email", status: "dead", topic: "test.ping" });
    expect(Object.keys(problem ?? {})).not.toContain("body");
    expect(overview.counts.email.dead).toBeGreaterThanOrEqual(1);
  });

  it("FR-4: cron route needs the bearer secret; with it, it fans out and delivers", async () => {
    const { POST, GET } = await import("@/app/api/cron/outbox/route");
    vi.stubEnv("CRON_SECRET", "test-secret-032");
    const req = (auth?: string) => new Request("http://x/api/cron/outbox", { method: "POST", headers: auth ? { Authorization: auth } : {} });
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req("Bearer wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(req("Bearer "))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "test-secret-032");

    const id = await ping(guardianB, "cron");
    const res = await GET(new Request("http://x/api/cron/outbox", { headers: { Authorization: "Bearer test-secret-032" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["failed", "fanned_out", "sent", "skipped"]);
    expect(body.fanned_out).toBeGreaterThanOrEqual(1);
    expect((await rowsFor(id)).map((r) => `${r.channel}:${r.status}`)).toEqual(["email:sent", "in_app:sent", "whatsapp:skipped"]);
    const [email] = await sql`select provider_message_id from notifications where event_id = ${id} and channel = 'email'`;
    expect(email.provider_message_id).toBe("demo");
  });

  it("028 provider decisions emit outbox events in the deciding transaction and reach the provider", async () => {
    const profileId = randomUUID();
    await sql`insert into provider_profiles (id, user_id, slug, display_name, provider_type, verification_status)
              values (${profileId}, ${provider.id}, ${`t032-${profileId.slice(0, 8)}`}, 'Dr Synthetic (t032)', 'pediatrician', 'verified')`;
    try {
      await expect(
        sql.begin(async (tx) => {
          await tx`update provider_profiles set verification_status = 'suspended' where id = ${profileId}`;
          throw new Error("rolled back");
        }),
      ).rejects.toThrow();
      expect(await sql`select 1 from outbox_events where aggregate_id = ${profileId}`).toHaveLength(0);
      await sql`update provider_profiles set verification_status = 'suspended' where id = ${profileId}`;
      const [event] = await sql<{ id: string; topic: string }[]>`select id, topic from outbox_events where aggregate_id = ${profileId}`;
      expect(event.topic).toBe("provider.suspended");
      await worker.fanOutDue(sql, { eventIds: [event.id], appUrl: APP });
      const rows = await sql`select recipient_user_id, channel, link from notifications where event_id = ${event.id} order by channel`;
      expect(rows).toEqual([
        { recipient_user_id: provider.id, channel: "email", link: "/dashboard/profile" },
        { recipient_user_id: provider.id, channel: "in_app", link: "/dashboard/profile" },
      ]);
    } finally {
      await sql`delete from outbox_events where aggregate_id = ${profileId}`;
      await sql`delete from provider_profiles where id = ${profileId}`;
    }
  });
});
