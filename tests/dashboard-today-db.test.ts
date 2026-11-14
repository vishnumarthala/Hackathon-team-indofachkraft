// Ticket 052 FR-4 / FR-5 against the real database: the provider dashboard's Today panel. E-4 therapist morning (4
// sessions today, 1 note missing from yesterday, 2 ISAA items unconfirmed, one-tap Present through 044's route), the
// To-do counts per role (a member sees only their own sessions; owner/admin the whole organisation and balances due),
// another organisation's data -> none, the stat cards, the case default tab before and after the assessment, and the
// 50-children timing (NFR-1). Synthetic users only; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, type TestProvider } from "./helpers/booking";
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

/**
 * A fixed-offset zone where it is now between 10:00 and 14:00, so "today" always has room for sessions that already
 * started (one-tap Present needs a started session) and later ones, whenever the suite runs.
 */
function middayZone(now = new Date()): string {
  const target = 12 - now.getUTCHours();
  const offset = ((target + 36) % 24) - 12; // -12 .. +11
  return offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
}

describe.skipIf(!enabled)("052 provider dashboard Today (database)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let owner: TestProvider; // centre owner, also a therapist
  let outsider: TestProvider; // another organisation
  let desk: TestUser; // centre admin without a profile
  let therapist: { user: TestUser; profileId: string };
  let family: { user: TestUser; childId: string };
  let caseId: string;
  let recordingId: string;
  let TZ: string;
  let today: typeof import("@/lib/dashboard/today");
  const extraProfiles: string[] = [];
  const todayIds: string[] = [];
  let yesterdayPresent: string;

  async function appt(profileId: string, orgId: string, minutesFromNow: number, opts: { status?: string; attendance?: string | null; caseId?: string | null; childId?: string | null } = {}) {
    const [row] = await sql<{ id: string }[]>`
      insert into appointments (provider_profile_id, org_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status, attendance,
                                attendance_marked_at, billable)
      values (${profileId}, ${orgId},
              ${sql.json({ name: "Speech therapy (synthetic)", duration_min: 30, mode: "in_clinic", fee_inr: 0, payment_mode: "free", time_zone: "Asia/Kolkata", location: null })},
              ${opts.childId === undefined ? family.childId : opts.childId}, ${opts.childId === null ? null : family.user.id},
              ${opts.caseId === undefined ? caseId : opts.caseId},
              tstzrange(now() + make_interval(mins => ${minutesFromNow}), now() + make_interval(mins => ${minutesFromNow + 30}), '[)'),
              ${opts.status ?? "confirmed"}, ${opts.attendance ?? null},
              ${opts.attendance ? sql`now()` : null}, ${opts.attendance ? false : null})
      returning id`;
    return row.id;
  }
  const load = (user: TestUser) => today.loadDashboardToday(user.id, { timeZone: TZ });
  const count = (d: Awaited<ReturnType<typeof load>>, key: string) => d.todos.find((t) => t.key === key)?.count;

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    TZ = middayZone();
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t052d");
    owner = await world.provider("pa", { allWeek: false });
    outsider = await world.provider("pb", { allWeek: false });
    desk = await world.user("desk", "provider");
    await sql`insert into org_members (org_id, user_id, org_role) values (${owner.orgId}, ${desk.id}, 'admin')`;
    const tUser = await world.user("mt", "provider");
    await sql`insert into org_members (org_id, user_id, org_role) values (${owner.orgId}, ${tUser.id}, 'member')`;
    const [profile] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, verification_status, verified_at, listed, claimed, is_synthetic)
      values (${tUser.id}, ${`t052-mt-${world.tag}`}, 'Dr Mt (synthetic)', 'occupational_therapist', 'verified', now(), true, true, false)
      returning id`;
    extraProfiles.push(profile.id);
    therapist = { user: tUser, profileId: profile.id };
    family = await world.guardian("ga");
    const k = await world.kase(owner.orgId, { childId: family.childId });
    caseId = k.caseId;
    recordingId = k.recordingId;
    // The therapist is on the child's care team (022), so the case's ISAA items are theirs to confirm.
    await sql`insert into case_assignments (case_id, user_id, care_role) values (${caseId}, ${tUser.id}, 'member')`;

    // E-4: four sessions today (three started), one present yesterday without a note, one unmarked 30 h ago.
    for (const minutes of [-180, -120, -60, 60]) todayIds.push(await appt(therapist.profileId, owner.orgId, minutes));
    yesterdayPresent = await appt(therapist.profileId, owner.orgId, -26 * 60, { status: "completed", attendance: "present" });
    await appt(therapist.profileId, owner.orgId, -30 * 60);
    // Two ISAA items the AI suggested and nobody confirmed.
    for (const item of ["1", "2"]) {
      await sql`insert into facts (case_id, recording_id, instrument, item_id, value, ai_value, source, status)
                values (${caseId}, ${recordingId}, 'ISAA', ${item}, '3'::jsonb, '3'::jsonb, 'session', 'suggested')`;
    }
    // The owner's own session today (not the therapist's), and another organisation's sessions.
    await appt(owner.profileId, owner.orgId, -90);
    await appt(outsider.profileId, outsider.orgId, -90, { caseId: null, childId: null });
    // A family balance (045) in the centre.
    await sql`insert into family_ledger (org_id, child_id, kind, amount_paise, note) values (${owner.orgId}, ${family.childId}, 'charge', 80000, 'Session (synthetic)')`;
    today = await import("@/lib/dashboard/today");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql) {
      const profiles = [owner?.profileId, ...extraProfiles].filter(Boolean) as string[];
      const ids = profiles.length ? (await sql<{ id: string }[]>`select id from appointments where provider_profile_id in ${sql(profiles)}`).map((r) => r.id) : [];
      if (ids.length) {
        await sql`delete from outbox_events where (aggregate_type = 'appointment' and aggregate_id in ${sql(ids)}) or payload ->> 'appointment_id' in ${sql(ids)}`;
        await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'appointment' and entity_id in ${tx(ids)}`);
      }
      if (extraProfiles.length) {
        await sql`delete from appointments where provider_profile_id in ${sql(extraProfiles)}`;
        await sql`delete from provider_profiles where id in ${sql(extraProfiles)}`;
      }
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("E-4: the therapist (member) sees their 4 sessions today, 1 note to write, 1 unmarked session and 2 ISAA items", async () => {
    const d = await load(therapist.user);
    expect(d.manage).toBe(false);
    expect(d.sessions.map((s) => s.id).sort()).toEqual([...todayIds].sort());
    expect(d.sessions.every((s) => s.case_id === caseId && s.child_name === `ga child (synthetic)`)).toBe(true);
    expect(count(d, "notes")).toBe(1);
    expect(d.todos.find((t) => t.key === "notes")?.href).toBe(`/cases/${caseId}/sessions/new?appointment=${yesterdayPresent}`);
    expect(count(d, "attendance")).toBe(1);
    expect(count(d, "isaa")).toBe(2);
    expect(d.todos.find((t) => t.key === "isaa")?.href).toBe(`/cases/${caseId}/sessions/${recordingId}`);
    expect(count(d, "briefs")).toBe(0);
    // Balances due are for owners/admins only.
    expect(d.todos.map((t) => t.key)).not.toContain("balances");
  });

  it("E-4: one-tap Present from the dashboard marks the session (044 route) and adds it to the notes to write", async () => {
    const route = await import("@/app/api/appointments/[id]/attendance/route");
    session.user = { id: therapist.user.id, email: therapist.user.email };
    const started = todayIds[2];
    const res = await route.POST(post(`http://localhost/api/appointments/${started}/attendance`, { attendance: "present" }), ctx({ id: started }) as never);
    expect(res.status).toBe(200);
    // Not started yet -> refused, as on the register.
    const later = todayIds[3];
    const early = await route.POST(post(`http://localhost/api/appointments/${later}/attendance`, { attendance: "present" }), ctx({ id: later }) as never);
    expect(early.status).toBe(409);
    session.user = null;
    const d = await load(therapist.user);
    expect(d.sessions.find((s) => s.id === started)).toMatchObject({ attendance: "present", status: "completed", has_note: false });
    expect(count(d, "notes")).toBe(2);
    expect(d.todos.find((t) => t.key === "notes")?.href).toBe(`/cases/${caseId}/sessions/new?appointment=${started}`);
    // A scribe recording for that appointment clears it.
    await sql`insert into recordings (case_id, kind, session_number, status, mime_type, segments, appointment_id, template)
              values (${caseId}, 'session', 7, 'created', 'audio/wav', '[]'::jsonb, ${started}, 'therapy_session_note')`;
    const after = await load(therapist.user);
    expect(after.sessions.find((s) => s.id === started)?.has_note).toBe(true);
    expect(count(after, "notes")).toBe(1);
  });

  it("owner and admin see the whole organisation's sessions today and the balances due", async () => {
    for (const user of [owner.user, desk]) {
      const d = await load(user);
      expect(d.manage).toBe(true);
      expect(d.sessions).toHaveLength(5);
      expect(count(d, "balances")).toBe(1);
      expect(d.todos.find((t) => t.key === "balances")?.href).toBe("/dashboard/fees");
      expect(count(d, "isaa")).toBe(2);
    }
  });

  it("another organisation's provider sees none of it; a user in no organisation gets an empty panel", async () => {
    const d = await load(outsider.user);
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions.every((s) => s.org_id === outsider.orgId)).toBe(true);
    expect(JSON.stringify(d)).not.toContain(caseId);
    expect(JSON.stringify(d)).not.toContain(family.childId);
    expect(count(d, "isaa")).toBe(0);
    expect(count(d, "notes")).toBe(0);
    expect(count(d, "balances")).toBe(0);
    const loner = await world.user("loner", "provider");
    expect(await load(loner)).toMatchObject({ memberships: [], sessions: [], todos: [], stats: { active_children: 0, sessions_this_week: 0, attendance_rate: null, home_logs_this_week: 0 } });
  });

  it("stat cards: active children, sessions this week, attendance rate (30 days), home-practice logs this week", async () => {
    const d = await load(therapist.user);
    expect(d.stats.active_children).toBe(1);
    expect(d.stats.sessions_this_week).toBeGreaterThanOrEqual(4);
    // present today + present yesterday; the 30 h-old session is unmarked (not counted).
    expect(d.stats.attendance_rate).toBe(100);
    expect(d.stats.home_logs_this_week).toBe(0);
    await sql`update appointments set status = 'no_show', attendance = 'absent', attendance_marked_at = now(), billable = false where id = ${todayIds[0]}`;
    expect((await load(therapist.user)).stats.attendance_rate).toBe(67);
  });

  it("FR-5: the case opens on Sessions after the assessment, on Overview while in assessment", async () => {
    const tabs = await import("@/lib/cases/default-tab");
    const fresh = randomUUID();
    await sql`insert into cases (id, org_id, child_alias, parent_alias, language, status, child_id)
              values (${fresh}, ${owner.orgId}, 'Fresh (synthetic)', 'Parent (synthetic)', 'en', 'in_assessment', ${family.childId})`;
    expect(await tabs.getCaseDefaultTab(fresh)).toBe("overview");
    // world.kase's case has a final assessment report -> past the assessment.
    expect(await tabs.getCaseDefaultTab(caseId)).toBe("sessions");
    const [rec] = await sql<{ id: string }[]>`insert into recordings (case_id, kind, session_number, status, mime_type, segments) values (${fresh}, 'session', 1, 'transcribed', 'audio/wav', '[]'::jsonb) returning id`;
    await sql`insert into reports (case_id, recording_id, kind, content, content_md, status) values (${fresh}, ${rec.id}, 'assessment', '{}'::jsonb, '# Report (synthetic)', 'final')`;
    expect(await tabs.getCaseDefaultTab(fresh)).toBe("sessions");
    const facts = await tabs.loadCaseTabFacts([fresh, caseId, "not-a-uuid"]);
    expect([...facts.keys()].sort()).toEqual([caseId, fresh].sort());
    await sql`delete from cases where id = ${fresh}`;
  });

  it("NFR-1: an owner with 50 children loads the Today panel in under 800 ms", async () => {
    const big = await world.provider("pbig", { allWeek: false });
    const [{ ids }] = await sql<{ ids: string[] }[]>`
      with made as (
        insert into children (display_name, date_of_birth, source, created_by)
        select 'Load child ' || g || ' (synthetic)', '2021-01-01', 'provider', ${big.user.id} from generate_series(1, 50) g
        returning id
      )
      select array_agg(id) as ids from made`;
    for (const id of ids) world.trackChild(id);
    await sql`
      insert into cases (org_id, child_alias, parent_alias, language, child_id)
      select ${big.orgId}, 'Load ' || ord, 'Parent (synthetic)', 'en', id from unnest(${ids}::uuid[]) with ordinality as t(id, ord)`;
    await sql`
      insert into appointments (provider_profile_id, org_id, service_snapshot, child_id, case_id, slot, status)
      select ${big.profileId}, ${big.orgId}, ${sql.json({ name: "Load (synthetic)", duration_min: 30, mode: "in_clinic", fee_inr: 0, payment_mode: "free" })},
             c.child_id, c.id,
             tstzrange(now() - make_interval(hours => 20) + make_interval(mins => 31 * (row_number() over ())::int),
                       now() - make_interval(hours => 20) + make_interval(mins => 31 * (row_number() over ())::int + 30), '[)'),
             'confirmed'
      from cases c where c.org_id = ${big.orgId}`;
    await today.loadDashboardToday(big.user.id, { timeZone: TZ });
    const started = performance.now();
    const d = await today.loadDashboardToday(big.user.id, { timeZone: TZ });
    const ms = performance.now() - started;
    console.info(`052 NFR-1 dashboard today: ${d.sessions.length} sessions today, ${d.stats.active_children} active children in ${ms.toFixed(0)} ms`);
    expect(d.stats.active_children).toBe(50);
    expect(ms).toBeLessThan(800);
  });
});
