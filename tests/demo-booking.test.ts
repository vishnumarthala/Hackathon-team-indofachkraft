// Ticket 042 FR-2a: demo-booking safeguard, against the real database through the route handlers and the outbox
// worker. A hold on a demo (is_synthetic) profile needs `demo_ack: true` (else 422); the appointment is stored
// `is_demo` (derived in SQL, immutable), is free (confirmed directly, no payment order, payment rows refused), never
// gets a Meet job, and only in-app notifications are written. Real profiles are unaffected. Synthetic users only;
// skipped without DATABASE_URL.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const NOTICE = "This is a demo profile. No real consultation will take place.";
type Json = Record<string, unknown>;

async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

describe.skipIf(!enabled)("demo booking safeguard (042 FR-2a)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let demoProvider: TestProvider;
  let realProvider: TestProvider;
  let demoOnline: string;
  let demoVideo: string;
  let realFree: string;
  let guardian: { user: TestUser; childId: string };
  let step = 0;
  let routes: {
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    reschedule: typeof import("@/app/api/appointments/[id]/reschedule/route");
    order: typeof import("@/app/api/appointments/[id]/payment-order/route");
  };

  const as = (user: TestUser | null) => {
    session.user = user;
  };
  const nextSlot = () => futureSlot(30, 30, step++ * 3);
  const hold = (serviceId: string, start: Date, extra: Json = {}) =>
    call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: serviceId, start: start.toISOString(), idempotency_key: key(), ...extra }));
  const confirm = (id: string) => call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: guardian.childId }), { id });
  const row = async (id: string) =>
    (await sql<{ is_demo: boolean; status: string; meet_status: string | null; snap: Json }[]>`
      select is_demo, status, meet_status, service_snapshot as snap from appointments where id = ${id}`)[0];
  const eventsOf = (id: string) =>
    sql<{ id: string; topic: string }[]>`
      select id::text, topic from outbox_events
      where (aggregate_type = 'appointment' and aggregate_id = ${id}) or payload ->> 'appointment_id' = ${id}`;

  async function confirmedDemo(serviceId: string) {
    as(guardian.user);
    const h = await hold(serviceId, nextSlot(), { demo_ack: true });
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    const id = h.json.appointment_id as string;
    const c = await confirm(id);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    return { id, appointment: c.json.appointment as Json };
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t042d");
    demoProvider = await world.provider("demo");
    await sql`update provider_profiles set is_synthetic = true where id = ${demoProvider.profileId}`;
    realProvider = await world.provider("real");
    demoOnline = await world.service(demoProvider, { payment: "online", fee: 800, name: "Speech therapy (synthetic)" });
    demoVideo = await world.service(demoProvider, { mode: "video", payment: "online", fee: 600, name: "Video consultation (synthetic)" });
    realFree = await world.service(realProvider, { payment: "free" });
    guardian = await world.guardian("g");
    routes = {
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
      order: await import("@/app/api/appointments/[id]/payment-order/route"),
    };
  });

  beforeEach(async () => {
    (await import("@/lib/booking/rate-limit")).holdLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("refuses a demo hold without the acknowledgement (422) and accepts it with demo_ack: true", async () => {
    as(guardian.user);
    for (const extra of [{}, { demo_ack: false }, { demo_ack: "yes" }]) {
      const res = await hold(demoOnline, nextSlot(), extra);
      expect(res.status, JSON.stringify(extra)).toBe(extra.demo_ack === "yes" ? 400 : 422);
      if (res.status === 422) expect(res.json).toEqual({ error: NOTICE, code: "demo_ack_required" });
    }
    as(null);
    const anon = await hold(demoOnline, nextSlot());
    expect(anon.json.code).toBe("demo_ack_required");
    const ok = await hold(demoOnline, nextSlot(), { demo_ack: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await row(ok.json.appointment_id as string)).is_demo).toBe(true);
  });

  it("stores is_demo, confirms without payment (free snapshot), and refuses a payment order", async () => {
    const { id, appointment } = await confirmedDemo(demoOnline);
    expect(appointment).toMatchObject({ status: "confirmed", is_demo: true });
    const r = await row(id);
    expect(r).toMatchObject({ is_demo: true, status: "confirmed", meet_status: "not_needed" });
    expect(r.snap).toMatchObject({ payment_mode: "free", fee_inr: 0, demo: true });
    as(guardian.user);
    const order = await call(routes.order.POST, post(`http://localhost/api/appointments/${id}/payment-order`), { id });
    expect(order.status).toBe(409);
    expect((await sql`select 1 from payments where appointment_id = ${id}`).length).toBe(0);
    // The database refuses a payment row for a demo appointment whatever the caller.
    await expect(
      sql`insert into payments (appointment_id, gateway, razorpay_order_id, amount_paise) values (${id}, 'demo', 'order_T042demo01', 80000)`,
    ).rejects.toThrow(/not_payable/);
    // is_demo cannot be switched off.
    await sql`update appointments set is_demo = false where id = ${id}`;
    expect((await row(id)).is_demo).toBe(true);
  });

  it("writes in-app notifications only: no email or WhatsApp rows for any demo event", async () => {
    const { id } = await confirmedDemo(demoOnline);
    const events = await eventsOf(id);
    expect(events.map((e) => e.topic)).toContain("appointment.confirmed");
    const { fanOutDue } = await import("@/lib/notify/worker");
    // Reminders are scheduled in the future: make them due so every event of the appointment is fanned out now.
    await sql`update outbox_events set deliver_after = now() where id in ${sql(events.map((e) => e.id))}`;
    await fanOutDue(sql, { eventIds: events.map((e) => e.id), appUrl: "http://localhost:3999" });
    const rows = await sql<{ channel: string; recipient_user_id: string }[]>`
      select channel, recipient_user_id from notifications where event_id in ${sql(events.map((e) => e.id))}`;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((n) => n.channel))).toEqual(new Set(["in_app"]));
    expect(rows.map((n) => n.recipient_user_id)).toContain(guardian.user.id);
    // Trigger-level guarantee for any other writer.
    const inserted = await sql`
      insert into notifications (event_id, recipient_user_id, channel, template)
      values (${events[0].id}, ${guardian.user.id}, 'email', 'appointment_confirmed')
      on conflict do nothing returning id`;
    expect(inserted.length).toBe(0);
  });

  it("video demo bookings need no Google account and never create a Meet job", async () => {
    // The guardian has no linked Google identity: a real video booking would answer google_account_required.
    const { id } = await confirmedDemo(demoVideo);
    expect(await row(id)).toMatchObject({ is_demo: true, status: "confirmed", meet_status: "not_needed" });
    const meet = await sql`select 1 from outbox_events where topic like 'meet.%' and aggregate_id = ${id}`;
    expect(meet.length).toBe(0);
  });

  it("a rescheduled demo appointment stays a demo appointment", async () => {
    const { id } = await confirmedDemo(demoOnline);
    as(guardian.user);
    const res = await call(routes.reschedule.POST, post(`http://localhost/api/appointments/${id}/reschedule`, { start: nextSlot().toISOString() }), { id });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const moved = (res.json.appointment as Json).id as string;
    expect(await row(moved)).toMatchObject({ is_demo: true, status: "confirmed" });
  });

  it("real profiles need no acknowledgement and are never demo bookings", async () => {
    as(guardian.user);
    const h = await hold(realFree, nextSlot(), { demo_ack: true });
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    expect((await row(h.json.appointment_id as string)).is_demo).toBe(false);
    const h2 = await hold(realFree, nextSlot());
    expect(h2.status).toBe(201);
    expect((await row(h2.json.appointment_id as string)).is_demo).toBe(false);
  });
});
