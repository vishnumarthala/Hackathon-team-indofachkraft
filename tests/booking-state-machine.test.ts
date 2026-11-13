// Ticket 030 FR-2..FR-8 against the real database through the route handlers: every allowed transition and the
// invalid ones (409), hold expiry (410), owner mismatch (404), idempotency replay, anonymous holds attached after
// sign-in, outbox events in the same transaction, cron cleanup, provider schedule APIs and their authz, and the
// SQL/TS slot rules agreeing. Synthetic users only; skipped without DATABASE_URL.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingWorld, futureSlot, key, type TestProvider } from "./helpers/booking";
import { ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string }, cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    getAll: () => [...session.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => session.cookies.has(name),
  }),
  headers: async () => ({ get: () => null }),
}));

const SLOT_TAKEN = "This slot was just taken. Please pick another time.";
const HOLD_EXPIRED = "Your hold expired. Please pick the time again.";

type Json = Record<string, unknown>;
async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json, res };
}

describe.skipIf(!enabled)("booking state machine (database, route handlers)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let providerA: TestProvider;
  let providerB: TestProvider;
  let free30: string;
  let atClinic45Video: string;
  let online30: string;
  let guardianA: { user: TestUser; childId: string };
  let guardianB: { user: TestUser; childId: string };
  let routes: {
    slots: typeof import("@/app/api/public/providers/[profileId]/slots/route");
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    cancel: typeof import("@/app/api/appointments/[id]/cancel/route");
    reschedule: typeof import("@/app/api/appointments/[id]/reschedule/route");
    complete: typeof import("@/app/api/appointments/[id]/complete/route");
    ics: typeof import("@/app/api/appointments/[id]/ics/route");
    cron: typeof import("@/app/api/cron/booking/route");
    services: typeof import("@/app/api/provider/services/route");
    service: typeof import("@/app/api/provider/services/[id]/route");
    rules: typeof import("@/app/api/provider/availability/rules/route");
    rule: typeof import("@/app/api/provider/availability/rules/[id]/route");
    overrides: typeof import("@/app/api/provider/availability/overrides/route");
    override: typeof import("@/app/api/provider/availability/overrides/[id]/route");
  };

  const as = (user: TestUser | null, cookie?: string) => {
    session.user = user;
    session.cookies.clear();
    if (cookie) session.cookies.set("dnm_booking", cookie);
  };

  const hold = (serviceId: string, start: Date, idempotencyKey = key()) =>
    call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: serviceId, start: start.toISOString(), idempotency_key: idempotencyKey }));
  const confirm = (id: string, childId: string) => call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: childId }), { id });
  const cancel = (id: string, reason?: string) => call(routes.cancel.POST, post(`http://localhost/api/appointments/${id}/cancel`, reason ? { reason } : {}), { id });
  const reschedule = (id: string, start: Date) => call(routes.reschedule.POST, post(`http://localhost/api/appointments/${id}/reschedule`, { start: start.toISOString() }), { id });
  const complete = (id: string, status: string) => call(routes.complete.POST, post(`http://localhost/api/appointments/${id}/complete`, { status }), { id });
  const status = async (id: string) => (await sql<{ status: string }[]>`select status from appointments where id = ${id}`)[0]?.status;
  const events = (id: string) => sql<{ from_status: string | null; to_status: string; actor_kind: string; reason: string | null }[]>`
    select from_status, to_status, actor_kind, reason from appointment_events where appointment_id = ${id} order by id`;
  const outbox = (id: string) => sql<{ topic: string; dedup_key: string; status: string; deliver_after: Date; payload: Json }[]>`
    select topic, dedup_key, status, deliver_after, payload from outbox_events
    where aggregate_type = 'appointment' and payload ->> 'appointment_id' = ${id} order by id`;

  /** A confirmed appointment for guardian A at `start` (free 30-minute in-clinic service). */
  async function booked(start: Date, g = guardianA, serviceId = free30): Promise<string> {
    as(g.user);
    const h = await hold(serviceId, start);
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    const c = await confirm(h.json.appointment_id as string, g.childId);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    return h.json.appointment_id as string;
  }

  /** Time travel: move an appointment so it starts `minutes` from now (negative = already started). */
  const startIn = (id: string, minutes: number) => sql`
    update appointments set slot = tstzrange(now() + make_interval(mins => ${minutes}), now() + make_interval(mins => ${minutes + 30}), '[)') where id = ${id}`;

  beforeAll(async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-030");
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t030s");
    providerA = await world.provider("pa");
    providerB = await world.provider("pb");
    free30 = await world.service(providerA, { duration: 30, payment: "free" });
    // 045: "pay at clinic" is retired; a free 45-minute video service confirms directly.
    atClinic45Video = await world.service(providerA, { mode: "video", duration: 45, payment: "free" });
    online30 = await world.service(providerA, { duration: 30, payment: "online", fee: 600 });
    guardianA = await world.guardian("ga");
    await world.linkGoogle(guardianA.user); // 037 FR-5a: video bookings need a linked Google account
    guardianB = await world.guardian("gb");
    routes = {
      slots: await import("@/app/api/public/providers/[profileId]/slots/route"),
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      cancel: await import("@/app/api/appointments/[id]/cancel/route"),
      reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
      complete: await import("@/app/api/appointments/[id]/complete/route"),
      ics: await import("@/app/api/appointments/[id]/ics/route"),
      cron: await import("@/app/api/cron/booking/route"),
      services: await import("@/app/api/provider/services/route"),
      service: await import("@/app/api/provider/services/[id]/route"),
      rules: await import("@/app/api/provider/availability/rules/route"),
      rule: await import("@/app/api/provider/availability/rules/[id]/route"),
      overrides: await import("@/app/api/provider/availability/overrides/route"),
      override: await import("@/app/api/provider/availability/overrides/[id]/route"),
    };
  });

  beforeEach(async () => {
    const { holdLimiter, slotsLimiter } = await import("@/lib/booking/rate-limit");
    holdLimiter.reset();
    slotsLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  describe("slots (FR-2)", () => {
    it("lists free slots as UTC ISO strings; unknown profile/service 404; bad query 400", async () => {
      const url = (q: string, id = providerA.profileId) => new Request(`http://localhost/api/public/providers/${id}/slots?${q}`);
      const ok = await call(routes.slots.GET, url(`service_id=${free30}&days=2`), { profileId: providerA.profileId });
      expect(ok.status).toBe(200);
      const slots = ok.json.slots as { start: string; end: string }[];
      expect(slots.length).toBeGreaterThan(10);
      expect(slots[0].start).toMatch(/Z$/);
      expect(Date.parse(slots[0].start)).toBeGreaterThanOrEqual(Date.now() + 2 * 3_600_000 - 60_000);
      expect(ok.json.time_zone).toBe("Asia/Kolkata");
      expect((await call(routes.slots.GET, url(`service_id=${free30}`, providerB.profileId), { profileId: providerB.profileId })).status).toBe(404);
      expect((await call(routes.slots.GET, url(`service_id=${free30}&days=30`), { profileId: providerA.profileId })).status).toBe(400);
      expect((await call(routes.slots.GET, url("service_id=nope"), { profileId: providerA.profileId })).status).toBe(400);
    });

    it("every generated slot is accepted by the SQL rule check; off-grid and out-of-hours times are not", async () => {
      const { getService, getSlots } = await import("@/lib/booking/store");
      for (const serviceId of [free30, atClinic45Video]) {
        const service = (await getService(serviceId))!;
        const { slots } = await getSlots(service, { days: 3 });
        expect(slots.length).toBeGreaterThan(0);
        const [{ bad }] = await sql<{ bad: number }[]>`
          select count(*)::int as bad from unnest(${slots.map((s) => s.start)}::timestamptz[]) as t(start)
          where not public.booking_slot_valid(${service.provider_profile_id}::uuid, ${service.mode}, ${service.location_id}::uuid, ${service.duration_min}, t.start)`;
        expect(bad).toBe(0);
      }
      const offGrid = new Date(futureSlot(30).getTime() + 10 * 60_000);
      const [{ ok }] = await sql<{ ok: boolean }[]>`
        select public.booking_slot_valid(${providerA.profileId}::uuid, 'in_clinic', ${providerA.locationId}::uuid, 30, ${offGrid.toISOString()}::timestamptz) as ok`;
      expect(ok).toBe(false);
    });
  });

  describe("hold -> confirm (FR-3, FR-4)", () => {
    it("guardian holds (201), replays the key (200, same appointment), mismatched replay 422", async () => {
      as(guardianA.user);
      const start = futureSlot(20);
      const k = key();
      const first = await hold(free30, start, k);
      expect(first.status).toBe(201);
      expect(Date.parse(first.json.hold_expires_at as string) - Date.now()).toBeGreaterThan(9 * 60_000);
      const again = await hold(free30, start, k);
      expect(again.status).toBe(200);
      expect(again.json.appointment_id).toBe(first.json.appointment_id);
      const other = await hold(free30, new Date(start.getTime() + 30 * 60_000), k);
      expect(other.status).toBe(422);
      // A second hold by the same owner releases the first one (max one active hold per owner).
      const second = await hold(free30, new Date(start.getTime() + 60 * 60_000));
      expect(second.status).toBe(201);
      expect(await status(first.json.appointment_id as string)).toBe("cancelled");
      expect((await events(first.json.appointment_id as string)).at(-1)).toMatchObject({ to_status: "cancelled", reason: "hold_released" });
    });

    it("a taken slot -> 409 with the FR-4 message; the slot disappears from the list", async () => {
      const start = futureSlot(24);
      as(guardianA.user);
      expect((await hold(free30, start)).status).toBe(201);
      as(guardianB.user);
      const taken = await hold(free30, start);
      expect(taken.status).toBe(409);
      expect(taken.json).toEqual({ error: SLOT_TAKEN, code: "slot_taken" });
      const list = await call(routes.slots.GET, new Request(`http://localhost/api/public/providers/${providerA.profileId}/slots?service_id=${free30}&days=3`), { profileId: providerA.profileId });
      expect((list.json.slots as { start: string }[]).some((s) => s.start === start.toISOString())).toBe(false);
    });

    it("rejects times outside the rules: too soon (2 h), too far (14 days), off-grid", async () => {
      as(guardianA.user);
      expect((await hold(free30, futureSlot(1))).json.code).toBe("too_soon");
      expect((await hold(free30, futureSlot(24 * 15))).json.code).toBe("too_far");
      expect((await hold(free30, new Date(futureSlot(22).getTime() + 5 * 60_000))).json.code).toBe("slot_unavailable");
    });

    it("confirm: anonymous 401, another guardian 404, unlinked child 422, then confirmed with snapshot, history and outbox", async () => {
      const start = futureSlot(30);
      as(guardianA.user);
      const h = await hold(free30, start);
      const id = h.json.appointment_id as string;

      as(null);
      expect((await confirm(id, guardianA.childId)).status).toBe(401);
      as(guardianB.user);
      expect((await confirm(id, guardianB.childId)).status).toBe(404);
      as(guardianA.user);
      const unlinked = await confirm(id, guardianB.childId);
      expect(unlinked.status).toBe(422);
      expect(unlinked.json.code).toBe("child_not_linked");

      const ok = await confirm(id, guardianA.childId);
      expect(ok.status).toBe(200);
      const appointment = ok.json.appointment as Json;
      expect(appointment).toMatchObject({ status: "confirmed", child_id: guardianA.childId, guardian_user_id: guardianA.user.id });
      expect(appointment.service_snapshot).toMatchObject({ duration_min: 30, mode: "in_clinic", fee_inr: 0, payment_mode: "free", location: { name: expect.any(String) } });
      expect((await events(id)).map((e) => [e.from_status, e.to_status])).toEqual([[null, "held"], ["held", "confirmed"]]);

      const rows = await outbox(id);
      expect(rows.map((r) => r.topic)).toEqual(["appointment.confirmed", "appointment.reminder_day_before", "appointment.reminder_two_hours"]);
      expect(rows.map((r) => r.dedup_key)).toEqual([`appt:${id}:confirmed`, `appt:${id}:r24`, `appt:${id}:r2`]);
      expect(rows[1].deliver_after.getTime()).toBe(start.getTime() - 24 * 3_600_000);
      expect(rows[2].deliver_after.getTime()).toBe(start.getTime() - 2 * 3_600_000);
      expect(Object.keys(rows[0].payload).sort()).toEqual(["appointment_id", "ends_at", "location", "mode", "provider_name", "starts_at", "time_zone"]);

      // Confirming again is an invalid transition.
      expect((await confirm(id, guardianA.childId)).status).toBe(409);
    });

    it("fan-out: guardian + provider get the confirmation (in-app, email with .ics); WhatsApp skipped without config", async () => {
      const id = await booked(futureSlot(31));
      const { fanOutDue, runOutbox } = await import("@/lib/notify/worker");
      const [event] = await sql<{ id: string }[]>`select id::text from outbox_events where dedup_key = ${`appt:${id}:confirmed`}`;
      await fanOutDue(sql, { eventIds: [event.id] });
      const rows = await sql<{ recipient_user_id: string; channel: string; status: string; link: string }[]>`
        select recipient_user_id, channel, status, link from notifications where event_id = ${event.id} order by recipient_user_id, channel`;
      expect(new Set(rows.map((r) => r.recipient_user_id))).toEqual(new Set([guardianA.user.id, providerA.user.id]));
      expect(rows.find((r) => r.recipient_user_id === guardianA.user.id && r.channel === "in_app")).toMatchObject({ status: "sent", link: "/family/appointments" });
      // Deliver with mock senders (another suite's global cron run may deliver first: then nothing is left for us).
      const sent: { ics?: boolean }[] = [];
      await runOutbox({
        eventIds: [event.id],
        senders: {
          email: async ({ rendered }) => {
            sent.push({ ics: Boolean(rendered.email?.ics) });
            return { status: "sent", providerMessageId: "mock" };
          },
          whatsapp: async () => ({ status: "skipped", reason: "whatsapp_not_configured" }),
        },
      });
      expect(sent.every((s) => s.ics)).toBe(true);
      const [stored] = await sql<{ payload: Json }[]>`select payload from outbox_events where id = ${event.id}`;
      const { TEMPLATES } = await import("@/lib/notify/templates");
      const email = TEMPLATES.appointment_confirmed.render({
        payload: stored.payload as never,
        locale: "en",
        role: "guardian",
        appUrl: "http://localhost",
        event: { id: event.id, aggregate_type: "appointment", aggregate_id: id },
      }).email;
      expect(email?.ics).toMatchObject({ method: "REQUEST" });
      expect(`${email?.subject} ${email?.text}`).not.toContain("child (synthetic)");
      const after = await sql<{ channel: string; status: string }[]>`select channel, status from notifications where event_id = ${event.id} and recipient_user_id = ${guardianA.user.id}`;
      expect(after.find((r) => r.channel === "whatsapp")?.status).toBe("skipped");
      expect(after.find((r) => r.channel === "email")?.status).toBe("sent");
    });

    it("anonymous hold (session cookie) is attached after sign-in; another browser cannot confirm it", async () => {
      as(null);
      const h = await hold(free30, futureSlot(32));
      expect(h.status).toBe(201);
      const setCookie = h.res.headers.get("set-cookie") ?? "";
      const cookie = /dnm_booking=([^;]+)/.exec(setCookie)?.[1];
      expect(cookie).toBeTruthy();
      expect(setCookie.toLowerCase()).toContain("httponly");
      const id = h.json.appointment_id as string;
      const [row] = await sql<{ hold_owner_user_id: string | null; hold_owner_session: string }[]>`select hold_owner_user_id, hold_owner_session from appointments where id = ${id}`;
      expect(row.hold_owner_user_id).toBeNull();
      expect(row.hold_owner_session).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hold_owner_session).not.toContain(cookie as string);

      as(guardianB.user, "x".repeat(43));
      expect((await confirm(id, guardianB.childId)).status).toBe(404);
      as(guardianA.user, cookie);
      const ok = await confirm(id, guardianA.childId);
      expect(ok.status).toBe(200);
      expect((ok.json.appointment as Json).guardian_user_id).toBe(guardianA.user.id);
    });

    it("holds are rate limited per IP (30 per 10 minutes)", async () => {
      as(guardianA.user);
      const { holdLimiter } = await import("@/lib/booking/rate-limit");
      for (let i = 0; i < 30; i++) holdLimiter.allow("unknown");
      const limited = await hold(free30, futureSlot(33));
      expect(limited.status).toBe(429);
    });

    it("signed-in providers cannot hold (403)", async () => {
      as(providerB.user);
      expect((await hold(free30, futureSlot(33))).status).toBe(403);
    });

    it("online payment -> pending_payment for 15 minutes, no confirmation yet (031 completes it)", async () => {
      as(guardianA.user);
      const h = await hold(online30, futureSlot(34));
      const c = await confirm(h.json.appointment_id as string, guardianA.childId);
      expect(c.status).toBe(200);
      expect((c.json.appointment as Json).status).toBe("pending_payment");
      const left = Date.parse((c.json.appointment as Json).hold_expires_at as string) - Date.now();
      expect(left).toBeGreaterThan(14 * 60_000);
      expect(left).toBeLessThanOrEqual(15 * 60_000 + 5_000);
      expect(await outbox(h.json.appointment_id as string)).toEqual([]);
    });

    it("video free service confirms directly; .ics download for the guardian and the provider only", async () => {
      const id = await booked(futureSlot(36, 45), guardianA, atClinic45Video);
      as(guardianA.user);
      const ics = await routes.ics.GET(new Request(`http://localhost/api/appointments/${id}/ics`), ctx({ id }) as never);
      expect(ics.status).toBe(200);
      const text = await ics.text();
      expect(text).toContain("BEGIN:VCALENDAR");
      expect(text).toContain(`UID:appointment-${id}@doctornearme`);
      expect(text).not.toContain("child (synthetic)");
      as(providerA.user);
      expect((await routes.ics.GET(new Request("http://localhost/x"), ctx({ id }) as never)).status).toBe(200);
      as(guardianB.user);
      expect((await routes.ics.GET(new Request("http://localhost/x"), ctx({ id }) as never)).status).toBe(404);
    });
  });

  describe("expiry (FR-4, FR-5)", () => {
    it("expired hold: cron (secret required) -> expired; confirm -> 410; slot offered again", async () => {
      const start = futureSlot(40);
      as(guardianB.user);
      const h = await hold(free30, start);
      const id = h.json.appointment_id as string;
      await sql`update appointments set hold_expires_at = now() - interval '1 second' where id = ${id}`;
      // Before the cron: confirm already answers 410.
      const early = await confirm(id, guardianB.childId);
      expect(early.status).toBe(410);
      expect(early.json.error).toBe(HOLD_EXPIRED);

      expect((await call(routes.cron.POST, new Request("http://localhost/api/cron/booking", { method: "POST" }))).status).toBe(401);
      const run = await call(routes.cron.POST, new Request("http://localhost/api/cron/booking", { method: "POST", headers: { Authorization: "Bearer test-cron-030" } }));
      expect(run.status).toBe(200);
      // >= 0: another suite's cleanup run (booking-concurrency) may have expired this hold first, in parallel.
      expect(typeof run.json.expired).toBe("number");
      expect(await status(id)).toBe("expired");
      expect((await events(id)).at(-1)).toMatchObject({ from_status: "held", to_status: "expired", actor_kind: "system" });
      expect((await confirm(id, guardianB.childId)).status).toBe(410);

      const list = await call(routes.slots.GET, new Request(`http://localhost/api/public/providers/${providerA.profileId}/slots?service_id=${free30}&days=3`), { profileId: providerA.profileId });
      expect((list.json.slots as { start: string }[]).some((s) => s.start === start.toISOString())).toBe(true);
      as(guardianA.user);
      expect((await hold(free30, start)).status).toBe(201);
    });

    it("a stale hold no longer blocks: the next hold expires it in the same transaction", async () => {
      const start = futureSlot(41);
      as(guardianB.user);
      const stale = await hold(free30, start);
      await sql`update appointments set hold_expires_at = now() - interval '1 second' where id = ${stale.json.appointment_id as string}`;
      as(guardianA.user);
      expect((await hold(free30, start)).status).toBe(201);
      expect(await status(stale.json.appointment_id as string)).toBe("expired");
    });
  });

  describe("cancel / reschedule / complete (FR-3)", () => {
    it("guardian reschedules: new confirmed appointment, old cancelled with link, reminders moved", async () => {
      const id = await booked(futureSlot(50));
      const target = futureSlot(52);
      as(guardianA.user);
      const r = await reschedule(id, target);
      expect(r.status).toBe(200);
      const next = r.json.appointment as Json;
      expect(next).toMatchObject({ status: "confirmed", rescheduled_from: id, origin_appointment_id: id, child_id: guardianA.childId });
      expect(next.starts_at).toBe(target.toISOString());
      expect(await status(id)).toBe("cancelled");
      const [old] = await sql<{ cancel_reason: string; cancelled_by: string }[]>`select cancel_reason, cancelled_by from appointments where id = ${id}`;
      expect(old).toEqual({ cancel_reason: "rescheduled", cancelled_by: "guardian" });

      const oldEvents = await outbox(id);
      expect(oldEvents.filter((e) => e.dedup_key.endsWith(":r24") || e.dedup_key.endsWith(":r2")).map((e) => e.status)).toEqual(["cancelled", "cancelled"]);
      const newEvents = await outbox(next.id as string);
      // `fanned_out` too: another suite's global cron run may fan out the immediate event in parallel.
      const live = (status: string) => (status === "fanned_out" ? "pending" : status);
      expect(newEvents.map((e) => [e.topic, live(e.status)])).toEqual([
        ["appointment.rescheduled", "pending"],
        ["appointment.reminder_day_before", "pending"],
        ["appointment.reminder_two_hours", "pending"],
      ]);
      // Same calendar entry: the new events use the original appointment as their aggregate.
      const [agg] = await sql<{ aggregate_id: string }[]>`select aggregate_id from outbox_events where dedup_key = ${`appt:${next.id}:rescheduled`}`;
      expect(agg.aggregate_id).toBe(id);
      // The old one cannot be rescheduled again.
      expect((await reschedule(id, futureSlot(53))).status).toBe(409);
    });

    it("reschedule into a taken slot -> 409 and the original stays confirmed", async () => {
      const id = await booked(futureSlot(54));
      const taken = futureSlot(55);
      await booked(taken, guardianB);
      as(guardianA.user);
      const r = await reschedule(id, taken);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe(SLOT_TAKEN);
      expect(await status(id)).toBe("confirmed");
      expect((await outbox(id)).every((e) => e.status !== "cancelled")).toBe(true);
    });

    it("guardian cancels (> 2 h): cancelled, reminders cancelled, appointment.cancelled enqueued; again -> 409", async () => {
      const id = await booked(futureSlot(56));
      as(guardianA.user);
      const r = await cancel(id, "Child unwell");
      expect(r.status).toBe(200);
      expect((r.json.appointment as Json).status).toBe("cancelled");
      const rows = await outbox(id);
      expect(rows.filter((e) => e.topic.startsWith("appointment.reminder")).map((e) => e.status)).toEqual(["cancelled", "cancelled"]);
      expect(rows.find((e) => e.topic === "appointment.cancelled")).toMatchObject({ status: expect.stringMatching(/^(pending|fanned_out)$/), payload: { cancelled_by: "guardian" } });
      expect((await events(id)).at(-1)).toMatchObject({ from_status: "confirmed", to_status: "cancelled", actor_kind: "guardian", reason: "Child unwell" });
      expect((await cancel(id)).status).toBe(409);
    });

    it("guardian cancel within 2 h of the start -> 409; the provider can still cancel and the guardian is notified", async () => {
      const id = await booked(futureSlot(57));
      await startIn(id, 90);
      as(guardianA.user);
      const late = await cancel(id);
      expect(late.status).toBe(409);
      expect(late.json.code).toBe("too_late");
      as(providerA.user);
      const r = await cancel(id, "Clinic closed");
      expect(r.status).toBe(200);
      const [event] = await sql<{ id: string }[]>`select id::text from outbox_events where dedup_key = ${`appt:${id}:cancelled`}`;
      const { fanOutDue } = await import("@/lib/notify/worker");
      await fanOutDue(sql, { eventIds: [event.id] });
      const recipients = await sql<{ recipient_user_id: string }[]>`select distinct recipient_user_id from notifications where event_id = ${event.id}`;
      expect(recipients.map((r) => r.recipient_user_id)).toContain(guardianA.user.id);
    });

    it("authz: other guardian / other provider / anonymous cannot act (404/401)", async () => {
      const id = await booked(futureSlot(58));
      as(guardianB.user);
      expect((await cancel(id)).status).toBe(404);
      expect((await reschedule(id, futureSlot(59))).status).toBe(404);
      as(providerB.user);
      expect((await cancel(id)).status).toBe(404);
      expect((await complete(id, "completed")).status).toBe(404);
      as(null);
      expect((await cancel(id)).status).toBe(401);
      expect(await status(id)).toBe("confirmed");
    });

    it("complete: before start 409; after start completed; again 409; no_show; cancelled cannot complete", async () => {
      const id = await booked(futureSlot(60));
      as(providerA.user);
      const early = await complete(id, "completed");
      expect(early.status).toBe(409);
      expect(early.json.code).toBe("not_started");
      await startIn(id, -10);
      expect((await complete(id, "completed")).status).toBe(200);
      expect(await status(id)).toBe("completed");
      expect((await complete(id, "no_show")).status).toBe(409);
      expect((await cancel(id)).status).toBe(409);
      as(guardianA.user);
      expect((await reschedule(id, futureSlot(61))).status).toBe(409);

      const other = await booked(futureSlot(62));
      await startIn(other, -5);
      as(providerA.user);
      expect((await complete(other, "no_show")).status).toBe(200);
      expect(await status(other)).toBe("no_show");
      expect((await complete(other, "bogus")).status).toBe(400);

      const cancelled = await booked(futureSlot(63));
      as(guardianA.user);
      await cancel(cancelled);
      await startIn(cancelled, -5);
      as(providerA.user);
      expect((await complete(cancelled, "completed")).status).toBe(409);
    });

    it("a held appointment can be cancelled by its owner but not completed or rescheduled", async () => {
      as(guardianA.user);
      const h = await hold(free30, futureSlot(64));
      const id = h.json.appointment_id as string;
      expect((await reschedule(id, futureSlot(65))).status).toBe(409);
      as(providerA.user);
      expect((await complete(id, "completed")).status).toBe(409);
      as(guardianA.user);
      expect((await cancel(id)).status).toBe(200);
      expect((await outbox(id)).length).toBe(0);
    });
  });

  describe("provider schedule (FR-8)", () => {
    it("services: create in-clinic + video; modes on the profile follow active services; validation", async () => {
      as(providerB.user);
      const created = await call(routes.services.POST, post("http://localhost/api/provider/services", {
        name: "Speech therapy (synthetic)", mode: "video", duration_min: 45, fee_inr: 700, payment_mode: "online",
      }));
      expect(created.status).toBe(201);
      const [modes] = await sql<{ offers_video: boolean; offers_in_clinic: boolean }[]>`select offers_video, offers_in_clinic from provider_profiles where id = ${providerB.profileId}`;
      expect(modes).toEqual({ offers_video: true, offers_in_clinic: false });
      const clinic = await call(routes.services.POST, post("http://localhost/api/provider/services", {
        name: "Assessment (synthetic)", mode: "in_clinic", location_id: providerB.locationId, duration_min: 60, fee_inr: 0, payment_mode: "free",
      }));
      expect(clinic.status).toBe(201);
      const off = await call(routes.service.PATCH, post("http://localhost/api/provider/services/x", { active: false }, "PATCH"), { id: (created.json.service as Json).id as string });
      expect(off.status).toBe(200);
      const [after] = await sql<{ offers_video: boolean; offers_in_clinic: boolean }[]>`select offers_video, offers_in_clinic from provider_profiles where id = ${providerB.profileId}`;
      expect(after).toEqual({ offers_video: false, offers_in_clinic: true });
      // A manual flag change is overridden while services exist.
      await sql`update provider_profiles set offers_video = true where id = ${providerB.profileId}`;
      expect((await sql<{ v: boolean }[]>`select offers_video as v from provider_profiles where id = ${providerB.profileId}`)[0].v).toBe(false);

      expect((await call(routes.services.POST, post("http://localhost/api/provider/services", { name: "x", mode: "in_clinic", duration_min: 30, fee_inr: 0, payment_mode: "free" }))).status).toBe(400);
      expect((await call(routes.services.POST, post("http://localhost/api/provider/services", { name: "x", mode: "in_clinic", location_id: providerA.locationId, duration_min: 30, fee_inr: 0, payment_mode: "free" }))).status).toBe(400);
      expect((await call(routes.services.POST, post("http://localhost/api/provider/services", { name: "x", mode: "video", duration_min: 25, fee_inr: 0, payment_mode: "free" }))).status).toBe(400);
      expect((await call(routes.services.POST, post("http://localhost/api/provider/services", { name: "x", mode: "video", duration_min: 30, fee_inr: 100, payment_mode: "free" }))).status).toBe(400);
    });

    it("authz: provider B cannot change provider A's services, hours or overrides (404); guardians 403; anonymous 401", async () => {
      as(providerA.user);
      const rule = await call(routes.rules.POST, post("http://localhost/api/provider/availability/rules", { weekday: 2, start_time: "18:00", end_time: "19:00", mode: "video" }));
      expect(rule.status).toBe(201);
      const ov = await call(routes.overrides.POST, post("http://localhost/api/provider/availability/overrides", { date: "2027-01-05", kind: "unavailable" }));
      expect(ov.status).toBe(201);
      const ruleId = (rule.json.rule as Json).id as string;
      const ovId = (ov.json.override as Json).id as string;

      as(providerB.user);
      expect((await call(routes.rule.DELETE, new Request("http://localhost/x", { method: "DELETE" }), { id: ruleId })).status).toBe(404);
      expect((await call(routes.override.DELETE, new Request("http://localhost/x", { method: "DELETE" }), { id: ovId })).status).toBe(404);
      expect((await call(routes.service.PATCH, post("http://localhost/x", { active: false }, "PATCH"), { id: free30 })).status).toBe(404);
      const foreignLocation = await call(routes.rules.POST, post("http://localhost/api/provider/availability/rules", { weekday: 1, start_time: "10:00", end_time: "11:00", mode: "in_clinic", location_id: providerA.locationId }));
      expect(foreignLocation.status).toBe(400);
      expect((await call(routes.rules.GET, new Request("http://localhost/x"))).json.rules).not.toContainEqual(expect.objectContaining({ id: ruleId }));

      as(guardianA.user);
      expect((await call(routes.rules.POST, post("http://localhost/x", { weekday: 2, start_time: "18:00", end_time: "19:00", mode: "video" }))).status).toBe(403);
      as(null);
      expect((await call(routes.services.GET, new Request("http://localhost/x"))).status).toBe(401);

      as(providerA.user);
      expect((await call(routes.rule.DELETE, new Request("http://localhost/x", { method: "DELETE" }), { id: ruleId })).status).toBe(200);
      expect((await call(routes.override.DELETE, new Request("http://localhost/x", { method: "DELETE" }), { id: ovId })).status).toBe(200);
      expect((await call(routes.rules.POST, post("http://localhost/x", { weekday: 2, start_time: "19:00", end_time: "18:00", mode: "video" }))).status).toBe(400);
    });

    it("block a date: no slots that day; the existing confirmed appointment stays and is flagged in the agenda", async () => {
      const { todayIn, addDays } = await import("@/lib/booking/time");
      // A date 10 days ahead (IST, away from the other tests' slots) with an appointment at 10:30 IST.
      const date = addDays(todayIn("Asia/Kolkata"), 10);
      const start = new Date(`${date}T05:00:00Z`); // 10:30 IST
      const id = await booked(start);
      as(providerA.user);
      const ov = await call(routes.overrides.POST, post("http://localhost/api/provider/availability/overrides", { date, kind: "unavailable", note: "Conference (synthetic)" }));
      expect(ov.status).toBe(201);
      const list = await call(routes.slots.GET, new Request(`http://localhost/api/public/providers/${providerA.profileId}/slots?service_id=${free30}&from=${date}&days=1`), { profileId: providerA.profileId });
      expect(list.json.slots).toEqual([]);
      expect(await status(id)).toBe("confirmed");
      const { listAgenda } = await import("@/lib/booking/store");
      const agenda = await listAgenda(providerA.profileId, new Date(`${date}T00:00:00Z`), new Date(`${addDays(date, 1)}T00:00:00Z`));
      expect(agenda.find((a) => a.id === id)).toMatchObject({ status: "confirmed", outside_availability: true, child_name: expect.stringContaining("child (synthetic)") });
      // Extra hours on a blocked date stay blocked; removing the block brings the slots back.
      await call(routes.override.DELETE, new Request("http://localhost/x", { method: "DELETE" }), { id: (ov.json.override as Json).id as string });
      const back = await call(routes.slots.GET, new Request(`http://localhost/api/public/providers/${providerA.profileId}/slots?service_id=${free30}&from=${date}&days=1`), { profileId: providerA.profileId });
      expect((back.json.slots as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe("privacy (NFR-4)", () => {
    it("registry export lists the guardian's own bookings; erasure cancels future ones and detaches the child", async () => {
      const id = await booked(futureSlot(70));
      const { REGISTRY } = await import("@/lib/privacy/registry");
      const category = REGISTRY.find((c) => c.key === "appointments")!;
      const exported = await category.export!({ sql, childId: guardianA.childId, guardianUserId: guardianA.user.id });
      expect((exported!.data as Json[]).some((r) => r.id === id)).toBe(true);
      const other = await category.export!({ sql, childId: guardianA.childId, guardianUserId: guardianB.user.id });
      expect(other!.data).toEqual([]);

      const g = await world.guardian("gerase");
      const doomed = await booked(futureSlot(71), g);
      await sql.begin((tx) => category.erase!.rows!(tx, { childId: g.childId, requestId: "00000000-0000-4000-8000-000000000000", scope: "everything", requestedBy: g.user.id, caseIds: [] }));
      const [row] = await sql<{ status: string; child_id: string | null; cancelled_by: string }[]>`select status, child_id, cancelled_by from appointments where id = ${doomed}`;
      expect(row).toEqual({ status: "cancelled", child_id: null, cancelled_by: "system" });
    });
  });
});
