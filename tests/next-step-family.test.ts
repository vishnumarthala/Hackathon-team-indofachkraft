// Ticket 052 against the real database: the family home's facts and Next step (FR-1/FR-2), the appointment timeline
// (FR-6) and the Messages badge (FR-3). E-1 new parent, E-2 invited parent before the first visit (permission ->
// intake call), pay / practice / message rules from real 045 / 026 / 027 rows, other guardians' children never
// appearing (NFR-2) and the 50-children timing (NFR-1). Synthetic users only; skipped without DATABASE_URL.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, type TestProvider } from "./helpers/booking";
import type { TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

const TZ = "Asia/Kolkata";

describe.skipIf(!enabled)("052 family home next step (database)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let provider: TestProvider;
  let ns: typeof import("@/lib/family/next-step");
  let journey: typeof import("@/lib/family/journey");
  const attempts: string[] = [];

  const linkIdOf = async (childId: string, user: TestUser) =>
    (await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childId} and user_id = ${user.id}`)[0].id;

  /** A confirmed appointment `hours` from now for the guardian's child (raw insert, as the 044 suites). */
  async function appt(family: { user: TestUser; childId: string }, caseId: string | null, hours: number, opts: { intake?: boolean; status?: string } = {}) {
    const [row] = await sql<{ id: string }[]>`
      insert into appointments (provider_profile_id, org_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status, hold_expires_at)
      values (${provider.profileId}, ${provider.orgId},
              ${sql.json({
                name: "Speech therapy (synthetic)",
                duration_min: 45,
                mode: "in_clinic",
                fee_inr: opts.status === "pending_payment" ? 700 : 0,
                payment_mode: opts.status === "pending_payment" ? "online" : "free",
                provider_name: "Dr Pa (synthetic)",
                time_zone: TZ,
                intake_kind: opts.intake ? "child_dev" : "none",
                location: { name: "Pa clinic (synthetic)", address: "Road 1 (synthetic), Banjara Hills", lat: 17.41, lng: 78.44, time_zone: TZ },
              })},
              ${family.childId}, ${family.user.id}, ${caseId},
              tstzrange(now() + make_interval(mins => ${Math.round(hours * 60)}), now() + make_interval(mins => ${Math.round(hours * 60) + 45}), '[)'),
              ${opts.status ?? "confirmed"}, ${opts.status === "pending_payment" ? sql`now() + interval '15 minutes'` : null})
      returning id`;
    return row.id;
  }

  const factsOf = (user: TestUser) => ns.loadFamilyFacts(user.id, { timeZone: TZ });
  const stepOf = async (user: TestUser) => ns.pickNextStep(await factsOf(user));

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t052f");
    provider = await world.provider("pa");
    ns = await import("@/lib/family/next-step");
    journey = await import("@/lib/family/journey");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql && attempts.length) {
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'intake_attempt' and entity_id in ${tx(attempts)}`);
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("E-1: a guardian with no child gets `Enter your clinic code` and `Find a therapist`", async () => {
    const fresh = await world.user("new", "guardian");
    const facts = await factsOf(fresh);
    expect(facts).toMatchObject({ children: [], visits: [], payments: [], messages: { unread: 0, latest: null }, updates: [] });
    expect(ns.pickNextStep(facts)).toEqual({ rule: "add_child" });
    expect(await ns.familyUnreadCount(fresh.id)).toBe(0);
  });

  it("E-2: invited parent before the first visit: Give permission, then Start the intake call; the timeline follows", async () => {
    const family = await world.guardian("gb");
    await sql`update user_profiles set phone_verified_at = now() where id = ${family.user.id}`;
    const { caseId } = await world.kase(provider.orgId, { childId: family.childId });
    const id = await appt(family, caseId, 50, { intake: true });

    const before = await stepOf(family.user);
    expect(before).toMatchObject({ rule: "permission", child_id: family.childId, href: `/family/children/${family.childId}#permissions` });
    const j1 = await journey.loadAppointmentJourney(family.user.id, id, TZ);
    expect(j1).not.toBeNull();
    expect(journey.journeySteps(j1!.input).map((s) => [s.key, s.status])).toEqual([
      ["permissions", "due"],
      ["intake", "waiting"],
      ["visit", "upcoming"],
      ["home", "upcoming"],
    ]);

    // The guardian allows the AI intake call (020's record_consent); 035's consent consumer then issues the link.
    await world.grant(family.childId, family.user, await linkIdOf(family.childId, family.user), ["ai_intake_call"]);
    const granted = await stepOf(family.user);
    expect(granted.rule).toBe("intake");
    const { issueIntakeLinksForChild } = await import("@/lib/booking/case-link");
    await issueIntakeLinksForChild(sql, family.childId);
    const issued = await sql<{ id: string }[]>`select id from intake_attempts where appointment_id = ${id}`;
    attempts.push(...issued.map((r) => r.id));
    expect(issued).toHaveLength(1);
    const after = await stepOf(family.user);
    expect(after).toMatchObject({ rule: "intake", ready: true, child_id: family.childId });
    expect((after as { href: string }).href).toMatch(/^\/intake\/a\/[A-Za-z0-9_-]{43}$/);

    const j2 = await journey.loadAppointmentJourney(family.user.id, id, TZ);
    const steps = journey.journeySteps(j2!.input);
    expect(steps.map((s) => [s.key, s.status])).toEqual([
      ["permissions", "done"],
      ["intake", "due"],
      ["visit", "upcoming"],
      ["home", "upcoming"],
    ]);
    expect(steps[1].action?.href).toBe((after as { href: string }).href);

    // Completed intake -> nothing left before the visit.
    await sql`update intake_attempts set status = 'completed', completed_at = now(), conversation_id = 'conv_t052_synthetic' where appointment_id = ${id}`;
    expect(await stepOf(family.user)).toMatchObject({ rule: "all_set", next_visit: { id } });
  });

  it("NFR-2: other guardians' children, appointments and timelines never appear", async () => {
    const a = await world.guardian("ga");
    const b = await world.guardian("gx");
    const { caseId } = await world.kase(provider.orgId, { childId: b.childId });
    const theirs = await appt(b, caseId, 60, { intake: true });
    await sql`insert into family_ledger (org_id, child_id, kind, amount_paise, note) values (${provider.orgId}, ${b.childId}, 'charge', 90000, 'Session (synthetic)')`;
    const facts = await factsOf(a.user);
    expect(facts.children.map((c) => c.id)).toEqual([a.childId]);
    expect(facts.visits).toEqual([]);
    expect(facts.payments).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain(b.childId);
    expect(await journey.loadAppointmentJourney(a.user.id, theirs, TZ)).toBeNull();
    expect(await journey.loadAppointmentJourney(b.user.id, "00000000-0000-4000-8000-000000000000", TZ)).toBeNull();
    expect(await journey.loadAppointmentJourney(b.user.id, "not-a-uuid", TZ)).toBeNull();
    // A revoked link hides the child (and its appointment) from that guardian too.
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${b.childId} and user_id = ${b.user.id}`;
    expect((await factsOf(b.user)).children).toEqual([]);
    expect(await journey.loadAppointmentJourney(b.user.id, theirs, TZ)).toBeNull();
  });

  it("FR-1 rule 4: a balance due (045 ledger) and an unpaid package offer -> Pay ₹X", async () => {
    const c = await world.guardian("gc");
    await sql`insert into family_ledger (org_id, child_id, kind, amount_paise, note) values (${provider.orgId}, ${c.childId}, 'charge', 80000, 'Session (synthetic)')`;
    const step = await stepOf(c.user);
    expect(step).toMatchObject({ rule: "pay", payment: { kind: "balance", amount_paise: 80000, href: `/family/children/${c.childId}/payments` } });
    // Paid in full -> no pay step.
    await sql`insert into family_ledger (org_id, child_id, kind, amount_paise, note) values (${provider.orgId}, ${c.childId}, 'adjustment', -80000, 'Settled (synthetic)')`;
    expect((await stepOf(c.user)).rule).toBe("all_set");
    await sql`
      insert into child_packages (org_id, child_id, snapshot, service_ids, price_paise, sessions_total, offer_expires_at)
      values (${provider.orgId}, ${c.childId}, ${sql.json({ name: "10 sessions (synthetic)", session_count: 10 })}, array[gen_random_uuid()], 600000, 10, now() + interval '2 days')`;
    expect(await stepOf(c.user)).toMatchObject({ rule: "pay", payment: { kind: "package", amount_paise: 600000 } });
    // A booking waiting for payment outranks both (the slot is held for 15 minutes).
    const held = await appt(c, null, 70, { status: "pending_payment" });
    expect(await stepOf(c.user)).toMatchObject({ rule: "pay", payment: { kind: "appointment", amount_paise: 70000, href: `/book/${provider.profileId}/pay/${held}` } });
  });

  it("FR-1 rules 5-7 and FR-2: visit tomorrow, practice with a streak, unread message with the therapist's name", async () => {
    const d = await world.guardian("gd");
    const { caseId } = await world.kase(provider.orgId, { childId: d.childId });
    const hp = await import("@/lib/home-program");
    const program = await hp.createProgram({ caseId, actorUserId: provider.user.id, body: { title: "Home practice (synthetic)" } });
    if (!program.ok) throw new Error(program.error);
    const act = await hp.addActivity({
      programId: program.program.id,
      actorUserId: provider.user.id,
      body: { title: "Snack requests (synthetic)", instructions_md: "Wait 5 seconds.", frequency_per_week: 5, duration_min: 10, materials: null, goal_id: null, document_id: null },
    });
    if (!act.ok) throw new Error(act.error);
    const pub = await hp.publishProgram({ programId: program.program.id, actorUserId: provider.user.id, version: act.program_version });
    if (!pub.ok) throw new Error(pub.error);

    // Practice is due (nothing logged today, 0 of 5 this week).
    expect(await stepOf(d.user)).toMatchObject({ rule: "practice", child_id: d.childId, href: `/family/children/${d.childId}/home-program` });
    // Yesterday and today logged -> 2-day streak, no practice step.
    const { todayIn, addDays } = await import("@/lib/booking/time");
    const today = todayIn(TZ);
    for (const day of [addDays(today, -1), today]) {
      await hp.saveLog({ activityId: act.activity.id, userId: d.user.id, body: { done_on: day, difficulty: "okay", duration_min: 10, note: null } });
    }
    const facts = await factsOf(d.user);
    expect(facts.children[0].home).toMatchObject({ activities: 1, logged_today: true, streak: 2 });
    expect(facts.updates.map((u) => u.kind)).toContain("home_program");
    expect(facts.children[0].care_team.length).toBeGreaterThan(0);

    // An unread message from the therapist (027) -> Read message from <name>; the badge counts it.
    const [thread] = await sql<{ id: string }[]>`
      insert into message_threads (case_id, org_id, child_id, subject, created_by)
      values (${caseId}, ${provider.orgId}, ${d.childId}, 'Homework (synthetic)', ${provider.user.id}) returning id`;
    await sql`insert into messages (thread_id, sender_id, sender_kind, body, client_id) values (${thread.id}, ${provider.user.id}, 'provider', 'See you soon (synthetic)', gen_random_uuid())`;
    expect(await stepOf(d.user)).toMatchObject({ rule: "message", thread_id: thread.id, from: "Dr pa (synthetic)", href: `/family/messages/${thread.id}` });
    expect(await ns.familyUnreadCount(d.user.id)).toBe(1);

    // A visit tomorrow outranks practice and messages.
    const tomorrowNoon = new Date(Date.parse(`${addDays(today, 1)}T12:00:00+05:30`));
    const hours = (tomorrowNoon.getTime() - Date.now()) / 3_600_000;
    const id = await appt(d, caseId, hours);
    expect(await stepOf(d.user)).toMatchObject({ rule: "visit", day: "tomorrow", visit: { id, lat: 17.41, lng: 78.44 } });
  });

  it("NFR-1: 50 children with appointments load in under 800 ms (a fixed number of queries)", async () => {
    const big = await world.guardian("gbig");
    const kids: string[] = [];
    const [{ ids }] = await sql<{ ids: string[] }[]>`
      with made as (
        insert into children (display_name, date_of_birth, source, created_by)
        select 'Load child ' || g || ' (synthetic)', '2021-01-01', 'guardian', ${big.user.id} from generate_series(1, 49) g
        returning id
      )
      select array_agg(id) as ids from made`;
    kids.push(...ids);
    for (const id of kids) world.trackChild(id);
    await sql`
      insert into guardian_links (child_id, user_id, relationship, status, verification_method, declared_at)
      select unnest(${kids}::uuid[]), ${big.user.id}, 'mother', 'active', 'self_registered', now()`;
    for (const [i, childId] of [big.childId, ...kids].entries()) {
      await appt({ user: big.user, childId }, null, 100 + i * 2, { intake: i % 2 === 0 });
    }
    await ns.loadFamilyFacts(big.user.id, { timeZone: TZ });
    const started = performance.now();
    const facts = await ns.loadFamilyFacts(big.user.id, { timeZone: TZ });
    const ms = performance.now() - started;
    console.info(`052 NFR-1 family facts: ${facts.children.length} children, ${facts.visits.length} visits in ${ms.toFixed(0)} ms`);
    expect(facts.children).toHaveLength(50);
    expect(facts.visits).toHaveLength(50);
    expect(ms).toBeLessThan(800);
  });
});
