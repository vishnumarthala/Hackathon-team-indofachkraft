// Ticket 043 against the real database through the route handlers: create (FR-2/FR-3) with exact occurrence counts,
// idempotent and concurrent materialization (NFR-1), conflicts (slot taken, blocked date, outside hours) and their
// resolution (FR-6), "this and future" / pause / end (FR-5), "this session only" through 030's routes, notifications
// (FR-8: one summary, one message per change, next reminder only, nothing for paper-consent children), authz (404 for
// non-members, 403 for guardians), cron horizon (FR-4), privacy export/erasure, and the 200 x 8 weeks timing.
// Synthetic users only; skipped without DATABASE_URL.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn, weekdayOf } from "@/lib/booking/time";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, key, type TestProvider } from "./helpers/booking";
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

type Json = Record<string, unknown>;
const TZ = "Asia/Kolkata";
/** The instant of `date` at `time` in IST (no DST in India). */
const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

describe.skipIf(!enabled)("weekly series (database, route handlers)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let owner: TestProvider;
  let outsider: TestProvider;
  let member: TestUser;
  let svc45: string;
  let svc30: string;
  let family: { user: TestUser; childId: string };
  let otherFamily: { user: TestUser; childId: string };
  let caseId: string;
  let paperCaseId: string;
  let paperChildId: string;
  /** First Monday after today (IST), 1-7 days ahead: every occurrence of the suite is in the future. */
  let M0: string;
  const extraProfiles: string[] = [];
  let routes: {
    create: typeof import("@/app/api/provider/series/route");
    one: typeof import("@/app/api/provider/series/[id]/route");
    change: typeof import("@/app/api/provider/series/[id]/change/route");
    pause: typeof import("@/app/api/provider/series/[id]/pause/route");
    end: typeof import("@/app/api/provider/series/[id]/end/route");
    conflict: typeof import("@/app/api/provider/series/conflicts/[id]/route");
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    cancel: typeof import("@/app/api/appointments/[id]/cancel/route");
    reschedule: typeof import("@/app/api/appointments/[id]/reschedule/route");
    complete: typeof import("@/app/api/appointments/[id]/complete/route");
    cron: typeof import("@/app/api/cron/booking/route");
  };
  let series: typeof import("@/lib/booking/series");

  const as = (user: TestUser | null) => {
    session.user = user;
    session.cookies.clear();
  };
  const create = (body: Json) => call(routes.create.POST, post("http://localhost/api/provider/series", body));
  const seriesBody = (over: Json): Json => ({
    case_id: caseId,
    provider_profile_id: owner.profileId,
    service_id: svc45,
    billing_mode: "per_session",
    ...over,
  });
  const occurrences = (seriesId: string) => sql<{ id: string; date: string | null; local: string; status: string; cancel_reason: string | null; cancelled_by: string | null }[]>`
    select id, series_occurrence_date::text as date, to_char(lower(slot) at time zone ${TZ}, 'YYYY-MM-DD HH24:MI') as local, status, cancel_reason, cancelled_by
    from appointments where series_id = ${seriesId} order by lower(slot)`;
  const seriesEvents = (seriesId: string) => sql<{ topic: string; dedup_key: string; status: string; payload: Json }[]>`
    select topic, dedup_key, status, payload from outbox_events where aggregate_type = 'appointment_series' and aggregate_id = ${seriesId} order by id`;
  const appointmentEvents = async (ids: string[]) =>
    ids.length
      ? sql<{ topic: string; status: string; appt: string; deliver_after: Date }[]>`
          select topic, status, aggregate_id::text as appt, deliver_after from outbox_events
          where aggregate_type = 'appointment' and aggregate_id in ${sql(ids)} order by id`
      : [];

  /** Per-session messages that were not withdrawn in the changing transaction (series changes send one message). */
  const liveCancelMessages = async (ids: string[]) =>
    (await appointmentEvents(ids)).filter((e) => e.status !== "cancelled" && e.topic !== "appointment.reminder_day_before");

  beforeAll(async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-043");
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t043s");
    // Eval set-up: weekly hours Mon-Fri 09:00-17:00 (IST), an in-clinic 45-minute service.
    owner = await world.provider("pa", { allWeek: false });
    for (const weekday of [0, 1, 2, 3, 4]) {
      await sql`
        insert into availability_rules (provider_profile_id, org_id, location_id, weekday, start_time, end_time, mode, valid_from)
        values (${owner.profileId}, ${owner.orgId}, ${owner.locationId}, ${weekday}, '09:00', '17:00', 'both', current_date - 2)`;
    }
    svc45 = await world.service(owner, { duration: 45, payment: "at_clinic", fee: 800, name: "Speech therapy (synthetic)" });
    svc30 = await world.service(owner, { duration: 30, payment: "free" });
    outsider = await world.provider("pb");
    family = await world.guardian("ga");
    otherFamily = await world.guardian("gb");
    caseId = (await world.kase(owner.orgId, { childId: family.childId })).caseId;
    const paper = await world.kase(owner.orgId);
    paperCaseId = paper.caseId;
    paperChildId = paper.childId;
    member = await world.user("member", "provider");
    await world.member(owner.orgId, member);
    await sql`select public.add_case_assignment(${caseId}, ${member.id}, 'member', 'Speech therapist', ${owner.user.id})`;
    const today = todayIn(TZ);
    M0 = addDays(today, 7 - weekdayOf(today));
    series = await import("@/lib/booking/series");
    routes = {
      create: await import("@/app/api/provider/series/route"),
      one: await import("@/app/api/provider/series/[id]/route"),
      change: await import("@/app/api/provider/series/[id]/change/route"),
      pause: await import("@/app/api/provider/series/[id]/pause/route"),
      end: await import("@/app/api/provider/series/[id]/end/route"),
      conflict: await import("@/app/api/provider/series/conflicts/[id]/route"),
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      cancel: await import("@/app/api/appointments/[id]/cancel/route"),
      reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
      complete: await import("@/app/api/appointments/[id]/complete/route"),
      cron: await import("@/app/api/cron/booking/route"),
    };
  });

  beforeEach(async () => {
    const { holdLimiter, slotsLimiter } = await import("@/lib/booking/rate-limit");
    holdLimiter.reset();
    slotsLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql) {
      const profiles = [owner?.profileId, outsider?.profileId, ...extraProfiles].filter(Boolean) as string[];
      const ids = profiles.length ? (await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id in ${sql(profiles)}`).map((r) => r.id) : [];
      if (ids.length) {
        await sql`delete from outbox_events where aggregate_type = 'appointment_series' and aggregate_id in ${sql(ids)}`;
        await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity in ('appointment_series', 'series_conflict') and actor_user_id = ${owner.user.id}`);
      }
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  describe("create + materialize (FR-2, FR-3, FR-8)", () => {
    it("Mon/Wed/Fri -> 24 occurrences in 8 weeks at the clinic's local time; a second run adds nothing", async () => {
      as(owner.user);
      const res = await create(seriesBody({ weekdays: [0, 2, 4], start_time: "09:00", starts_on: M0, ends_on: addDays(M0, 55) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = res.json.series_id as string;
      expect(res.json.conflicts).toEqual([]);
      // The cron extends the horizon day by day; here the whole 8 weeks at once.
      await series.materializeSeries(id, addDays(M0, 55));
      const rows = await occurrences(id);
      expect(rows).toHaveLength(24);
      expect(rows.every((r) => r.status === "confirmed" && r.local.endsWith(" 09:00"))).toBe(true);
      expect(new Set(rows.map((r) => weekdayOf(r.date!)))).toEqual(new Set([0, 2, 4]));
      expect(new Set(rows.map((r) => r.date)).size).toBe(24);

      const again = await series.materializeSeries(id, addDays(M0, 55));
      expect(again.created).toBe(0);
      expect(await occurrences(id)).toHaveLength(24);

      // Rule 11: the snapshot is frozen on the series and copied into every occurrence.
      const [snap] = await sql<{ name: string; billing: string; series: number }[]>`
        select service_snapshot ->> 'name' as name, service_snapshot ->> 'billing_mode' as billing,
               (select count(distinct service_snapshot) from appointments where series_id = ${id})::int as series
        from appointment_series where id = ${id}`;
      expect(snap).toEqual({ name: "Speech therapy (synthetic)", billing: "per_session", series: 1 });

      // FR-8: one summary message; reminders only for the next occurrence (24 h before); no per-session confirmation.
      const events = await seriesEvents(id);
      expect(events.map((e) => e.topic)).toEqual(["series.created"]);
      expect(events[0].payload).toMatchObject({ series_id: id, weekdays: [0, 2, 4], start_time: "09:00", mode: "in_clinic" });
      expect(JSON.stringify(events[0].payload)).not.toContain("child");
      const appts = await appointmentEvents(rows.map((r) => r.id));
      expect(appts.map((e) => e.topic)).toEqual(["appointment.reminder_day_before"]);
      const next = rows.find((r) => ist(r.date!, "09:00").getTime() - 86_400_000 > Date.now())!;
      expect(appts[0].appt).toBe(next.id);
      expect(appts[0].deliver_after.getTime()).toBe(ist(next.date!, "09:00").getTime() - 86_400_000);
      const { TOPICS } = await import("@/lib/notify/topics");
      const recipients = await TOPICS["series.created"].recipients(events[0].payload as never, { sql, event: {} as never });
      expect(recipients).toEqual([family.user.id]);
    });

    it("E-1: Mon/Wed 10:00 for 8 weeks -> 16 sessions marked as repeats on the agenda; the family sees 'Every Mon, Wed'", async () => {
      as(owner.user);
      const res = await create(seriesBody({ weekdays: [0, 2], start_time: "10:00", starts_on: M0, ends_on: addDays(M0, 55) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = res.json.series_id as string;
      await series.materializeSeries(id, addDays(M0, 55));
      expect((await occurrences(id)).filter((r) => r.status === "confirmed")).toHaveLength(16);

      const { listAgenda, listGuardianAppointments } = await import("@/lib/booking/store");
      const agenda = await listAgenda(owner.profileId, ist(M0, "00:00"), ist(addDays(M0, 56), "00:00"));
      const mine = agenda.filter((a) => a.series_id === id);
      expect(mine).toHaveLength(16);
      // 10:00 is off the 45-minute booking grid (09:00, 09:45, 10:30): series sessions are not flagged as outside hours.
      expect(mine.every((a) => !a.outside_availability)).toBe(true);

      const familySeries = await series.listGuardianSeries(family.user.id);
      const s = familySeries.find((x) => x.id === id)!;
      const { seriesSummary } = await import("@/lib/booking/series-display");
      const summary = seriesSummary(s, TZ, "en");
      expect(summary.days).toBe("Mon, Wed");
      expect(summary.time).toMatch(/^10:00\sam IST$/i);
      expect((await listGuardianAppointments(family.user.id)).filter((a) => a.series_id === id)).toHaveLength(16);
    });

    it("E-4: a paper-consent child (no family account) gets a timetable and no notification at all", async () => {
      as(owner.user);
      const res = await create(seriesBody({ case_id: paperCaseId, weekdays: [3], start_time: "12:00", starts_on: addDays(M0, 3), ends_on: addDays(M0, 24) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = res.json.series_id as string;
      const rows = await occurrences(id);
      expect(rows.length).toBe(4);
      const [s] = await sql<{ guardian_user_id: string | null; child_id: string }[]>`select guardian_user_id, child_id from appointment_series where id = ${id}`;
      expect(s).toEqual({ guardian_user_id: null, child_id: paperChildId });
      expect(await seriesEvents(id)).toEqual([]);
      expect(await appointmentEvents(rows.map((r) => r.id))).toEqual([]);
      // A change sends nothing either.
      expect((await call(routes.end.POST, post(`http://localhost/api/provider/series/${id}/end`, { ends_on: addDays(M0, 10) }), { id })).status).toBe(200);
      expect(await seriesEvents(id)).toEqual([]);
      expect((await occurrences(id)).filter((r) => r.status === "confirmed").map((r) => r.date)).toEqual([addDays(M0, 3), addDays(M0, 10)]);
    });

    it("validates: 1-4 weekdays, a service of that therapist in the org, a start date not in the past", async () => {
      as(owner.user);
      expect((await create(seriesBody({ weekdays: [0, 1, 2, 3, 4], start_time: "09:00", starts_on: M0 }))).status).toBe(400);
      const otherService = await world.service(outsider, { duration: 45 });
      const wrong = await create(seriesBody({ service_id: otherService, weekdays: [0], start_time: "09:00", starts_on: M0 }));
      expect(wrong.status).toBe(422);
      expect(wrong.json.code).toBe("service_invalid");
      const past = await create(seriesBody({ weekdays: [0], start_time: "09:00", starts_on: addDays(todayIn(TZ), -1) }));
      expect(past.json.code).toBe("starts_in_past");
    });
  });

  describe("conflicts (FR-3, FR-6)", () => {
    it("E-2: a one-off booking on Wednesday -> slot_taken conflict, no appointment; Pick another time resolves it", async () => {
      // A family books a one-off on Wednesday next week at 15:00 through 030's booking flow.
      as(otherFamily.user);
      const wed = addDays(M0, 2);
      const hold = await call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: svc30, start: ist(wed, "15:00").toISOString(), idempotency_key: key() }));
      expect(hold.status, JSON.stringify(hold.json)).toBe(201);
      const oneOff = hold.json.appointment_id as string;
      const conf = await call(routes.confirm.POST, post(`http://localhost/api/appointments/${oneOff}/confirm`, { child_id: otherFamily.childId }), { id: oneOff });
      expect(conf.status, JSON.stringify(conf.json)).toBe(200);

      as(owner.user);
      const res = await create(seriesBody({ weekdays: [0, 2], start_time: "15:00", starts_on: M0, ends_on: addDays(M0, 13) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = res.json.series_id as string;
      expect(res.json.conflicts).toEqual([{ date: wed, reason: "slot_taken" }]);
      expect((await occurrences(id)).map((r) => r.date)).toEqual([M0, addDays(M0, 7), addDays(M0, 9)]);

      const listed = (await series.listManageableConflicts(owner.user.id)).filter((c) => c.series_id === id);
      expect(listed.map((c) => [c.occurrence_date, c.reason])).toEqual([[wed, "slot_taken"]]);
      expect(new Date(listed[0].usual_start).getTime()).toBe(ist(wed, "15:00").getTime());
      const conflictId = listed[0].id;

      // Other tenants and families cannot touch it.
      as(outsider.user);
      expect((await call(routes.conflict.POST, post(`http://localhost/api/provider/series/conflicts/${conflictId}`, { action: "skip" }), { id: conflictId })).status).toBe(404);
      as(family.user);
      expect((await call(routes.conflict.POST, post(`http://localhost/api/provider/series/conflicts/${conflictId}`, { action: "skip" }), { id: conflictId })).status).toBe(403);

      as(owner.user);
      const resolve = (body: Json) => call(routes.conflict.POST, post(`http://localhost/api/provider/series/conflicts/${conflictId}`, body), { id: conflictId });
      // The same time is still taken; 18:00 is outside the weekly hours.
      expect((await resolve({ action: "reschedule", start: ist(wed, "15:00").toISOString() })).json.code).toBe("slot_taken");
      expect((await resolve({ action: "reschedule", start: ist(wed, "18:00").toISOString() })).json.code).toBe("outside_hours");
      const picked = await resolve({ action: "reschedule", start: ist(wed, "16:00").toISOString() });
      expect(picked.status, JSON.stringify(picked.json)).toBe(200);
      const rows = await occurrences(id);
      expect(rows.find((r) => r.date === wed)).toMatchObject({ local: `${wed} 16:00`, status: "confirmed" });
      expect((await series.listManageableConflicts(owner.user.id)).some((c) => c.id === conflictId)).toBe(false);
      expect((await resolve({ action: "skip" })).json.code).toBe("already_resolved");
      // One message for the moved session (plus the summary).
      expect((await seriesEvents(id)).map((e) => [e.topic, e.payload.change ?? null])).toEqual([
        ["series.created", null],
        ["series.changed", "moved"],
      ]);
      // The one-off is untouched.
      const [one] = await sql<{ status: string }[]>`select status from appointments where id = ${oneOff}`;
      expect(one.status).toBe("confirmed");
    });

    it("a blocked date -> blocked_date; a day outside the weekly hours -> outside_hours; Skip this date is final", async () => {
      as(owner.user);
      const blockedMonday = addDays(M0, 49);
      await sql`
        insert into availability_overrides (provider_profile_id, date, kind, start_time, end_time, note)
        values (${owner.profileId}, ${blockedMonday}, 'unavailable', '16:00', '17:00', 'synthetic')`;
      const res = await create(seriesBody({ weekdays: [0, 5], start_time: "16:00", starts_on: addDays(M0, 42), ends_on: addDays(M0, 55) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = res.json.series_id as string;
      const result = await series.materializeSeries(id, addDays(M0, 55));
      const all = [...(res.json.conflicts as { date: string; reason: string }[]), ...result.conflicts];
      expect(all.sort((a, b) => a.date.localeCompare(b.date))).toEqual([
        { date: addDays(M0, 47), reason: "outside_hours" },
        { date: blockedMonday, reason: "blocked_date" },
        { date: addDays(M0, 54), reason: "outside_hours" },
      ]);
      expect((await occurrences(id)).map((r) => r.date)).toEqual([addDays(M0, 42)]);

      const [c] = await sql<{ id: string }[]>`select id from series_conflicts where series_id = ${id} and occurrence_date = ${blockedMonday}`;
      const skip = await call(routes.conflict.POST, post(`http://localhost/api/provider/series/conflicts/${c.id}`, { action: "skip" }), { id: c.id });
      expect(skip.status).toBe(200);
      await sql`delete from availability_overrides where provider_profile_id = ${owner.profileId} and date = ${blockedMonday}`;
      await sql`update appointment_series set materialized_until = null where id = ${id}`;
      await series.materializeSeries(id, addDays(M0, 55));
      expect((await occurrences(id)).map((r) => r.date)).toEqual([addDays(M0, 42)]);
      expect((await seriesEvents(id)).at(-1)).toMatchObject({ topic: "series.changed", payload: { change: "skipped", date: blockedMonday } });
    });
  });

  describe("changes (FR-5)", () => {
    it("E-3: 'This and future' from week 3 moves 11:00 -> 13:00; weeks 1-2 and touched sessions stay; one change message", async () => {
      // A one-off already sits on Wednesday of week 3 at 11:00, so that date becomes a conflict, then a session at 12:00
      // (a "touched" occurrence: not at the series time).
      const wk3wed = addDays(M0, 16);
      await sql`
        insert into appointments (provider_profile_id, org_id, service_id, service_snapshot, slot, status)
        select ${owner.profileId}, ${owner.orgId}, id, jsonb_build_object('name', name, 'duration_min', 45, 'mode', 'in_clinic', 'fee_inr', 0, 'payment_mode', 'free', 'location', null),
               tstzrange(${ist(wk3wed, "11:00").toISOString()}::timestamptz, ${ist(wk3wed, "11:45").toISOString()}::timestamptz, '[)'), 'confirmed'
        from services where id = ${svc45}`;
      as(owner.user);
      const res = await create(seriesBody({ weekdays: [0, 2], start_time: "11:00", starts_on: M0, ends_on: addDays(M0, 27) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const oldId = res.json.series_id as string;
      expect(res.json.conflicts).toEqual([{ date: wk3wed, reason: "slot_taken" }]);
      const [conflict] = await sql<{ id: string }[]>`select id from series_conflicts where series_id = ${oldId}`;
      expect((await call(routes.conflict.POST, post(`http://localhost/api/provider/series/conflicts/${conflict.id}`, { action: "reschedule", start: ist(wk3wed, "12:00").toISOString() }), { id: conflict.id })).status).toBe(200);
      const eventsBefore = (await seriesEvents(oldId)).length;

      const from = addDays(M0, 14);
      const change = await call(routes.change.POST, post(`http://localhost/api/provider/series/${oldId}/change`, { from, start_time: "13:00" }), { id: oldId });
      expect(change.status, JSON.stringify(change.json)).toBe(201);
      const newId = change.json.series_id as string;
      // Untouched sessions from week 3: Mon of week 3 and Mon + Wed of week 4 (week 3's Wednesday was moved to 12:00).
      expect(change.json.cancelled).toBe(3);
      await series.materializeSeries(newId, addDays(M0, 27));

      const old = await occurrences(oldId);
      const byDate = (d: string) => old.find((r) => r.date === d)!;
      for (const d of [M0, addDays(M0, 2), addDays(M0, 7), addDays(M0, 9)]) expect(byDate(d)).toMatchObject({ status: "confirmed", local: `${d} 11:00` });
      expect(byDate(wk3wed)).toMatchObject({ status: "confirmed", local: `${wk3wed} 12:00` });
      for (const d of [from, addDays(M0, 21), addDays(M0, 23)]) {
        expect(byDate(d)).toMatchObject({ status: "cancelled", cancel_reason: "series_changed", cancelled_by: "provider" });
      }
      expect(old.filter((r) => r.status === "cancelled").map((r) => r.date)).toEqual([from, addDays(M0, 21), addDays(M0, 23)]);
      const fresh = await occurrences(newId);
      expect(fresh.map((r) => r.local)).toEqual([from, wk3wed, addDays(M0, 21), addDays(M0, 23)].map((d) => `${d} 13:00`));
      const [oldSeries] = await sql<{ ends_on: string; status: string }[]>`select ends_on::text, status from appointment_series where id = ${oldId}`;
      expect(oldSeries).toEqual({ ends_on: addDays(M0, 13), status: "active" });

      // FR-8: exactly one message for the change (no summary for the new series, no per-session cancellations).
      expect((await seriesEvents(oldId)).length).toBe(eventsBefore);
      expect((await seriesEvents(newId)).map((e) => [e.topic, e.payload.change, e.payload.start_time])).toEqual([["series.changed", "time_changed", "13:00"]]);
      const cancelledIds = old.filter((r) => r.status === "cancelled").map((r) => r.id);
      expect(await liveCancelMessages(cancelledIds)).toEqual([]);
      // Past the change date the old series is closed to further changes from that date.
      expect((await call(routes.change.POST, post(`http://localhost/api/provider/series/${oldId}/change`, { from: addDays(M0, 21), start_time: "14:00" }), { id: oldId })).status).toBe(400);
    });

    it("Pause cancels the range only; past sessions never change; a second pause is refused; the horizon skips the window", async () => {
      as(owner.user);
      const tue = addDays(M0, 1);
      const res = await create(seriesBody({ weekdays: [1, 3], start_time: "14:00", starts_on: tue, ends_on: addDays(tue, 27) }));
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const id = res.json.series_id as string;
      await series.materializeSeries(id, addDays(tue, 27));
      const before = await occurrences(id);
      expect(before).toHaveLength(8);
      // Time travel: the first session already took place (yesterday).
      await sql`update appointments set slot = tstzrange(now() - interval '1 day', now() - interval '1 day' + interval '45 minutes', '[)') where id = ${before[0].id}`;

      const pause = await call(routes.pause.POST, post(`http://localhost/api/provider/series/${id}/pause`, { from: tue, to: addDays(tue, 13) }), { id });
      expect(pause.status, JSON.stringify(pause.json)).toBe(200);
      expect(pause.json.cancelled).toBe(3);
      const after = await occurrences(id);
      expect(after.find((r) => r.id === before[0].id)!.status).toBe("confirmed");
      expect(after.filter((r) => r.status === "cancelled").map((r) => r.date)).toEqual([addDays(tue, 2), addDays(tue, 7), addDays(tue, 9)]);
      expect(after.filter((r) => r.status === "cancelled").every((r) => r.cancel_reason === "series_paused")).toBe(true);
      expect(after.filter((r) => r.status === "confirmed")).toHaveLength(5);

      const events = await seriesEvents(id);
      expect(events.at(-1)).toMatchObject({ topic: "series.changed", payload: { change: "paused", date: tue, until: addDays(tue, 13) } });
      expect(await liveCancelMessages(after.filter((r) => r.status === "cancelled").map((r) => r.id))).toEqual([]);
      const again = await call(routes.pause.POST, post(`http://localhost/api/provider/series/${id}/pause`, { from: addDays(tue, 14), to: addDays(tue, 20) }), { id });
      expect(again.status).toBe(409);
      expect(again.json.code).toBe("pause_exists");
      await sql`update appointment_series set materialized_until = null where id = ${id}`;
      expect((await series.materializeSeries(id, addDays(tue, 27))).created).toBe(0);
    });

    it("This session only: 030's reschedule keeps the session in its series; a guardian may cancel one session; neither comes back", async () => {
      const [e1] = await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id = ${owner.profileId} and start_time = '10:00' and weekdays = '{0,2}'`;
      const rows = await occurrences(e1.id);
      const monday = rows.find((r) => r.date === M0)!;
      as(owner.user);
      const moved = await call(routes.reschedule.POST, post(`http://localhost/api/appointments/${monday.id}/reschedule`, { start: ist(M0, "12:00").toISOString() }), { id: monday.id });
      expect(moved.status, JSON.stringify(moved.json)).toBe(200);
      const [fresh] = await sql<{ series_id: string; series_occurrence_date: string | null }[]>`
        select series_id, series_occurrence_date::text from appointments where id = ${(moved.json.appointment as Json).id as string}`;
      expect(fresh).toEqual({ series_id: e1.id, series_occurrence_date: null });

      const wed = rows.find((r) => r.date === addDays(M0, 2))!;
      as(family.user);
      const cancelled = await call(routes.cancel.POST, post(`http://localhost/api/appointments/${wed.id}/cancel`, {}), { id: wed.id });
      expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);
      // A guardian cannot touch the series itself.
      expect((await call(routes.end.POST, post(`http://localhost/api/provider/series/${e1.id}/end`, {}), { id: e1.id })).status).toBe(403);

      await sql`update appointment_series set materialized_until = null where id = ${e1.id}`;
      expect((await series.materializeSeries(e1.id, addDays(M0, 55))).created).toBe(0);
      const now = await occurrences(e1.id);
      expect(now.filter((r) => r.status === "confirmed")).toHaveLength(15);
      expect(now.find((r) => r.id === wed.id)).toMatchObject({ status: "cancelled", cancelled_by: "guardian" });
      // The single cancellation is a single-session change: 030's appointment.cancelled message.
      expect((await appointmentEvents([wed.id])).map((e) => e.topic)).toContain("appointment.cancelled");
    });

    it("a completed series session does not prompt the family for a rating after every session", async () => {
      const [e1] = await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id = ${owner.profileId} and start_time = '10:00' and weekdays = '{0,2}'`;
      const last = (await occurrences(e1.id)).filter((r) => r.status === "confirmed").at(-1)!;
      // Time travel: the session started an hour ago.
      await sql`update appointments set slot = tstzrange(now() - interval '1 hour', now() - interval '15 minutes', '[)') where id = ${last.id}`;
      as(owner.user);
      const done = await call(routes.complete.POST, post(`http://localhost/api/appointments/${last.id}/complete`, { status: "completed" }), { id: last.id });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      const prompts = (await appointmentEvents([last.id])).filter((e) => e.topic === "appointment.rate_prompt");
      expect(prompts.map((e) => e.status)).toEqual(["cancelled"]);
    });

    it("End: nothing after the last day; later sessions cancelled; one message", async () => {
      const [t1] = await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id = ${owner.profileId} and start_time = '09:00' and weekdays = '{0,2,4}'`;
      as(owner.user);
      const last = addDays(M0, 20);
      const res = await call(routes.end.POST, post(`http://localhost/api/provider/series/${t1.id}/end`, { ends_on: last }), { id: t1.id });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.cancelled).toBe(15);
      const rows = await occurrences(t1.id);
      expect(rows.filter((r) => r.status === "confirmed").every((r) => r.date! <= last)).toBe(true);
      expect(rows.filter((r) => r.status === "cancelled").every((r) => r.cancel_reason === "series_ended" && r.date! > last)).toBe(true);
      expect((await seriesEvents(t1.id)).filter((e) => e.topic === "series.changed").map((e) => e.payload.change)).toEqual(["ended"]);
    });
  });

  describe("authorisation (FR-2)", () => {
    it("a non-member provider gets 404 everywhere; a guardian gets 403; a member cannot schedule another therapist", async () => {
      const [anySeries] = await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id = ${owner.profileId} limit 1`;
      const body = seriesBody({ weekdays: [4], start_time: "15:00", starts_on: M0 });
      as(outsider.user);
      expect((await create(body)).status).toBe(404);
      expect((await create({ ...body, provider_profile_id: outsider.profileId })).status).toBe(404);
      expect((await call(routes.one.GET, new Request("http://localhost/x"), { id: anySeries.id })).status).toBe(404);
      for (const [route, payload] of [
        [routes.pause, { from: M0, to: M0 }],
        [routes.end, {}],
        [routes.change, { from: M0, start_time: "09:00" }],
      ] as const) {
        expect((await call(route.POST, post("http://localhost/x", payload), { id: anySeries.id })).status).toBe(404);
      }
      expect((await call(routes.one.GET, new Request("http://localhost/x"), { id: "not-a-uuid" })).status).toBe(404);

      as(family.user);
      expect((await create(body)).status).toBe(403);
      expect((await call(routes.pause.POST, post("http://localhost/x", { from: M0, to: M0 }), { id: anySeries.id })).status).toBe(403);

      // Assigned to the case, but neither owner/admin nor the therapist of that profile.
      as(member);
      expect((await create(body)).status).toBe(404);
      expect((await call(routes.one.GET, new Request("http://localhost/x"), { id: anySeries.id })).status).toBe(404);
      as(null);
      expect((await create(body)).status).toBe(401);

      as(owner.user);
      const mine = await call(routes.one.GET, new Request("http://localhost/x"), { id: anySeries.id });
      expect(mine.status).toBe(200);
      expect((mine.json.occurrences as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe("horizon and scale (FR-4, NFR-1)", () => {
    async function bulkSeries(count: number, prefix: string): Promise<string[]> {
      const providers: TestProvider[] = [];
      for (let i = 0; i < Math.ceil(count / 50); i++) providers.push(await world.provider(`${prefix}${i}`));
      extraProfiles.push(...providers.map((p) => p.profileId));
      const ids: string[] = [];
      for (const [n, p] of providers.entries()) {
        const { childId, caseId: cid } = await world.kase(p.orgId);
        const svc = await world.service(p, { duration: 45 });
        const take = Math.min(50, count - n * 50);
        // Distinct 45-minute slots per provider: 32 a day on Mon/Wed/Fri and 32 on Tue/Thu/Sat never overlap.
        const rows = await sql<{ id: string }[]>`
          insert into appointment_series (org_id, provider_profile_id, service_id, service_snapshot, child_id, case_id, weekdays, start_time,
                                          time_zone, starts_on, ends_on, billing_mode, created_by)
          select ${p.orgId}::uuid, ${p.profileId}::uuid, s.id,
                 jsonb_build_object('name', s.name, 'duration_min', 45, 'mode', 'in_clinic', 'fee_inr', 0, 'payment_mode', 'free', 'buffer_min', 0,
                   'provider_name', 'Synthetic', 'time_zone', ${TZ}::text, 'location', jsonb_build_object('id', s.location_id, 'name', 'Synthetic clinic', 'address', 'Road 1', 'time_zone', ${TZ}::text)),
                 ${childId}::uuid, ${cid}::uuid, case when g % 2 = 0 then '{0,2,4}'::smallint[] else '{1,3,5}'::smallint[] end,
                 time '00:00' + make_interval(mins => 45 * (g / 2)), ${TZ}::text, ${M0}::date, ${addDays(M0, 55)}::date, 'free', ${p.user.id}::uuid
          from services s, generate_series(0, ${take - 1}::int) g where s.id = ${svc}
          returning id`;
        ids.push(...rows.map((r) => r.id));
      }
      return ids;
    }

    it("two concurrent workers materializing the same series create no duplicates and no errors", async () => {
      const ids = await bulkSeries(12, "cc");
      const sql2 = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
      try {
        const run = async (db: Sql, list: string[]) => {
          for (const id of list) await db`select public.series_materialize(${id}::uuid, ${addDays(M0, 55)}::date)`;
        };
        await Promise.all([run(sql, ids), run(sql2, [...ids].reverse())]);
      } finally {
        await sql2.end({ timeout: 5 });
      }
      const [{ n, dates }] = await sql<{ n: number; dates: number }[]>`
        select count(*)::int as n, count(distinct (series_id, series_occurrence_date))::int as dates
        from appointments where series_id in ${sql(ids)} and status = 'confirmed'`;
      expect(n).toBe(12 * 24);
      expect(dates).toBe(12 * 24);
      expect((await sql`select 1 from series_conflicts where series_id in ${sql(ids)}`).length).toBe(0);
    });

    it("200 series x 8 weeks materialize in under 10 s", async () => {
      const ids = await bulkSeries(200, "perf");
      const started = performance.now();
      const totals = await series.materializeMany(ids, { concurrency: 4, until: addDays(M0, 55) });
      const ms = performance.now() - started;
      expect(totals.failed).toBe(0);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from appointments where series_id in ${sql(ids)} and status = 'confirmed'`;
      expect(n).toBe(200 * 24);
      console.info(`[043] materialized 200 series x 8 weeks (${n} sessions) in ${Math.round(ms)} ms`);
      expect(ms).toBeLessThan(10_000);
    });

    it("the booking cron runs the rolling horizon (secret required)", async () => {
      expect((await call(routes.cron.POST, new Request("http://localhost/api/cron/booking", { method: "POST" }))).status).toBe(401);
      const run = await call(routes.cron.POST, new Request("http://localhost/api/cron/booking", { method: "POST", headers: { Authorization: "Bearer test-cron-043" } }));
      expect(run.status).toBe(200);
      expect(run.json.series).toMatchObject({ failed: 0 });
      expect((run.json.series as { series: number }).series).toBeGreaterThan(0);
    });
  });

  describe("privacy (041 registry)", () => {
    it("exports the child's timetables and erasure cancels future sessions quietly and deletes the series", async () => {
      const { REGISTRY } = await import("@/lib/privacy/registry");
      const category = REGISTRY.find((c) => c.key === "appointment_series")!;
      expect(category.tables).toEqual(["appointment_series", "series_conflicts"]);
      expect(REGISTRY.findIndex((c) => c.key === "appointment_series")).toBeLessThan(REGISTRY.findIndex((c) => c.key === "appointments"));
      const exported = (await category.export!({ sql, childId: family.childId, guardianUserId: family.user.id }))!.data as Json[];
      expect(exported.length).toBeGreaterThan(0);
      expect(JSON.stringify(exported)).not.toContain("child (synthetic)");

      const [paper] = await sql<{ id: string }[]>`select id from appointment_series where child_id = ${paperChildId}`;
      const future = (await occurrences(paper.id)).filter((r) => r.status === "confirmed").map((r) => r.id);
      expect(future.length).toBeGreaterThan(0);
      await sql.begin(async (tx) => {
        await category.erase!.rows!(tx, { childId: paperChildId, requestId: paper.id, scope: "everything", requestedBy: owner.user.id, caseIds: [paperCaseId] });
      });
      expect(await sql`select 1 from appointment_series where child_id = ${paperChildId}`).toHaveLength(0);
      const statuses = await sql<{ status: string; cancel_reason: string }[]>`select status, cancel_reason from appointments where id in ${sql(future)}`;
      expect(statuses.every((r) => r.status === "cancelled" && r.cancel_reason === "erasure")).toBe(true);
      expect(await liveCancelMessages(future)).toEqual([]);
    });
  });
});
