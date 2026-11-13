// Ticket 044 against the real database through the route handlers: present -> completed + billable, absent -> no_show
// (billable only with bill_absent), late family cancellation inside / outside the window (billable only with
// bill_late_cancel), centre cancellation never billable, the start-time rule (409 before the start except cancel types),
// the 7-day member window (403) and owner corrections with a reason (audited), one event per double submit (NFR-2),
// authz (404 other tenants, 403 guardians, 401 anonymous), `Mark all remaining present`, the register (owner/admin all,
// members their own; 60 sessions < 1 s), `Needs attention`, the case month + CSV, the org policy route, 030's complete
// route keeping attendance in step, a weekly-series session, and the late-cancel refund rule for online prepayments.
// Synthetic users only; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, todayIn, wallToUtc } from "@/lib/booking/time";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, type TestProvider } from "./helpers/booking";
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
const HOUR = 60;
const DAY = 24 * HOUR;

async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.clone().json().catch(() => ({}))) as Json, res };
}

describe.skipIf(!enabled)("attendance register (database, route handlers)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let owner: TestProvider; // owner of the centre, also a therapist (profile bound)
  let outsider: TestProvider;
  let frontDesk: TestUser; // admin of the centre, no profile
  let therapist: { user: TestUser; profileId: string; serviceId: string }; // member therapist
  let paidService: string;
  let freeService: string;
  let onlineService: string;
  let family: { user: TestUser; childId: string };
  let caseId: string;
  const extraProfiles: string[] = [];
  /** Distinct past / future offsets (minutes from now) so no two confirmed sessions of a provider overlap. */
  let pastCursor = -2 * HOUR;
  let futureCursor = 3 * HOUR;
  const past = () => (pastCursor -= HOUR);
  const future = () => (futureCursor += HOUR);
  let routes: {
    mark: typeof import("@/app/api/appointments/[id]/attendance/route");
    markAll: typeof import("@/app/api/attendance/mark-all/route");
    policy: typeof import("@/app/api/orgs/[id]/attendance-policy/route");
    caseMonth: typeof import("@/app/api/cases/[id]/attendance/route");
    complete: typeof import("@/app/api/appointments/[id]/complete/route");
  };
  let attendance: typeof import("@/lib/booking/attendance");

  const as = (user: TestUser | null) => {
    session.user = user;
    session.cookies.clear();
    session.cookies.set("dnm_tz", TZ);
  };
  const mark = (id: string, body: Json) => call(routes.mark.POST, post(`http://localhost/api/appointments/${id}/attendance`, body), { id });
  const setPolicy = (policy: Json) => call(routes.policy.PUT, post(`http://localhost/api/orgs/${owner.orgId}/attendance-policy`, policy, "PUT"), { id: owner.orgId });
  const DEFAULT = { bill_absent: false, bill_late_cancel: false, late_cancel_hours: 24 };

  /** A confirmed appointment `offset` minutes from now (raw insert: past sessions cannot be booked through 030). */
  async function appt(serviceId: string, offset: number, opts: { duration?: number; withChild?: boolean } = {}): Promise<string> {
    const duration = opts.duration ?? 30;
    const withChild = opts.withChild ?? true;
    const [row] = await sql<{ id: string }[]>`
      insert into appointments (provider_profile_id, org_id, service_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status)
      select s.provider_profile_id, s.org_id, s.id,
             jsonb_build_object('name', s.name, 'duration_min', ${duration}::int, 'mode', s.mode, 'fee_inr', s.fee_inr,
                                'payment_mode', s.payment_mode, 'buffer_min', 0, 'provider_name', p.display_name,
                                'time_zone', ${TZ}::text, 'location', null),
             ${withChild ? family.childId : null}::uuid, ${withChild ? family.user.id : null}::uuid, ${withChild ? caseId : null}::uuid,
             tstzrange(now() + make_interval(mins => ${offset}), now() + make_interval(mins => ${offset + duration}), '[)'), 'confirmed'
      from services s join provider_profiles p on p.id = s.provider_profile_id where s.id = ${serviceId}
      returning id`;
    return row.id;
  }
  const row = async (id: string) =>
    (
      await sql<{ status: string; attendance: string | null; billable: boolean | null; marked_by: string | null; cancel_reason: string | null; cancelled_by: string | null }[]>`
        select status, attendance, billable, attendance_marked_by as marked_by, cancel_reason, cancelled_by from appointments where id = ${id}`
    )[0];
  const history = (id: string) =>
    sql<{ from_status: string | null; to_status: string; actor_user_id: string | null; reason: string | null }[]>`
      select from_status, to_status, actor_user_id, reason from appointment_events where appointment_id = ${id} order by id`;
  const audits = (id: string) =>
    sql<{ action: string; actor_user_id: string; details: Json }[]>`
      select action, actor_user_id, details from audit_events where entity = 'appointment' and entity_id = ${id}
        and action like 'appointment.attendance_%' order by id`;

  async function therapistIn(orgId: string, name: string, role: "member" | "admin" = "member") {
    const user = await world.user(name, "provider");
    await sql`insert into org_members (org_id, user_id, org_role) values (${orgId}, ${user.id}, ${role})`;
    const [profile] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, verification_status, verified_at, listed, claimed, is_synthetic)
      values (${user.id}, ${`t044-${name}-${world.tag}`}, ${`Dr ${name} (synthetic)`}, 'occupational_therapist', 'verified', now(), true, true, false)
      returning id`;
    extraProfiles.push(profile.id);
    const [svc] = await sql<{ id: string }[]>`
      insert into services (provider_profile_id, org_id, name, mode, duration_min, fee_inr, payment_mode)
      values (${profile.id}, ${orgId}, ${`OT ${name} (synthetic)`}, 'video', 30, 600, 'at_clinic') returning id`;
    return { user, profileId: profile.id, serviceId: svc.id };
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t044");
    owner = await world.provider("pa");
    outsider = await world.provider("pb");
    paidService = await world.service(owner, { duration: 30, payment: "at_clinic", fee: 800, name: "Speech therapy (synthetic)" });
    freeService = await world.service(owner, { duration: 30, payment: "free", name: "Free check-in (synthetic)" });
    onlineService = await world.service(owner, { duration: 30, payment: "online", fee: 900, name: "Online prepaid (synthetic)" });
    frontDesk = await world.user("desk", "provider");
    await sql`insert into org_members (org_id, user_id, org_role) values (${owner.orgId}, ${frontDesk.id}, 'admin')`;
    therapist = await therapistIn(owner.orgId, "mt");
    family = await world.guardian("ga");
    caseId = (await world.kase(owner.orgId, { childId: family.childId })).caseId;
    attendance = await import("@/lib/booking/attendance");
    routes = {
      mark: await import("@/app/api/appointments/[id]/attendance/route"),
      markAll: await import("@/app/api/attendance/mark-all/route"),
      policy: await import("@/app/api/orgs/[id]/attendance-policy/route"),
      caseMonth: await import("@/app/api/cases/[id]/attendance/route"),
      complete: await import("@/app/api/appointments/[id]/complete/route"),
    };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql) {
      const profiles = [owner?.profileId, ...extraProfiles].filter(Boolean) as string[];
      if (profiles.length) {
        const ids = (await sql<{ id: string }[]>`select id from appointments where provider_profile_id in ${sql(profiles)}`).map((r) => r.id);
        if (ids.length) {
          await sql`delete from outbox_events where aggregate_type = 'appointment' and aggregate_id in ${sql(ids)}`;
          await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'appointment' and entity_id in ${tx(ids)}`);
          await sql`delete from payments where appointment_id in ${sql(ids)}`;
        }
        const series = (await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id in ${sql(profiles)}`).map((r) => r.id);
        if (series.length) await sql`delete from outbox_events where aggregate_type = 'appointment_series' and aggregate_id in ${sql(series)}`;
        await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity in ('organization', 'appointment_series') and entity_id in ${tx([owner.orgId, ...series])}`);
        if (extraProfiles.length) {
          await sql`delete from appointments where provider_profile_id in ${sql(extraProfiles)}`;
          await sql`delete from provider_profiles where id in ${sql(extraProfiles)}`;
        }
      }
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  describe("marking (FR-1, FR-2, FR-8)", () => {
    it("present -> completed and billable (fee > 0), 030 history + audit with actor, from, to", async () => {
      as(frontDesk);
      const id = await appt(paidService, past());
      const res = await mark(id, { attendance: "present" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json).toMatchObject({ result: "marked", attendance: "present", status: "completed", billable: true });
      expect(await row(id)).toMatchObject({ status: "completed", attendance: "present", billable: true, marked_by: frontDesk.id });
      expect((await history(id)).map((h) => [h.from_status, h.to_status, h.actor_user_id])).toEqual([["confirmed", "completed", frontDesk.id]]);
      const [a] = await audits(id);
      expect(a).toMatchObject({ action: "appointment.attendance_marked", actor_user_id: frontDesk.id });
      expect(a.details).toMatchObject({ from: null, to: "present", billable: true });
    });

    it("present on a free session is not billable", async () => {
      as(owner.user);
      const id = await appt(freeService, past());
      expect((await mark(id, { attendance: "present" })).json).toMatchObject({ status: "completed", billable: false });
    });

    it("absent -> no_show; billable only when the org bills absences", async () => {
      as(owner.user);
      const first = await appt(paidService, past());
      expect((await mark(first, { attendance: "absent" })).json).toMatchObject({ result: "marked", status: "no_show", billable: false });
      expect((await setPolicy({ ...DEFAULT, bill_absent: true })).status).toBe(200);
      const second = await appt(paidService, past());
      expect((await mark(second, { attendance: "absent" })).json).toMatchObject({ status: "no_show", billable: true });
      expect((await row(first)).billable).toBe(false); // earlier markings keep their value
      expect((await setPolicy(DEFAULT)).status).toBe(200);
    });

    it("late family cancellation: inside the window billable only with bill_late_cancel; outside the window never", async () => {
      as(owner.user);
      const inside = await appt(paidService, future()); // starts in a few hours (< 24 h)
      const res = await mark(inside, { attendance: "late_cancel_family" });
      expect(res.json).toMatchObject({ result: "marked", status: "cancelled", billable: false });
      // 030's cancel path: reason + provider side + history + one cancellation message.
      expect(await row(inside)).toMatchObject({ cancel_reason: "late_cancel_family", cancelled_by: "provider", attendance: "late_cancel_family" });
      expect((await history(inside)).at(-1)).toMatchObject({ from_status: "confirmed", to_status: "cancelled", reason: "late_cancel_family" });
      expect(await sql`select 1 from outbox_events where dedup_key = ${`appt:${inside}:cancelled`}`).toHaveLength(1);

      expect((await setPolicy({ ...DEFAULT, bill_late_cancel: true, late_cancel_hours: 24 })).status).toBe(200);
      const billed = await appt(paidService, future());
      expect((await mark(billed, { attendance: "late_cancel_family" })).json).toMatchObject({ billable: true });
      const early = await appt(paidService, 3 * DAY); // 72 h ahead: not late
      expect((await mark(early, { attendance: "late_cancel_family" })).json).toMatchObject({ status: "cancelled", billable: false });
      // Recorded after the start (030's cancel refuses `too_late`; the register records it, no message).
      const after = await appt(paidService, past());
      expect((await mark(after, { attendance: "late_cancel_family" })).json).toMatchObject({ status: "cancelled", billable: true });
      expect(await sql`select 1 from outbox_events where dedup_key = ${`appt:${after}:cancelled`}`).toHaveLength(0);
      expect((await history(after)).at(-1)).toMatchObject({ from_status: "confirmed", to_status: "cancelled", reason: "late_cancel_family" });
      expect((await setPolicy(DEFAULT)).status).toBe(200);
    });

    it("centre cancellation is never billable, even with every billing rule on", async () => {
      as(owner.user);
      expect((await setPolicy({ bill_absent: true, bill_late_cancel: true, late_cancel_hours: 168 })).status).toBe(200);
      const before = await appt(paidService, future());
      expect((await mark(before, { attendance: "cancelled_centre" })).json).toMatchObject({ status: "cancelled", billable: false });
      expect(await row(before)).toMatchObject({ cancel_reason: "centre_cancelled", attendance: "cancelled_centre" });
      const after = await appt(paidService, past());
      expect((await mark(after, { attendance: "cancelled_centre" })).json).toMatchObject({ status: "cancelled", billable: false });
      expect((await setPolicy(DEFAULT)).status).toBe(200);
    });

    it("FR-4: present / absent before the start -> 409 not_started; cancel types allowed", async () => {
      as(owner.user);
      const id = await appt(paidService, future());
      for (const value of ["present", "absent"]) {
        const res = await mark(id, { attendance: value });
        expect(res.status).toBe(409);
        expect(res.json.code).toBe("not_started");
      }
      expect((await row(id)).status).toBe("confirmed");
      expect((await mark(id, { attendance: "cancelled_centre" })).status).toBe(200);
    });

    it("D-3: a member correcting after 7 days -> 403; the owner may, with a reason (422 without), and it is audited", async () => {
      const old = await appt(therapist.serviceId, -8 * DAY);
      as(therapist.user);
      const first = await mark(old, { attendance: "present" });
      expect(first.status).toBe(403);
      expect(first.json.code).toBe("correction_window");
      as(owner.user);
      expect((await mark(old, { attendance: "present" })).status).toBe(200); // owner/admin: no window
      as(therapist.user);
      expect((await mark(old, { attendance: "absent", reason: "Child was not there" })).status).toBe(403);
      as(owner.user);
      const noReason = await mark(old, { attendance: "absent" });
      expect(noReason.status).toBe(422);
      expect(noReason.json.code).toBe("reason_required");
      const fixed = await mark(old, { attendance: "absent", reason: "Marked the wrong child" });
      expect(fixed.json).toMatchObject({ result: "corrected", attendance: "absent", status: "no_show", billable: false });
      expect((await history(old)).map((h) => [h.from_status, h.to_status])).toEqual([
        ["confirmed", "completed"],
        ["completed", "no_show"],
      ]);
      expect((await history(old)).at(-1)?.reason).toBe("attendance_corrected:present->absent: Marked the wrong child");
      const trail = await audits(old);
      expect(trail.map((a) => a.action)).toEqual(["appointment.attendance_marked", "appointment.attendance_corrected"]);
      expect(trail[1]).toMatchObject({ actor_user_id: owner.user.id, details: { from: "present", to: "absent", reason: "Marked the wrong child" } });

      // Inside the 7 days a member corrects their own session (with a reason).
      const recent = await appt(therapist.serviceId, past());
      as(therapist.user);
      expect((await mark(recent, { attendance: "present" })).status).toBe(200);
      expect((await mark(recent, { attendance: "late_cancel_family", reason: "Family cancelled at 9 am" })).json).toMatchObject({
        result: "corrected",
        status: "cancelled",
      });
      expect(await row(recent)).toMatchObject({ cancel_reason: "late_cancel_family", attendance: "late_cancel_family" });
    });

    it("NFR-2: a double submit creates one event (and one audit row)", async () => {
      as(frontDesk);
      const id = await appt(paidService, past());
      const [a, b] = await Promise.all([mark(id, { attendance: "present" }), mark(id, { attendance: "present" })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.json.result, b.json.result].sort()).toEqual(["marked", "unchanged"]);
      expect((await history(id)).filter((h) => h.to_status === "completed")).toHaveLength(1);
      expect(await audits(id)).toHaveLength(1);
      expect((await mark(id, { attendance: "present" })).json.result).toBe("unchanged");
      expect(await audits(id)).toHaveLength(1);
    });

    it("authz: other tenants 404, the member on someone else's session 404, guardians 403, anonymous 401, bad input 400", async () => {
      const id = await appt(paidService, past());
      as(outsider.user);
      expect((await mark(id, { attendance: "present" })).status).toBe(404);
      as(therapist.user); // member, not owner/admin, not this session's therapist
      expect((await mark(id, { attendance: "present" })).status).toBe(404);
      as(family.user);
      expect((await mark(id, { attendance: "present" })).status).toBe(403);
      as(null);
      expect((await mark(id, { attendance: "present" })).status).toBe(401);
      as(owner.user);
      expect((await mark(id, { attendance: "maybe" })).status).toBe(400);
      expect((await mark("not-a-uuid", { attendance: "present" })).status).toBe(404);
      expect((await mark(randomUUID(), { attendance: "present" })).status).toBe(404);
      expect((await row(id)).status).toBe("confirmed");
    });

    it("030's `Mark completed` keeps the attendance in step (trigger) and records who", async () => {
      as(owner.user);
      const id = await appt(paidService, past());
      const res = await call(routes.complete.POST, post(`http://localhost/api/appointments/${id}/complete`, { status: "completed" }), { id });
      expect(res.status).toBe(200);
      expect(await row(id)).toMatchObject({ status: "completed", attendance: "present", billable: true, marked_by: owner.user.id });
      const noShow = await appt(paidService, past());
      await call(routes.complete.POST, post(`http://localhost/api/appointments/${noShow}/complete`, { status: "no_show" }), { id: noShow });
      expect(await row(noShow)).toMatchObject({ status: "no_show", attendance: "absent", billable: false });
    });

    it("a weekly-series session (043) is marked like any other", async () => {
      as(owner.user);
      const { createSeries } = await import("@/lib/booking/series");
      const today = todayIn(TZ);
      const created = await createSeries({
        actorUserId: owner.user.id,
        orgId: owner.orgId,
        caseId,
        childId: family.childId,
        profileId: owner.profileId,
        serviceId: paidService,
        weekdays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d === (new Date(`${addDays(today, 1)}T12:00:00Z`).getUTCDay() + 6) % 7),
        startTime: "22:00",
        startsOn: today,
        endsOn: addDays(today, 6),
        billingMode: "per_session",
        guardian: null,
      });
      const [occ] = await sql<{ id: string }[]>`select id from appointments where series_id = ${created.series_id} order by lower(slot) limit 1`;
      expect(occ).toBeTruthy();
      // Time-travel the occurrence into the past (the session "happened").
      await sql`update appointments set slot = tstzrange(now() - interval '50 minutes', now() - interval '20 minutes', '[)') where id = ${occ.id}`;
      expect((await mark(occ.id, { attendance: "present" })).json).toMatchObject({ status: "completed", billable: true });
    });

    it("online prepayment + late family cancellation: kept when the org bills it, refunded otherwise", async () => {
      as(owner.user);
      const payFor = async (id: string) => {
        const suffix = randomUUID().replace(/-/g, "").slice(0, 14);
        await sql`insert into payments (appointment_id, gateway, razorpay_order_id, razorpay_payment_id, amount_paise, status, captured_at)
                  values (${id}, 'demo', ${`order_${suffix}`}, ${`pay_${suffix}`}, 90000, 'captured', now())`;
      };
      const refunded = await appt(onlineService, future());
      await payFor(refunded);
      await mark(refunded, { attendance: "late_cancel_family" });
      expect((await sql`select status, refund_reason from payments where appointment_id = ${refunded}`)[0]).toEqual({ status: "refund_pending", refund_reason: "guardian_cancelled" });
      expect((await setPolicy({ ...DEFAULT, bill_late_cancel: true })).status).toBe(200);
      const kept = await appt(onlineService, future());
      await payFor(kept);
      expect((await mark(kept, { attendance: "late_cancel_family" })).json).toMatchObject({ billable: true });
      expect((await sql`select status from payments where appointment_id = ${kept}`)[0].status).toBe("captured");
      // A centre cancellation always refunds (031 unchanged).
      const centre = await appt(onlineService, future());
      await payFor(centre);
      await mark(centre, { attendance: "cancelled_centre" });
      expect((await sql`select status, refund_reason from payments where appointment_id = ${centre}`)[0]).toEqual({ status: "refund_pending", refund_reason: "provider_cancelled" });
      expect((await setPolicy(DEFAULT)).status).toBe(200);
    });
  });

  describe("register, mark all, needs attention (FR-3, FR-4, NFR-1)", () => {
    it("Mark all remaining present: started unmarked sessions only; marked / future ones are skipped", async () => {
      as(frontDesk);
      const a = await appt(paidService, past());
      const b = await appt(paidService, past());
      const marked = await appt(paidService, past());
      const later = await appt(paidService, future());
      await mark(marked, { attendance: "absent" });
      const res = await call(routes.markAll.POST, post("http://localhost/api/attendance/mark-all", { appointment_ids: [a, b, marked, later] }));
      expect(res.status).toBe(200);
      expect((res.json.marked as { appointment_id: string }[]).map((m) => m.appointment_id).sort()).toEqual([a, b].sort());
      expect(res.json.skipped).toEqual(
        expect.arrayContaining([
          { appointment_id: marked, code: "already_marked" },
          { appointment_id: later, code: "not_started" },
        ]),
      );
      expect((await row(marked)).status).toBe("no_show");
      expect((await row(later)).status).toBe("confirmed");
      as(outsider.user);
      const other = await call(routes.markAll.POST, post("http://localhost/api/attendance/mark-all", { appointment_ids: [await appt(paidService, past())] }));
      expect((other.json.skipped as { code: string }[])[0].code).toBe("not_found");
    });

    it("the register shows owner/admin every session of the org and members their own; 60 sessions load in < 1 s", async () => {
      const today = todayIn(TZ);
      const team = [await therapistIn(owner.orgId, "r1"), await therapistIn(owner.orgId, "r2"), await therapistIn(owner.orgId, "r3")];
      for (const t of team) {
        const values = [];
        for (let k = 0; k < 20; k++) {
          const start = wallToUtc(today, 60 + k * 30, TZ)!;
          values.push(sql`(${t.profileId}::uuid, ${owner.orgId}::uuid, ${t.serviceId}::uuid,
            ${sql.json({ name: "OT (synthetic)", duration_min: 30, mode: "video", fee_inr: 600, payment_mode: "at_clinic", location: null })}::jsonb,
            tstzrange(${start}::timestamptz, ${new Date(start.getTime() + 30 * 60_000)}::timestamptz, '[)'), 'confirmed')`);
        }
        for (const v of values) {
          await sql`insert into appointments (provider_profile_id, org_id, service_id, service_snapshot, slot, status) values ${v}`;
        }
      }
      const started = performance.now();
      const reg = await attendance.loadRegister(frontDesk.id, { orgId: owner.orgId, date: today, timeZone: TZ });
      const ms = performance.now() - started;
      expect(reg).not.toBeNull();
      const mine = reg!.rows.filter((r) => team.some((t) => t.profileId === r.provider_profile_id));
      expect(mine).toHaveLength(60);
      expect(reg!.org.manage).toBe(true);
      expect(ms).toBeLessThan(1000);
      console.info(`044 NFR-1: register with ${reg!.rows.length} sessions loaded in ${ms.toFixed(0)} ms`);
      const groups = attendance.groupByTherapist(mine);
      expect(groups.map((g) => g.rows.length)).toEqual([20, 20, 20]);
      expect(groups.every((g) => g.rows.every((r, i) => i === 0 || g.rows[i - 1].starts_at <= r.starts_at))).toBe(true);

      const memberView = await attendance.loadRegister(team[0].user.id, { orgId: owner.orgId, date: today, timeZone: TZ });
      expect(memberView!.org.manage).toBe(false);
      expect(new Set(memberView!.rows.map((r) => r.provider_profile_id))).toEqual(new Set([team[0].profileId]));
      expect(memberView!.minDate).toBe(addDays(today, -7));
      // A member asking for an older date gets today; an unknown org falls back to their own.
      expect((await attendance.loadRegister(team[0].user.id, { orgId: randomUUID(), date: addDays(today, -30), timeZone: TZ }))!.date).toBe(today);
      expect(await attendance.loadRegister(family.user.id, { timeZone: TZ })).toBeNull();
    });

    it("FR-4 Needs attention: unmarked sessions older than 24 h; members see their own", async () => {
      const stale = await appt(paidService, -30 * HOUR);
      const fresh = await appt(paidService, past()); // a few hours ago: not yet
      const staleMember = await appt(therapist.serviceId, -2 * DAY);
      const list = await attendance.listNeedsAttention(owner.user.id, { limit: 500 });
      const ids = list.items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([stale, staleMember]));
      expect(ids).not.toContain(fresh);
      expect(list.items.find((i) => i.id === stale)).toMatchObject({ can_mark: true, org_id: owner.orgId });
      const member = await attendance.listNeedsAttention(therapist.user.id, { limit: 500 });
      expect(member.items.map((i) => i.id)).toContain(staleMember);
      expect(member.items.map((i) => i.id)).not.toContain(stale);
      expect((await attendance.listNeedsAttention(outsider.user.id, { limit: 500 })).items.map((i) => i.id)).not.toContain(stale);
      as(owner.user);
      await mark(stale, { attendance: "present" });
      expect((await attendance.listNeedsAttention(owner.user.id, { limit: 500 })).items.map((i) => i.id)).not.toContain(stale);
    });
  });

  describe("case month + CSV (FR-6) and org policy (FR-2)", () => {
    it("the case's month: counts and a CSV export for staff; other tenants 404, guardians 403", async () => {
      as(owner.user);
      const month = todayIn(TZ).slice(0, 7);
      const res = await call(routes.caseMonth.GET, new Request(`http://localhost/api/cases/${caseId}/attendance?month=${month}`), { id: caseId });
      expect(res.status).toBe(200);
      const counts = res.json.counts as { attended: number; absent: number; cancelled: number; unmarked: number };
      const sessions = res.json.sessions as { attendance: string | null; date: string }[];
      expect(sessions.length).toBeGreaterThan(0);
      expect(counts.attended).toBe(sessions.filter((s) => s.attendance === "present").length);
      expect(counts.cancelled).toBe(sessions.filter((s) => s.attendance === "late_cancel_family" || s.attendance === "cancelled_centre").length);
      expect(sessions.every((s) => s.date.startsWith(month))).toBe(true);

      const csv = await routes.caseMonth.GET(new Request(`http://localhost/api/cases/${caseId}/attendance?month=${month}&format=csv`), ctx({ id: caseId }) as never);
      expect(csv.headers.get("content-type")).toContain("text/csv");
      const bytes = new Uint8Array(await csv.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
      const text = new TextDecoder().decode(bytes);
      expect(text.startsWith("date,time,therapist,service,attendance,status,billable,marked_at")).toBe(true);
      expect(text.split("\r\n").filter(Boolean)).toHaveLength(sessions.length + 1);
      expect(text).toContain(",present,completed,yes,");

      expect((await call(routes.caseMonth.GET, new Request(`http://localhost/api/cases/${caseId}/attendance?month=2026-13`), { id: caseId })).status).toBe(400);
      as(outsider.user);
      expect((await call(routes.caseMonth.GET, new Request(`http://localhost/api/cases/${caseId}/attendance`), { id: caseId })).status).toBe(404);
      as(family.user);
      expect((await call(routes.caseMonth.GET, new Request(`http://localhost/api/cases/${caseId}/attendance`), { id: caseId })).status).toBe(403);
    });

    it("policy: members read (403 to change), other orgs 404, invalid 400, owner/admin change it (audited)", async () => {
      as(therapist.user);
      expect((await call(routes.policy.GET, new Request("http://localhost/x"), { id: owner.orgId })).json.policy).toEqual(DEFAULT);
      expect((await setPolicy({ ...DEFAULT, bill_absent: true })).status).toBe(403);
      as(outsider.user);
      expect((await call(routes.policy.GET, new Request("http://localhost/x"), { id: owner.orgId })).status).toBe(404);
      as(frontDesk);
      expect((await setPolicy({ ...DEFAULT, late_cancel_hours: 500 })).status).toBe(400);
      expect((await setPolicy({ bill_absent: "yes" })).status).toBe(400);
      expect((await setPolicy({ ...DEFAULT, late_cancel_hours: 12 })).json.policy).toEqual({ ...DEFAULT, late_cancel_hours: 12 });
      const [audit] = await sql<{ actor_user_id: string; details: Json }[]>`
        select actor_user_id, details from audit_events where action = 'org.attendance_policy_changed' and entity_id = ${owner.orgId}
        order by id desc limit 1`;
      expect(audit).toMatchObject({ actor_user_id: frontDesk.id, details: { to: { late_cancel_hours: 12 } } });
      // The database refuses malformed policies whatever the writer.
      await expect(sql`update organizations set attendance_policy = '{"bill_absent": true}' where id = ${owner.orgId}`).rejects.toThrow();
      expect((await setPolicy(DEFAULT)).status).toBe(200);
    });
  });
});
