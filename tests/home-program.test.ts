// Ticket 026: home program. Pure checks (adherence across week boundaries in Asia/Kolkata, date window, markdown,
// offline-safe retries) and database checks driving the real route handlers: E-1 publish and view, E-2 logging
// (idempotent upsert, date window, provider adherence + note), E-3 snapshot semantics (draft activities never reach
// guardians), E-4 authz negatives and the `home_program` share scope, goal-from-other-plan rejection, guides, stop vs
// delete, 15 active activities, one published program per case, own-log deletion, outbox event, RLS.
// Synthetic users/orgs/cases via tests/helpers/world.ts; everything is removed afterwards.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enqueueLog, flushQueue, QUEUE_KEY, readQueue, submitLog, type KeyValueStorage } from "@/components/home-program/logQueue";
import { addDays, adherence, lastSevenDays, mondayOf, todayIn, weekStartFor, weeklySeries } from "@/lib/home-program/adherence";
import { homeProgramMarkdown, instructionsBlock } from "@/lib/home-program/markdown";
import { logDateError, makeLogSchema, MAX_ACTIVE_ACTIVITIES, MSG } from "@/lib/home-program/schema";
import { todayInIndia } from "@/lib/iep/schema";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string }, timeZone: "Asia/Kolkata" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
// The guardian's browser zone (018 dnm_tz cookie) is request state; route handlers here run outside a request.
vi.mock("@/lib/i18n/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/server")>();
  return { ...actual, getTimeZone: vi.fn(async () => session.timeZone) };
});

const IST = "Asia/Kolkata";
const ACT = { id: "a1", frequency_per_week: 5 };

describe("adherence (FR-6): Monday-start weeks in the guardian's time zone", () => {
  // 2026-11-15 is a Sunday. 23:30 IST = 18:00 UTC; 00:30 IST on Monday = 19:00 UTC, still Sunday in UTC.
  const sundayLate = new Date("2026-11-15T18:00:00Z");
  const mondayEarly = new Date("2026-11-15T19:00:00Z");

  it("Sunday 23:30 IST and Monday 00:30 IST fall into different weeks (UTC alone would not split them)", () => {
    expect(todayIn(IST, sundayLate)).toBe("2026-11-15");
    expect(todayIn(IST, mondayEarly)).toBe("2026-11-16");
    expect(todayIn("UTC", mondayEarly)).toBe("2026-11-15");
    expect(weekStartFor(sundayLate, IST)).toBe("2026-11-09");
    expect(weekStartFor(mondayEarly, IST)).toBe("2026-11-16");
    expect(weekStartFor(mondayEarly, "UTC")).toBe("2026-11-09");
  });

  it("a Sunday-night log counts in the old week, a Monday 00:30 log in the new one", () => {
    const logs = [
      { activity_id: "a1", done_on: todayIn(IST, sundayLate) },
      { activity_id: "a1", done_on: todayIn(IST, mondayEarly) },
      { activity_id: "a1", done_on: "2026-11-09" },
      { activity_id: "other", done_on: "2026-11-16" },
    ];
    expect(adherence(logs, ACT, weekStartFor(sundayLate, IST))).toEqual({
      week_start: "2026-11-09",
      week_end: "2026-11-15",
      done: 2,
      expected: 5,
      percent: 40,
      met: false,
    });
    expect(adherence(logs, ACT, weekStartFor(mondayEarly, IST))).toMatchObject({ week_start: "2026-11-16", week_end: "2026-11-22", done: 1 });
    // Any date of the week is normalised to its Monday.
    expect(adherence(logs, ACT, "2026-11-12").week_start).toBe("2026-11-09");
  });

  it("caps the percentage, counts two guardians' logs of one day, and builds the 4-week series and last 7 days", () => {
    const logs = Array.from({ length: 7 }, (_, i) => ({ activity_id: "a1", done_on: addDays("2026-11-16", i) }));
    logs.push({ activity_id: "a1", done_on: "2026-11-16" });
    expect(adherence(logs, { id: "a1", frequency_per_week: 3 }, "2026-11-16")).toMatchObject({ done: 8, percent: 100, met: true });
    const series = weeklySeries([{ activity_id: "a1", done_on: "2026-10-27" }, { activity_id: "a1", done_on: "2026-11-17" }], ACT, "2026-11-18");
    expect(series.map((w) => [w.week_start, w.done])).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 0],
      ["2026-11-09", 0],
      ["2026-11-16", 1],
    ]);
    expect(lastSevenDays([{ activity_id: "a1", done_on: "2026-11-12" }, { activity_id: "a1", done_on: "2026-11-11" }], ACT, "2026-11-18")).toMatchObject({
      from: "2026-11-12",
      done: 1,
      expected: 5,
    });
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");
  });
});

describe("log date window (FR-5)", () => {
  const today = "2026-11-13";
  it("accepts today and up to 14 days back; rejects the future and older dates", () => {
    expect(logDateError(today, today)).toBeNull();
    expect(logDateError("2026-10-30", today)).toBeNull();
    expect(logDateError("2026-11-14", today)).toBe(MSG.futureDate);
    expect(logDateError("2026-10-29", today)).toBe(MSG.tooOld);
    expect(logDateError("2026-10-24", today)).toBe(MSG.tooOld);
    expect(logDateError("2026-02-30", today)).toMatch(/valid date/);
    const schema = makeLogSchema(today);
    expect(schema.safeParse({ done_on: today, difficulty: "okay" }).data).toEqual({ done_on: today, difficulty: "okay", duration_min: null, note: null });
    expect(schema.safeParse({ done_on: today, difficulty: "fine" }).success).toBe(false);
    expect(schema.safeParse({ done_on: today, difficulty: "okay", duration_min: 0 }).success).toBe(false);
    expect(schema.safeParse({ done_on: today, difficulty: "okay", note: "x".repeat(501) }).success).toBe(false);
  });
});

describe("published markdown (FR-3)", () => {
  it("renders active activities with the published goal wording; provider text cannot add headings", () => {
    const md = homeProgramMarkdown({ title: "Home *plan*" }, [
      {
        title: "Snack-time requesting",
        instructions_md: "# Step one\n- Hold the snack\n- Wait for a word",
        frequency_per_week: 5,
        duration_min: 10,
        materials: "Favourite snacks",
        goal_statement: "Asha will request 5 items",
        has_guide: true,
      },
      { title: "Bubbles", instructions_md: "Blow bubbles", frequency_per_week: 1, duration_min: 1, materials: null, goal_statement: null, has_guide: false },
    ]);
    expect(md).toContain("# Home \\*plan\\*");
    expect(md).toContain("## 1. Snack-time requesting");
    expect(md).toContain("- **Linked goal:** Asha will request 5 items");
    expect(md).toContain("- **How often:** 5 times a week, 10 minutes each time");
    expect(md).toContain("- **Guide:** a picture or PDF guide is attached");
    expect(md).toContain("- **How often:** 1 time a week, 1 minute each time");
    expect(md).not.toMatch(/^# Step one/m);
    expect(instructionsBlock("## Do this\r\n===\n- a")).toBe("Do this\n\n- a");
  });
});

describe("offline-safe Done today (NFR-1)", () => {
  const body = { done_on: "2026-11-13", difficulty: "okay" as const };
  const memory = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it("retries a network failure with the same body and never sends a different date", async () => {
    const calls: string[] = [];
    let n = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${init?.body}`);
      if (n++ === 0) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ log: { id: "l1" } }), { status: 200 });
    }) as typeof fetch;
    const result = await submitLog(fetchImpl, { activityId: "a1", body }, { delayMs: 0 });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);
  });

  it("queues the log on the phone when offline (one entry per activity and day) and flushes it later", async () => {
    const storage = memory();
    const offline = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    expect(await submitLog(offline, { activityId: "a1", body }, { delayMs: 0, storage })).toEqual({ ok: false, status: 0, queued: true });
    enqueueLog(storage, { activityId: "a1", body: { ...body, difficulty: "easy" } });
    expect(readQueue(storage)).toEqual([{ activityId: "a1", body: { ...body, difficulty: "easy" } }]);
    expect(await flushQueue(offline, storage)).toBe(0);
    expect(readQueue(storage)).toHaveLength(1);
    const sent: string[] = [];
    const online = (async (url: string) => {
      sent.push(url);
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    expect(await flushQueue(online, storage)).toBe(1);
    expect(sent).toEqual(["/api/family/home-activities/a1/logs"]);
    expect(JSON.parse(storage.data.get(QUEUE_KEY) ?? "null")).toEqual([]);
  });

  it("does not retry 4xx answers", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response(JSON.stringify({ error: "Invalid request", details: { done_on: MSG.futureDate } }), { status: 400 });
    }) as typeof fetch;
    expect(await submitLog(fetchImpl, { activityId: "a1", body }, { delayMs: 0 })).toMatchObject({ ok: false, status: 400, error: "futureDate" });
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const DRAFT_SECRET = "DRAFT-ONLY instructions that must never reach a guardian";
const GOAL_TEXT = "Asha will request 5 preferred items using 2-word phrases";

describe.skipIf(!enabled)("home program (database)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let ownerA: TestUser, providerA: TestUser, memberA: TestUser, providerB: TestUser, guardianA: TestUser, guardianB: TestUser;
  let orgA: string, orgB: string, caseA: string, caseA2: string, caseB: string, childA: string;
  let goalA: string, goalOther: string;
  let programId: string, activityId: string, secondId: string, logId: string;
  const TODAY = todayIn(IST);

  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    programs: await import("@/app/api/cases/[id]/home-programs/route"),
    program: await import("@/app/api/home-programs/[pid]/route"),
    activities: await import("@/app/api/home-programs/[pid]/activities/route"),
    publish: await import("@/app/api/home-programs/[pid]/publish/route"),
    activity: await import("@/app/api/home-activities/[aid]/route"),
    logs: await import("@/app/api/family/home-activities/[aid]/logs/route"),
    log: await import("@/app/api/family/home-activity-logs/[id]/route"),
    family: await import("@/app/api/family/children/[id]/home-program/route"),
  });

  const createProgram = async (title: string, caseId = caseA) =>
    (await routes()).programs.POST(post(`http://x/api/cases/${caseId}/home-programs`, { title }), ctx({ id: caseId }));
  const getProgram = async (id: string) => (await routes()).program.GET(post("http://x", undefined, "GET"), ctx({ pid: id }));
  const patchProgram = async (id: string, body: Record<string, unknown>) => (await routes()).program.PATCH(post("http://x", body, "PATCH"), ctx({ pid: id }));
  const addActivity = async (id: string, body: Record<string, unknown>) => (await routes()).activities.POST(post("http://x", body), ctx({ pid: id }));
  const publish = async (id: string, version: number) => (await routes()).publish.POST(post("http://x", { version }), ctx({ pid: id }));
  const patchActivity = async (id: string, body: Record<string, unknown>) => (await routes()).activity.PATCH(post("http://x", body, "PATCH"), ctx({ aid: id }));
  const deleteActivity = async (id: string) =>
    (await routes()).activity.DELETE(post(`http://x/api/home-activities/${id}`, undefined, "DELETE"), ctx({ aid: id }));
  const log = async (id: string, body: Record<string, unknown>) => (await routes()).logs.POST(post("http://x", body), ctx({ aid: id }));
  const deleteLog = async (id: string) => (await routes()).log.DELETE(post("http://x", undefined, "DELETE"), ctx({ id }));
  const family = async (childId = childA) => (await routes()).family.GET(post("http://x", undefined, "GET"), ctx({ id: childId }));
  const versionOf = async (id: string) => (await sql<{ version: number }[]>`select version from home_programs where id = ${id}`)[0].version;
  const activityBody = (overrides: Record<string, unknown> = {}) => ({
    title: "Snack-time requesting",
    instructions_md: "Hold up two snacks.\n\n- Wait 5 seconds\n- Model the 2-word phrase",
    frequency_per_week: 5,
    duration_min: 10,
    materials: "Two favourite snacks",
    goal_id: goalA,
    ...overrides,
  });

  async function activePlanWithGoal(caseId: string, statement: string): Promise<string> {
    const iep = await import("@/lib/iep");
    const plan = await iep.createPlan({ caseId, actorUserId: ownerA.id, body: { title: `${world.tag} plan`, start_date: todayInIndia(), review_date: shift(todayInIndia(), 180) } });
    if (!plan.ok) throw new Error(plan.error);
    const goal = await iep.addGoal({
      planId: plan.plan.id,
      actorUserId: ownerA.id,
      body: {
        domain: "communication",
        statement,
        specific: "Requests snacks and toys",
        measurable: "Count of requests per session",
        achievable: "Uses single words today",
        relevant: "Less frustration at home",
        time_bound: "Within 3 months",
        measure_type: "count",
        baseline_value: 1,
        target_value: 5,
        target_date: shift(todayInIndia(), 90),
        version: 1,
      },
    });
    if (!goal.ok) throw new Error(goal.error);
    const published = await iep.publishPlan({ planId: plan.plan.id, actorUserId: ownerA.id, version: goal.plan_version });
    if (!published.ok) throw new Error(published.error);
    return goal.goal.id;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t026");
    ownerA = await world.user("ownera", "provider");
    providerA = await world.user("providera", "provider");
    memberA = await world.user("membera", "provider");
    providerB = await world.user("providerb", "provider");
    guardianA = await world.user("guardiana", "guardian");
    guardianB = await world.user("guardianb", "guardian");
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
    for (const u of [providerA, memberA]) await world.member(orgA, u);
    const kase = await world.kase(orgA);
    caseA = kase.caseId;
    childA = kase.childId;
    await world.link(childA, guardianA);
    await sql`insert into case_assignments (case_id, user_id) values (${caseA}, ${providerA.id})`;
    caseA2 = (await world.kase(orgA)).caseId; // another child of org A, with its own plan
    caseB = (await world.kase(orgB, { childId: childA })).caseId; // org B treats the same child
    const other = await world.kase(orgB);
    await world.link(other.childId, guardianB);
    goalA = await activePlanWithGoal(caseA, GOAL_TEXT);
    goalOther = await activePlanWithGoal(caseA2, "Another child's goal that is not in this plan");
  });

  afterAll(async () => {
    as(null);
    if (sql && caseA) {
      await sql`delete from outbox_events where aggregate_type in ('home_program', 'iep_plan')
                and payload ->> 'case_id' in (${caseA}, ${caseA2}, ${caseB})`;
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("E-1.1: provider adds `Snack-time requesting` linked to the goal (5/week, 10 min); a goal of another case -> 422", async () => {
    as(providerA);
    const created = await createProgram(`${world.tag} Home practice`);
    expect(created.status).toBe(201);
    const { program } = await created.json();
    programId = program.id;
    expect(program).toMatchObject({ case_id: caseA, child_id: childA, org_id: orgA, status: "draft", version: 1 });
    expect(program.plan_id).not.toBeNull();

    const foreign = await addActivity(programId, activityBody({ goal_id: goalOther, version: 1 }));
    expect(foreign.status).toBe(422);
    expect(await foreign.json()).toMatchObject({ error: "Choose a goal from this child's plan" });
    expect((await addActivity(programId, activityBody({ goal_id: randomUUID() }))).status).toBe(422);
    expect((await addActivity(programId, activityBody({ frequency_per_week: 15 }))).status).toBe(400);
    expect((await addActivity(programId, activityBody({ duration_min: 0 }))).status).toBe(400);
    expect((await addActivity(programId, activityBody({ instructions_md: "" }))).status).toBe(400);

    const res = await addActivity(programId, activityBody({ version: 1 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    activityId = body.activity.id;
    expect(body.activity).toMatchObject({ title: "Snack-time requesting", goal_id: goalA, frequency_per_week: 5, duration_min: 10, active: true });
    expect(body.program_version).toBe(2);
  });

  it("E-1.2 / E-3: guardians see nothing before publishing; publish -> v1, outbox event, guardian `0/5 this week`", async () => {
    as(guardianA);
    expect(await (await family()).json()).toEqual({ programs: [], my_logs: [] });
    expect((await log(activityId, { done_on: TODAY, difficulty: "okay" })).status).toBe(404);

    as(providerA);
    expect((await publish(programId, 1)).status).toBe(409);
    const res = await publish(programId, await versionOf(programId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ published_version: 1, program: { status: "published" }, archived_program_id: null });
    const [pv] = await sql<{ version: number; visible_to_guardian: boolean; content_md: string }[]>`
      select version, visible_to_guardian, content_md from published_versions where entity_type = 'home_program' and entity_id = ${programId}`;
    expect(pv).toMatchObject({ version: 1, visible_to_guardian: true });
    expect(pv.content_md).toContain("## 1. Snack-time requesting");
    expect(pv.content_md).toContain(`- **Linked goal:** ${GOAL_TEXT}`);
    const [event] = await sql<{ topic: string; payload: Record<string, unknown>; dedup_key: string }[]>`
      select topic, payload, dedup_key from outbox_events where aggregate_type = 'home_program' and aggregate_id = ${programId}`;
    expect(event).toEqual({ topic: "home_program.published", payload: { program_id: programId, child_id: childA, case_id: caseA }, dedup_key: `home_program:${programId}:v1` });
    const actions = await sql<{ action: string }[]>`
      select action from audit_events where entity in ('home_program', 'home_activity') and case_id = ${caseA} order by id`;
    expect(actions.map((a) => a.action)).toEqual(["home_program.created", "home_program.activity_added", "home_program.published"]);

    as(guardianA);
    const fam = await family();
    expect(fam.status).toBe(200);
    const { programs } = await fam.json();
    expect(programs).toHaveLength(1);
    expect(programs[0]).toMatchObject({ program_id: programId, title: `${world.tag} Home practice`, week_start: mondayOf(TODAY) });
    expect(programs[0].activities).toHaveLength(1);
    expect(programs[0].activities[0]).toMatchObject({
      id: activityId,
      title: "Snack-time requesting",
      frequency_per_week: 5,
      goal: { id: goalA, statement: GOAL_TEXT },
      this_week: { done: 0, expected: 5 },
    });

    as(providerA);
    const again = await publish(programId, await versionOf(programId));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe(MSG.nothingToPublish);
  });

  it("E-2: Done today (Okay) -> 201 and 1/5; the same request again -> 200, still one row; future / 20 days ago -> 400", async () => {
    as(guardianA);
    const first = await log(activityId, { done_on: TODAY, difficulty: "okay", note: "Asked for biscuit twice" });
    expect(first.status).toBe(201);
    logId = (await first.json()).log.id;
    const retry = await log(activityId, { done_on: TODAY, difficulty: "okay", note: "Asked for biscuit twice" });
    expect(retry.status).toBe(200);
    expect((await retry.json()).log.id).toBe(logId);
    const rows = await sql`select id from home_activity_logs where activity_id = ${activityId}`;
    expect(rows).toHaveLength(1);
    const [{ programs }] = [await (await family()).json()];
    expect(programs[0].activities[0].this_week).toMatchObject({ done: 1, expected: 5 });

    const tomorrow = await log(activityId, { done_on: addDays(TODAY, 1), difficulty: "okay" });
    expect(tomorrow.status).toBe(400);
    expect((await tomorrow.json()).details.done_on).toBe(MSG.futureDate);
    const old = await log(activityId, { done_on: addDays(TODAY, -20), difficulty: "okay" });
    expect(old.status).toBe(400);
    expect((await old.json()).details.done_on).toBe(MSG.tooOld);
    expect((await log(activityId, { done_on: TODAY, difficulty: "meh" })).status).toBe(400);
    const [{ child_id }] = await sql<{ child_id: string }[]>`select child_id from home_activity_logs where id = ${logId}`;
    expect(child_id).toBe(childA);

    as(providerA);
    const detail = await (await getProgram(programId)).json();
    const adh = detail.adherence.find((a: { activity_id: string }) => a.activity_id === activityId);
    expect(adh.last_7_days).toMatchObject({ done: 1, expected: 5 });
    expect(adh.weeks).toHaveLength(4);
    expect(adh.recent_notes).toEqual([expect.objectContaining({ note: "Asked for biscuit twice", difficulty: "okay", done_on: TODAY })]);
    expect(detail.time_zone).toBe(IST);
  });

  it("E-3 / NFR-2: an unpublished second activity and an unpublished edit never reach the guardian; publish -> visible", async () => {
    as(providerA);
    const res = await addActivity(programId, activityBody({ title: "Bubble turn-taking", goal_id: null, version: await versionOf(programId) }));
    expect(res.status).toBe(201);
    secondId = (await res.json()).activity.id;
    expect((await patchActivity(activityId, { instructions_md: DRAFT_SECRET, version: await versionOf(programId) })).status).toBe(200);
    expect((await (await getProgram(programId)).json()).program.has_unpublished_changes).toBe(true);

    as(guardianA);
    const before = await (await family()).json();
    expect(before.programs[0].activities.map((a: { id: string }) => a.id)).toEqual([activityId]);
    expect(JSON.stringify(before)).not.toContain(DRAFT_SECRET);
    expect(JSON.stringify(before)).not.toContain("Bubble turn-taking");
    const { getGuardianHomePrograms } = await import("@/lib/home-program");
    expect(JSON.stringify(await getGuardianHomePrograms(childA))).not.toContain(DRAFT_SECRET);
    const blocked = await log(secondId, { done_on: TODAY, difficulty: "easy" });
    expect(blocked.status).toBe(404);
    expect(await blocked.json()).toEqual({ error: MSG.activityNotFound });

    as(providerA);
    const published = await publish(programId, await versionOf(programId));
    expect((await published.json()).published_version).toBe(2);
    as(guardianA);
    const after = await (await family()).json();
    expect(after.programs[0].activities.map((a: { id: string }) => a.id)).toEqual([activityId, secondId]);
    expect(JSON.stringify(after)).toContain(DRAFT_SECRET);
    expect((await log(secondId, { done_on: TODAY, difficulty: "easy" })).status).toBe(201);
  });

  it("stop vs delete: a published program's activity is stopped (hidden from guardians at once, logs kept); restart re-shows it", async () => {
    as(providerA);
    const del = await deleteActivity(secondId);
    expect(await del.json()).toMatchObject({ deleted: false, activity: { active: false } });
    expect(await sql`select id from home_activity_logs where activity_id = ${secondId}`).toHaveLength(1);
    as(guardianA);
    expect((await (await family()).json()).programs[0].activities.map((a: { id: string }) => a.id)).toEqual([activityId]);
    expect((await log(secondId, { done_on: TODAY, difficulty: "hard" })).status).toBe(404);
    as(providerA);
    expect((await patchActivity(secondId, { active: true })).status).toBe(200);
    as(guardianA);
    expect((await (await family()).json()).programs[0].activities).toHaveLength(2);

    // Draft programs delete for real; 15 active activities at most.
    as(providerA);
    const draft = (await (await createProgram(`${world.tag} Draft`)).json()).program.id as string;
    const first = (await (await addActivity(draft, activityBody({ goal_id: null }))).json()).activity.id as string;
    expect(await (await deleteActivity(first)).json()).toMatchObject({ deleted: true, activity: null });
    expect(await sql`select id from home_activities where id = ${first}`).toHaveLength(0);
    for (let i = 0; i < MAX_ACTIVE_ACTIVITIES; i++) {
      expect((await addActivity(draft, activityBody({ title: `Activity ${i + 1}`, goal_id: null }))).status, `activity ${i + 1}`).toBe(201);
    }
    const tooMany = await addActivity(draft, activityBody({ goal_id: null }));
    expect(tooMany.status).toBe(422);
    expect((await tooMany.json()).error).toBe(MSG.tooManyActivities);
    await expect(sql`insert into home_activities (program_id, title, instructions_md, frequency_per_week, duration_min)
      values (${draft}, 'x', 'x', 1, 1)`).rejects.toThrow(/at most 15/);
    await sql`delete from home_programs where id = ${draft}`;
  });

  it("guides: only a ready, parent-visible document of the same case; the guardian gets the 023 download link", async () => {
    const doc = async (caseId: string, visible: boolean) => {
      const id = randomUUID();
      const [c] = await sql<{ child_id: string; org_id: string }[]>`select child_id, org_id from cases where id = ${caseId}`;
      await sql`insert into documents (id, child_id, case_id, org_id, uploaded_by, uploader_kind, category, title, file_name, mime_type,
                  size_bytes, storage_path, status, visible_to_guardian, completed_at)
                values (${id}, ${c.child_id}, ${caseId}, ${c.org_id}, ${providerA.id}, 'provider', 'other', 'Snack guide', 'guide.pdf',
                  'application/pdf', 1000, ${`${c.child_id}/${id}.pdf`}, 'ready', ${visible}, now())`;
      return id;
    };
    const hidden = await doc(caseA, false);
    const foreign = await doc(caseA2, true);
    const good = await doc(caseA, true);
    as(providerA);
    for (const id of [hidden, foreign, randomUUID()]) {
      const res = await patchActivity(activityId, { document_id: id });
      expect(res.status, id).toBe(422);
      expect((await res.json()).error).toBe(MSG.guideNotInCase);
    }
    expect((await patchActivity(activityId, { document_id: good })).status).toBe(200);
    expect((await publish(programId, await versionOf(programId))).status).toBe(200);
    as(guardianA);
    const act = (await (await family()).json()).programs[0].activities.find((a: { id: string }) => a.id === activityId);
    expect(act.guide).toEqual({ document_id: good, title: "Snack guide", file_name: "guide.pdf", mime_type: "application/pdf", download_url: `/api/documents/${good}/download` });
    // Hidden from the parent later -> no guide link.
    await sql`update documents set visible_to_guardian = false where id = ${good}`;
    expect((await (await family()).json()).programs[0].activities.find((a: { id: string }) => a.id === activityId).guide).toBeNull();
    await sql`update documents set visible_to_guardian = true where id = ${good}`;
  });

  it("concurrency: a stale PATCH -> 409; archived programs are read only", async () => {
    as(providerA);
    const version = await versionOf(programId);
    expect((await patchProgram(programId, { title: `${world.tag} Home practice`, version })).status).toBe(200);
    const stale = await patchProgram(programId, { title: "Other", version });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: MSG.stale, details: { version: version + 1 } });
    expect((await patchProgram(programId, { status: "published", version: version + 1 })).status).toBe(400);
  });

  it("E-4: other guardians, other orgs, guardians on provider APIs, anonymous; provider_b reads read-only with a grant", async () => {
    as(guardianB);
    expect((await log(activityId, { done_on: TODAY, difficulty: "okay" })).status).toBe(404);
    expect((await deleteLog(logId)).status).toBe(404);
    expect((await family()).status).toBe(404);

    as(providerB);
    expect((await getProgram(programId)).status).toBe(404);
    expect((await patchProgram(programId, { title: "x", version: 1 })).status).toBe(404);
    expect((await addActivity(programId, activityBody())).status).toBe(404);
    expect((await patchActivity(activityId, { title: "x" })).status).toBe(404);
    expect((await publish(programId, 1)).status).toBe(404);
    expect((await (await routes()).programs.GET(post("http://x", undefined, "GET"), ctx({ id: caseA }))).status).toBe(404);

    const { listSharedForCase, openSharedItem } = await import("@/lib/sharing/shared");
    const kaseB = { id: caseB, org_id: orgB, child_id: childA };
    expect(await listSharedForCase(providerB.id, kaseB)).toEqual([]);
    as(guardianA);
    const { POST: share } = await import("@/app/api/family/children/[id]/sharing-grants/route");
    expect((await share(post("http://x", { source_org_id: orgA, grantee_org_id: orgB, scopes: ["home_program"] }), ctx({ id: childA }))).status).toBe(201);
    const sources = await listSharedForCase(providerB.id, kaseB);
    const scope = sources[0].scopes.find((s) => s.scope === "home_program")!;
    expect(scope.available).toBe(true);
    expect(scope.items.map((i) => i.id)).toEqual([programId]);
    const opened = await openSharedItem(providerB.id, kaseB, "home_program", programId);
    const md = opened?.item.body.kind === "markdown" ? opened.item.body.markdown : "";
    expect(md).toContain("## Adherence");
    expect(md).toContain("Snack-time requesting");
    expect(md).toMatch(/\| Snack-time requesting \| 1 of 5 \|/);
    expect(md).not.toContain("Asked for biscuit twice");
    expect(await openSharedItem(providerB.id, kaseB, "home_program", randomUUID())).toBeNull();
    as(providerB);
    expect((await getProgram(programId)).status).toBe(404);
    expect((await patchActivity(activityId, { title: "x" })).status).toBe(404);

    as(memberA); // org A member, not on the care team
    expect((await getProgram(programId)).status).toBe(404);
    as(guardianA);
    expect((await getProgram(programId)).status).toBe(403);
    expect((await createProgram("x")).status).toBe(403);
    expect((await patchActivity(activityId, { title: "x" })).status).toBe(403);
    as(providerA);
    expect((await family()).status).toBe(403);
    expect((await log(activityId, { done_on: TODAY, difficulty: "okay" })).status).toBe(403);
    as(null);
    expect((await getProgram(programId)).status).toBe(401);
    expect((await log(activityId, { done_on: TODAY, difficulty: "okay" })).status).toBe(401);
    as(providerA);
    expect((await getProgram("not-a-uuid")).status).toBe(404);
    expect((await patchActivity(randomUUID(), { title: "x" })).status).toBe(404);
  });

  it("guardians delete their own logs of this week only; a revoked link ends logging", async () => {
    as(guardianA);
    const older = await log(activityId, { done_on: addDays(TODAY, -8), difficulty: "hard" });
    expect(older.status).toBe(201);
    const olderId = (await older.json()).log.id;
    const res = await deleteLog(olderId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.notThisWeek);
    expect((await deleteLog(logId)).status).toBe(200);
    expect((await deleteLog(logId)).status).toBe(404);
    expect(await sql`select action from audit_events where entity = 'home_activity_log' and entity_id = ${logId}`).toEqual([{ action: "home_program.log_deleted" }]);

    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childA} and user_id = ${guardianA.id}`;
    try {
      expect((await log(activityId, { done_on: TODAY, difficulty: "okay" })).status).toBe(404);
      expect((await deleteLog(olderId)).status).toBe(404);
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${childA} and user_id = ${guardianA.id}`;
    }
  });

  it("one published program per case: publishing another archives the first; the guardian sees only the new one", async () => {
    as(providerA);
    const next = (await (await createProgram(`${world.tag} Term 2`)).json()).program.id as string;
    await addActivity(next, activityBody({ title: "Picture book naming" }));
    const res = await publish(next, await versionOf(next));
    expect(await res.json()).toMatchObject({ archived_program_id: programId, program: { status: "published" } });
    const statuses = await sql<{ id: string; status: string }[]>`select id, status from home_programs where case_id = ${caseA} order by created_at`;
    expect(statuses.map((s) => s.status)).toEqual(["archived", "published"]);
    await expect(sql`update home_programs set status = 'published' where id = ${programId}`).rejects.toThrow(/home_programs_one_published_per_case/);
    expect((await patchActivity(activityId, { title: "x" })).status).toBe(409);
    as(guardianA);
    const { programs } = await (await family()).json();
    expect(programs.map((p: { program_id: string }) => p.program_id)).toEqual([next]);
    expect((await log(activityId, { done_on: TODAY, difficulty: "okay" })).status).toBe(404);
  });

  it("RLS: the care team reads programs, activities and logs; guardians and other orgs read nothing; no client writes", async () => {
    const read = (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [{ p }] = await tx<{ p: number }[]>`select count(*)::int as p from home_programs where id = ${programId}`;
        const [{ a }] = await tx<{ a: number }[]>`select count(*)::int as a from home_activities where id = ${activityId}`;
        const [{ l }] = await tx<{ l: number }[]>`select count(*)::int as l from home_activity_logs where activity_id = ${activityId}`;
        const [{ s }] = await tx<{ s: number }[]>`select count(*)::int as s from home_program_publications where program_id = ${programId}`;
        return [p, a, Math.min(l, 1), Math.min(s, 1)];
      });
    expect(await read(providerA.id)).toEqual([1, 1, 1, 1]);
    expect(await read(guardianA.id)).toEqual([0, 0, 0, 0]);
    expect(await read(providerB.id)).toEqual([0, 0, 0, 0]);
    expect(await read(memberA.id)).toEqual([0, 0, 0, 0]);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: guardianA.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`insert into home_activity_logs (activity_id, child_id, logged_by, done_on, difficulty) values (${activityId}, ${childA}, ${guardianA.id}, ${TODAY}, 'easy')`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
