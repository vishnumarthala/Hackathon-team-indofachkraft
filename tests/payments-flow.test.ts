// Ticket 031 against the real database through the route handlers: payment order (FR-3) + authz negatives (E-5),
// demo checkout + signature verification (FR-4), signed + deduplicated webhooks (FR-5, E-2), apply_payment_captured
// idempotency and late payments (FR-6, E-3), cancellation refunds (FR-7, E-4), the refund job (lease, retry,
// notification), reschedules, strict audit (041) and the privacy registry (NFR-3). DEMO_MODE gateway; synthetic users
// only; skipped without DATABASE_URL.
import { createHmac, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, futureSlot, key, type TestProvider } from "./helpers/booking";
import { ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => ({ get: () => null }),
}));

const KEY_SECRET = "t031_key_secret_synthetic";
const WEBHOOK_SECRET = "t031_webhook_secret_synthetic";
const CRON_SECRET = "t031-cron";
const REFUND_TEXT = "Your payment was refunded because the time was no longer available.";

type Json = Record<string, unknown>;
async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

describe.skipIf(!enabled)("payments flow (database, route handlers)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let providerA: TestProvider;
  let online500: string;
  let free30: string;
  let guardianA: { user: TestUser; childId: string };
  let guardianB: { user: TestUser; childId: string };
  let slotStep = 0;
  let routes: {
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    cancel: typeof import("@/app/api/appointments/[id]/cancel/route");
    reschedule: typeof import("@/app/api/appointments/[id]/reschedule/route");
    order: typeof import("@/app/api/appointments/[id]/payment-order/route");
    verify: typeof import("@/app/api/payments/verify/route");
    demo: typeof import("@/app/api/payments/demo/route");
    webhook: typeof import("@/app/api/webhooks/razorpay/route");
    bookingCron: typeof import("@/app/api/cron/booking/route");
    paymentsCron: typeof import("@/app/api/cron/payments/route");
  };

  const as = (user: TestUser | null) => {
    session.user = user;
  };
  /** A fresh 30-minute grid slot ~30-60 h ahead (each test gets its own). */
  const nextSlot = (hours = 30) => futureSlot(hours, 30, slotStep++ * 3);

  const hold = (serviceId: string, start: Date) =>
    call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: serviceId, start: start.toISOString(), idempotency_key: key() }));
  const confirm = (id: string, childId: string) => call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: childId }), { id });
  const cancel = (id: string) => call(routes.cancel.POST, post(`http://localhost/api/appointments/${id}/cancel`, {}), { id });
  const order = (id: string) => call(routes.order.POST, post(`http://localhost/api/appointments/${id}/payment-order`), { id });
  const demo = (id: string, outcome: "success" | "failure") => call(routes.demo.POST, post("http://localhost/api/payments/demo", { appointment_id: id, outcome }));
  const verify = (body: Json) => call(routes.verify.POST, post("http://localhost/api/payments/verify", body));
  const status = async (id: string) => (await sql<{ status: string }[]>`select status from appointments where id = ${id}`)[0]?.status;
  const paymentOf = async (appointmentId: string) =>
    (await sql<{ id: string; status: string; razorpay_order_id: string; razorpay_payment_id: string | null; refund_reason: string | null; refund_id: string | null; failure_reason: string | null; appointment_id: string }[]>`
      select id, status, razorpay_order_id, razorpay_payment_id, refund_reason, refund_id, failure_reason, appointment_id
      from payments where appointment_id = ${appointmentId} order by (status <> 'failed') desc, created_at desc limit 1`)[0];
  const confirmedEvents = (id: string) => sql<{ id: string; status: string }[]>`
    select id::text, status from outbox_events where topic = 'appointment.confirmed' and dedup_key = ${`appt:${id}:confirmed`}`;

  /** A pending_payment appointment of the online ₹500 service for `g`, with its order created. */
  async function pendingWithOrder(g: { user: TestUser; childId: string }, start = nextSlot()) {
    as(g.user);
    const h = await hold(online500, start);
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    const id = h.json.appointment_id as string;
    const c = await confirm(id, g.childId);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect((c.json.appointment as Json).status).toBe("pending_payment");
    const o = await order(id);
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    return { id, start, orderId: o.json.order_id as string };
  }

  /** Demo checkout success -> verify (the real success-handler path). */
  async function payDemo(g: { user: TestUser }, id: string) {
    as(g.user);
    const d = await demo(id, "success");
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    return verify(d.json);
  }

  async function paid(g = guardianA, start = nextSlot()) {
    const p = await pendingWithOrder(g, start);
    const v = await payDemo(g, p.id);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json.appointment_status).toBe("confirmed");
    return p;
  }

  function webhookRequest(body: string, opts: { eventId?: string; signature?: string | null } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const signature = opts.signature === undefined ? createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") : opts.signature;
    if (signature !== null) headers["x-razorpay-signature"] = signature;
    headers["x-razorpay-event-id"] = opts.eventId ?? `evt_t031${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    return new Request("http://localhost/api/webhooks/razorpay", { method: "POST", headers, body });
  }
  const webhook = (body: string, opts: { eventId?: string; signature?: string | null } = {}) => call(routes.webhook.POST, webhookRequest(body, opts));
  const capturedBody = (orderId: string, paymentId: string, amount = 50000, extra: Json = {}) =>
    JSON.stringify({
      entity: "event",
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, entity: "payment", order_id: orderId, amount, currency: "INR", status: "captured", method: "card", ...extra } } },
      created_at: Math.floor(Date.now() / 1000),
    });
  const newPaymentId = () => `pay_T031${randomUUID().replace(/-/g, "").slice(0, 14)}`;

  async function expire(id: string) {
    await sql`update appointments set hold_expires_at = now() - interval '1 minute' where id = ${id}`;
    const res = await call(routes.bookingCron.POST, new Request("http://localhost/api/cron/booking", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    expect(await status(id)).toBe("expired");
  }

  async function runRefunds() {
    const res = await call(routes.paymentsCron.POST, new Request("http://localhost/api/cron/payments", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    return res.json;
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    sql = postgres(process.env.DATABASE_URL as string, { max: 6, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t031p");
    providerA = await world.provider("pa");
    online500 = await world.service(providerA, { duration: 30, payment: "online", fee: 500, name: "Speech assessment online (synthetic)" });
    free30 = await world.service(providerA, { duration: 30, payment: "free" });
    guardianA = await world.guardian("ga");
    guardianB = await world.guardian("gb");
    routes = {
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      cancel: await import("@/app/api/appointments/[id]/cancel/route"),
      reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
      order: await import("@/app/api/appointments/[id]/payment-order/route"),
      verify: await import("@/app/api/payments/verify/route"),
      demo: await import("@/app/api/payments/demo/route"),
      webhook: await import("@/app/api/webhooks/razorpay/route"),
      bookingCron: await import("@/app/api/cron/booking/route"),
      paymentsCron: await import("@/app/api/cron/payments/route"),
    };
  });

  beforeEach(async () => {
    const { holdLimiter, slotsLimiter } = await import("@/lib/booking/rate-limit");
    holdLimiter.reset();
    slotsLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    (await import("@/lib/payments/razorpay")).setPaymentGatewayForTests(null);
    if (sql && providerA) {
      const pays = await sql<{ id: string }[]>`
        select p.id from payments p join appointments a on a.id = p.appointment_id where a.provider_profile_id = ${providerA.profileId}`;
      const ids = pays.map((p) => p.id);
      await sql`delete from payment_events where razorpay_event_id like 'evt_t031%' ${ids.length ? sql`or payment_id in ${sql(ids)}` : sql``}`;
      if (ids.length) {
        await sql`delete from outbox_events where aggregate_type = 'payment' and aggregate_id in ${sql(ids)}`;
        await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'payment' and entity_id in ${tx(ids)}`);
        await sql`delete from payments where id in ${sql(ids)}`;
      }
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  // ---------- FR-3 / E-5 ----------

  describe("payment order (FR-3) and authz (E-5)", () => {
    it("creates one order per appointment: amount = fee * 100, key id rzp_test_, prefill name; repeat -> same order", async () => {
      const p = await pendingWithOrder(guardianA);
      as(guardianA.user);
      const again = await order(p.id);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ order_id: p.orderId, amount_paise: 50000, currency: "INR", demo: true });
      expect(String(again.json.key_id).startsWith("rzp_test_")).toBe(true);
      expect(again.json.prefill).toHaveProperty("name");
      const rows = await sql`select status, amount_paise, gateway from payments where appointment_id = ${p.id}`;
      expect(rows).toEqual([{ status: "created", amount_paise: 50000, gateway: "demo" }]);
    });

    it("guardian_b -> 404 for guardian_a's appointment (order, demo, verify); anonymous 401", async () => {
      const p = await pendingWithOrder(guardianA);
      as(guardianB.user);
      expect((await order(p.id)).status).toBe(404);
      expect((await demo(p.id, "success")).status).toBe(404);
      as(guardianA.user);
      const d = await demo(p.id, "success");
      as(guardianB.user);
      expect((await verify(d.json)).status).toBe(404);
      expect(await status(p.id)).toBe("pending_payment");
      as(null);
      expect((await order(p.id)).status).toBe(401);
    });

    it("a confirmed free appointment -> 409; an expired one -> 410", async () => {
      as(guardianA.user);
      const h = await hold(free30, nextSlot());
      await confirm(h.json.appointment_id as string, guardianA.childId);
      const res = await order(h.json.appointment_id as string);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("not_payable");
      const p = await pendingWithOrder(guardianA);
      await sql`update appointments set hold_expires_at = now() - interval '1 second' where id = ${p.id}`;
      as(guardianA.user);
      expect((await order(p.id)).status).toBe(410);
    });
  });

  // ---------- FR-4 / FR-6 / E-1 ----------

  describe("checkout (FR-4) and the capture path (FR-6)", () => {
    it("E-1: demo success -> verify -> appointment confirmed, payment captured, confirmation enqueued; webhook replay -> duplicate", async () => {
      const p = await pendingWithOrder(guardianA);
      const v = await payDemo(guardianA, p.id);
      expect(v.status, JSON.stringify(v.json)).toBe(200);
      expect(v.json).toMatchObject({ appointment_status: "confirmed", payment_status: "captured", outcome: "confirmed" });
      expect(await status(p.id)).toBe("confirmed");
      const pay = await paymentOf(p.id);
      expect(pay.status).toBe("captured");
      expect(pay.razorpay_payment_id).toMatch(/^pay_DEMO/);
      expect(await confirmedEvents(p.id)).toHaveLength(1);
      const history = await sql`select from_status, to_status, actor_kind, reason from appointment_events where appointment_id = ${p.id} order by id`;
      expect(history.at(-1)).toMatchObject({ from_status: "pending_payment", to_status: "confirmed", actor_kind: "guardian", reason: "payment_captured" });
      const audits = await sql`select action, actor_role from audit_events where entity = 'payment' and entity_id = ${pay.id} order by id`;
      expect(audits).toEqual([
        { action: "payment.order_created", actor_role: "guardian" },
        { action: "payment.captured", actor_role: "guardian" },
      ]);
      // Payment page state: a second order request -> already paid.
      as(guardianA.user);
      expect((await order(p.id)).status).toBe(409);

      // The same capture arrives as a webhook, then that webhook is replayed.
      const body = capturedBody(p.orderId, pay.razorpay_payment_id as string);
      const eventId = `evt_t031${randomUUID().replace(/-/g, "").slice(0, 14)}`;
      const first = await webhook(body, { eventId });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ received: true, outcome: "already_captured" });
      const replay = await webhook(body, { eventId });
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual({ received: true, duplicate: true });
      expect(await sql`select outcome from payment_events where razorpay_event_id = ${eventId}`).toEqual([{ outcome: "already_captured" }]);
      expect(await confirmedEvents(p.id)).toHaveLength(1);
      expect(await sql`select 1 from audit_events where entity = 'payment' and entity_id = ${pay.id} and action = 'payment.captured'`).toHaveLength(1);
    });

    it("a wrong checkout signature -> 400 and nothing changes", async () => {
      const p = await pendingWithOrder(guardianA);
      as(guardianA.user);
      const d = await demo(p.id, "success");
      const bad = { ...d.json, razorpay_signature: createHmac("sha256", "wrong-secret").update(`${p.orderId}|${d.json.razorpay_payment_id}`).digest("hex") };
      const res = await verify(bad);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("invalid_signature");
      const tampered = await verify({ ...d.json, razorpay_payment_id: newPaymentId() });
      expect(tampered.status).toBe(400);
      expect(await status(p.id)).toBe("pending_payment");
      expect((await paymentOf(p.id)).status).toBe("created");
    });

    it("apply_payment_captured called 3x -> one capture, one confirmation, one outbox event", async () => {
      const p = await pendingWithOrder(guardianA);
      const paymentId = newPaymentId();
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [row] = await sql<{ r: Json }[]>`select payment_apply_captured(${p.orderId}, ${paymentId}) as r`;
        outcomes.push(row.r.outcome as string);
      }
      expect(outcomes).toEqual(["confirmed", "already_captured", "already_captured"]);
      expect(await confirmedEvents(p.id)).toHaveLength(1);
      expect(await sql`select 1 from appointment_events where appointment_id = ${p.id} and to_status = 'confirmed'`).toHaveLength(1);
      expect((await paymentOf(p.id)).status).toBe("captured");
    });

    it("concurrent captures (5 connections) -> exactly one confirmation", async () => {
      const p = await pendingWithOrder(guardianA);
      const paymentId = newPaymentId();
      const conns = Array.from({ length: 5 }, () => postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, onnotice: () => {} }));
      try {
        const results = await Promise.all(conns.map((c) => c<{ r: Json }[]>`select payment_apply_captured(${p.orderId}, ${paymentId}) as r`));
        const outcomes = results.map(([row]) => row.r.outcome).sort();
        expect(outcomes).toEqual(["already_captured", "already_captured", "already_captured", "already_captured", "confirmed"]);
      } finally {
        await Promise.all(conns.map((c) => c.end({ timeout: 5 })));
      }
      expect(await confirmedEvents(p.id)).toHaveLength(1);
    });

    it("demo failure -> payment failed; the next order request reuses the same order; then success confirms", async () => {
      const p = await pendingWithOrder(guardianA);
      as(guardianA.user);
      expect((await demo(p.id, "failure")).status).toBe(200);
      const failed = await paymentOf(p.id);
      expect(failed.status).toBe("failed");
      expect(failed.failure_reason).toContain("DEMO_DECLINED");
      expect(await status(p.id)).toBe("pending_payment");
      const again = await order(p.id);
      expect(again.json.order_id).toBe(p.orderId);
      expect((await paymentOf(p.id)).status).toBe("created");
      const v = await payDemo(guardianA, p.id);
      expect(v.json.appointment_status).toBe("confirmed");
      expect(await sql`select count(*)::int as n from payments where appointment_id = ${p.id}`).toEqual([{ n: 1 }]);
    });

    it("strict audit (041): an audit failure on payment.captured -> 503 and nothing changes", async () => {
      const p = await pendingWithOrder(guardianA);
      as(guardianA.user);
      const d = await demo(p.id, "success");
      vi.stubEnv("AUDIT_FAIL_ACTIONS", "payment.captured");
      try {
        const res = await verify(d.json);
        expect(res.status).toBe(503);
      } finally {
        vi.stubEnv("AUDIT_FAIL_ACTIONS", "");
      }
      expect(await status(p.id)).toBe("pending_payment");
      expect((await paymentOf(p.id)).status).toBe("created");
      expect(await confirmedEvents(p.id)).toHaveLength(0);
    });
  });

  // ---------- FR-5 / E-2 ----------

  describe("webhooks (FR-5, E-2)", () => {
    it("wrong signature / tampered body / no signature -> 401, nothing stored", async () => {
      const p = await pendingWithOrder(guardianA);
      const body = capturedBody(p.orderId, newPaymentId());
      for (const [label, req] of [
        ["wrong secret", webhookRequest(body, { eventId: "evt_t031badsig000001", signature: createHmac("sha256", "wrong").update(body).digest("hex") })],
        ["tampered", webhookRequest(body.replace("50000", "100"), { eventId: "evt_t031badsig000002", signature: createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") })],
        ["missing", webhookRequest(body, { eventId: "evt_t031badsig000003", signature: null })],
      ] as const) {
        const res = await call(routes.webhook.POST, req);
        expect(res.status, label).toBe(401);
      }
      expect(await sql`select 1 from payment_events where razorpay_event_id like 'evt_t031badsig%'`).toHaveLength(0);
      expect(await status(p.id)).toBe("pending_payment");
      expect((await paymentOf(p.id)).status).toBe("created");
    });

    it("payment.captured webhook confirms; unknown event types and unknown orders -> 200 ignored; missing event id -> 400", async () => {
      const p = await pendingWithOrder(guardianA);
      const res = await webhook(capturedBody(p.orderId, newPaymentId(), 50000, { vpa: "synthetic@okbank", email: "parent@example.test", contact: "+919876543210", card: { last4: "1111" } }));
      expect(res.status).toBe(200);
      expect(res.json.outcome).toBe("confirmed");
      expect(await status(p.id)).toBe("confirmed");
      const [stored] = await sql<{ payload: Json; event_type: string; processed_at: Date | null }[]>`
        select payload, event_type, processed_at from payment_events where payment_id = (select id from payments where appointment_id = ${p.id})`;
      expect(stored.event_type).toBe("payment.captured");
      expect(stored.processed_at).not.toBeNull();
      expect(JSON.stringify(stored.payload)).not.toMatch(/okbank|example\.test|9876543210|1111/);

      const unknown = await webhook(JSON.stringify({ event: "settlement.processed", payload: {} }));
      expect(unknown.status).toBe(200);
      expect(unknown.json).toMatchObject({ received: true, outcome: "ignored", ignored: "settlement.processed" });
      const foreign = await webhook(capturedBody("order_NotOurs031abcd", newPaymentId()));
      expect(foreign.status).toBe(200);
      expect(foreign.json.outcome).toBe("unknown_order");
      const body = JSON.stringify({ event: "payment.captured", payload: {} });
      const noId = await call(
        routes.webhook.POST,
        new Request("http://localhost/api/webhooks/razorpay", { method: "POST", headers: { "x-razorpay-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") }, body }),
      );
      expect(noId.status).toBe(400);
    });

    it("payment.authorized records the payment; payment.failed marks the attempt failed (appointment keeps waiting)", async () => {
      const p = await pendingWithOrder(guardianA);
      const paymentId = newPaymentId();
      const auth = await webhook(JSON.stringify({ event: "payment.authorized", payload: { payment: { entity: { id: paymentId, order_id: p.orderId, amount: 50000, status: "authorized" } } } }));
      expect(auth.json.outcome).toBe("authorized");
      expect(await paymentOf(p.id)).toMatchObject({ status: "authorized", razorpay_payment_id: paymentId });
      const failed = await webhook(
        JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: newPaymentId(), order_id: p.orderId, status: "failed", error_code: "BAD_REQUEST_ERROR", error_reason: "payment_failed", vpa: "x@okbank" } } } }),
      );
      expect(failed.json.outcome).toBe("failed");
      const row = await paymentOf(p.id);
      expect(row.status).toBe("failed");
      expect(row.failure_reason).toBe("BAD_REQUEST_ERROR: payment_failed");
      expect(await status(p.id)).toBe("pending_payment");
    });

    it("a captured amount different from the order -> refund, appointment not confirmed", async () => {
      const p = await pendingWithOrder(guardianA);
      const res = await webhook(capturedBody(p.orderId, newPaymentId(), 100));
      expect(res.json.outcome).toBe("refund_amount_mismatch");
      expect(await status(p.id)).toBe("pending_payment");
      expect(await paymentOf(p.id)).toMatchObject({ status: "refund_pending", refund_reason: "amount_mismatch" });
    });
  });

  // ---------- FR-6 late payments / E-3 ----------

  describe("late payment after the hold expired (FR-6, E-3)", () => {
    it("E-3.1: slot still free -> the same appointment is confirmed", async () => {
      const p = await pendingWithOrder(guardianA);
      await expire(p.id);
      const res = await webhook(capturedBody(p.orderId, newPaymentId()));
      expect(res.status).toBe(200);
      expect(res.json.outcome).toBe("late_confirmed");
      expect(await status(p.id)).toBe("confirmed");
      expect((await paymentOf(p.id)).status).toBe("captured");
      expect(await confirmedEvents(p.id)).toHaveLength(1);
      const [last] = await sql`select from_status, to_status, actor_kind, reason from appointment_events where appointment_id = ${p.id} order by id desc limit 1`;
      expect(last).toMatchObject({ from_status: "expired", to_status: "confirmed", actor_kind: "system", reason: "late_payment" });
    });

    it("E-3.2: guardian_b booked the slot first -> refund_pending -> refunded (job), guardian_a notified, guardian_b untouched", async () => {
      const start = nextSlot();
      const a = await pendingWithOrder(guardianA, start);
      await expire(a.id);
      const b = await pendingWithOrder(guardianB, start);
      const bBefore = await sql`select status, slot::text, hold_expires_at from appointments where id = ${b.id}`;

      const res = await webhook(capturedBody(a.orderId, newPaymentId()));
      expect(res.json.outcome).toBe("refund_slot_unavailable");
      expect(await status(a.id)).toBe("expired");
      expect(await paymentOf(a.id)).toMatchObject({ status: "refund_pending", refund_reason: "slot_unavailable" });

      const jobs = await runRefunds();
      expect(jobs.refunded).toBeGreaterThanOrEqual(1);
      const pay = await paymentOf(a.id);
      expect(pay.status).toBe("refunded");
      expect(pay.refund_id).toMatch(/^rfnd_DEMO/);
      expect(await sql`select status, slot::text, hold_expires_at from appointments where id = ${b.id}`).toEqual(bBefore);

      const [event] = await sql<{ id: string; payload: Json }[]>`select id::text, payload from outbox_events where dedup_key = ${`payment:${pay.id}:refunded`}`;
      expect(event.payload).toEqual({ payment_id: pay.id, appointment_id: a.id, reason: "slot_unavailable" });
      const { fanOutDue } = await import("@/lib/notify/worker");
      await fanOutDue(sql, { eventIds: [event.id] });
      const notes = await sql<{ recipient_user_id: string; channel: string; body: string; link: string }[]>`
        select recipient_user_id, channel, body, link from notifications where event_id = ${event.id} order by channel`;
      expect(notes.map((n) => n.recipient_user_id)).toEqual([guardianA.user.id, guardianA.user.id]);
      expect(notes.find((n) => n.channel === "in_app")).toMatchObject({ body: REFUND_TEXT, link: "/family/appointments" });
      expect(await sql`select 1 from audit_events where entity = 'payment' and entity_id = ${pay.id} and action = 'payment.refunded'`).toHaveLength(1);

      // The refund shows on guardian_a's list (expired booking with a refunded payment).
      const { listGuardianAppointments } = await import("@/lib/booking/store");
      expect((await listGuardianAppointments(guardianA.user.id)).some((x) => x.id === a.id)).toBe(true);
      // A second job run and a refund.processed webhook are no-ops.
      expect((await runRefunds()).refunded).toBe(0);
      const again = await webhook(JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: pay.refund_id, payment_id: pay.razorpay_payment_id, amount: 50000, status: "processed" } } } }));
      expect(again.json.outcome).toBe("already_refunded");
    });

    it("a payment for an appointment the guardian cancelled -> refunded, the appointment stays cancelled", async () => {
      const p = await pendingWithOrder(guardianA);
      as(guardianA.user);
      expect((await cancel(p.id)).status).toBe(200);
      const res = await webhook(capturedBody(p.orderId, newPaymentId()));
      expect(res.json.outcome).toBe("refund_appointment_cancelled");
      expect(await status(p.id)).toBe("cancelled");
    });
  });

  // ---------- FR-7 / E-4 ----------

  describe("cancellation refunds (FR-7, E-4)", () => {
    it("provider cancels a paid appointment -> full refund (refund.processed webhook finishes it)", async () => {
      const p = await paid();
      as(providerA.user);
      expect((await cancel(p.id)).status).toBe(200);
      const pay = await paymentOf(p.id);
      expect(pay).toMatchObject({ status: "refund_pending", refund_reason: "provider_cancelled" });
      const res = await webhook(JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_T031provider01", payment_id: pay.razorpay_payment_id, amount: 50000, status: "processed" } } } }));
      expect(res.json.outcome).toBe("refunded");
      expect(await paymentOf(p.id)).toMatchObject({ status: "refunded", refund_id: "rfnd_T031provider01" });
    });

    it("guardian cancels >= 24 h before -> refund; 3 h before -> no refund (stays captured)", async () => {
      const early = await paid(guardianA, nextSlot(40));
      as(guardianA.user);
      expect((await cancel(early.id)).status).toBe(200);
      expect(await paymentOf(early.id)).toMatchObject({ status: "refund_pending", refund_reason: "guardian_cancelled" });

      const late = await paid(guardianA, nextSlot(45));
      await sql`update appointments set slot = tstzrange(now() + interval '3 hours', now() + interval '3 hours 30 minutes', '[)') where id = ${late.id}`;
      as(guardianA.user);
      expect((await cancel(late.id)).status).toBe(200);
      expect(await status(late.id)).toBe("cancelled");
      expect(await paymentOf(late.id)).toMatchObject({ status: "captured", refund_reason: null });
      const { paymentLabel } = await import("@/lib/payments/display");
      expect(paymentLabel({ status: "cancelled", service_snapshot: { payment_mode: "online" } }, { status: "captured" }, "guardian")).toBe("notRefunded");
    });

    it("a rescheduled paid appointment keeps its payment (no refund)", async () => {
      const p = await paid();
      as(guardianA.user);
      const res = await call(routes.reschedule.POST, post(`http://localhost/api/appointments/${p.id}/reschedule`, { start: nextSlot().toISOString() }), { id: p.id });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const newId = (res.json.appointment as Json).id as string;
      expect(await sql`select count(*)::int as n from payments where appointment_id = ${p.id}`).toEqual([{ n: 0 }]);
      expect(await paymentOf(newId)).toMatchObject({ status: "captured", refund_reason: null });
    });
  });

  // ---------- refund job ----------

  describe("refund job", () => {
    it("retries after a gateway error, reuses an existing refund, never refunds twice", async () => {
      const { setPaymentGatewayForTests, createDemoGateway, RazorpayApiError } = await import("@/lib/payments/razorpay");
      const p = await paid();
      as(providerA.user);
      await cancel(p.id);
      const pay = await paymentOf(p.id);
      const created: string[] = [];
      const demoGw = createDemoGateway();
      setPaymentGatewayForTests({
        ...demoGw,
        createRefund: async () => {
          throw new RazorpayApiError(503, "SERVER_ERROR", true);
        },
      });
      try {
        const { runPaymentJobs } = await import("@/lib/payments/jobs");
        expect(await runPaymentJobs({ sql, paymentIds: [pay.id] })).toEqual({ refunded: 0, pending: 0, failed: 1 });
        const [row] = await sql<{ status: string; refund_attempts: number; refund_last_error: string; due_later: boolean }[]>`
          select status, refund_attempts, refund_last_error, refund_next_attempt_at > now() as due_later from payments where id = ${pay.id}`;
        expect(row).toMatchObject({ status: "refund_pending", refund_attempts: 1, due_later: true });
        expect(row.refund_last_error).toContain("503");
        // Not due yet: nothing claimed.
        expect(await runPaymentJobs({ sql, paymentIds: [pay.id] })).toEqual({ refunded: 0, pending: 0, failed: 0 });

        await sql`update payments set refund_next_attempt_at = now() - interval '1 second' where id = ${pay.id}`;
        setPaymentGatewayForTests({
          ...demoGw,
          listRefunds: async (paymentId) => [{ id: "rfnd_T031existing01", payment_id: paymentId, amount: 50000, status: "pending" }],
          createRefund: async (paymentId, input) => {
            created.push(paymentId);
            return demoGw.createRefund(paymentId, input);
          },
        });
        expect(await runPaymentJobs({ sql, paymentIds: [pay.id] })).toEqual({ refunded: 0, pending: 1, failed: 0 });
        expect(await paymentOf(p.id)).toMatchObject({ status: "refund_pending", refund_id: "rfnd_T031existing01" });
        expect(created).toEqual([]);

        await sql`update payments set refund_next_attempt_at = now() - interval '1 second' where id = ${pay.id}`;
        setPaymentGatewayForTests({ ...demoGw, fetchRefund: async (paymentId, refundId) => ({ id: refundId, payment_id: paymentId, amount: 50000, status: "processed" }) });
        expect(await runPaymentJobs({ sql, paymentIds: [pay.id] })).toEqual({ refunded: 1, pending: 0, failed: 0 });
        expect(await paymentOf(p.id)).toMatchObject({ status: "refunded", refund_id: "rfnd_T031existing01" });
        expect(await sql`select 1 from outbox_events where dedup_key = ${`payment:${pay.id}:refunded`}`).toHaveLength(1);
      } finally {
        setPaymentGatewayForTests(null);
      }
    });

    it("the cron route needs CRON_SECRET", async () => {
      const res = await call(routes.paymentsCron.POST, new Request("http://localhost/api/cron/payments", { method: "POST" }));
      expect(res.status).toBe(401);
    });
  });

  // ---------- NFR-3 ----------

  it("privacy registry: payments export only the requesting guardian's payments; retained on erasure", async () => {
    await paid();
    const { REGISTRY } = await import("@/lib/privacy/registry");
    const category = REGISTRY.find((c) => c.key === "payments")!;
    expect(category.tables).toEqual(["payments", "payment_events"]);
    expect(category.processors).toContain("razorpay");
    expect(category.retainedOnErasure).toBe(true);
    const mine = await category.export!({ sql, childId: guardianA.childId, guardianUserId: guardianA.user.id });
    const rows = mine!.data as Json[];
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["amount_paise", "appointment_id", "captured_at", "created_at", "currency", "razorpay_order_id", "razorpay_payment_id", "refund_reason", "refunded_at", "status"].sort(),
    );
    const other = await category.export!({ sql, childId: guardianA.childId, guardianUserId: guardianB.user.id });
    expect(other!.data).toEqual([]);
  });
});
