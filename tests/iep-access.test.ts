// Ticket 025 (FR-1..FR-8, NFR-1): IEP plans against the local database, driving the real route handlers.
// E-1 create/publish/view (published_versions 1 and 2, guardian keeps the old text until republished), E-2 progress
// (3 points, on track, future date 400), E-3 concurrent edit (409), E-4 authz negatives and the `iep` share scope,
// single active plan per case, delete vs discontinue, max 20 goals, outbox `iep.published`, RLS.
// Synthetic users/orgs/cases via tests/helpers/world.ts; everything is removed afterwards.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MSG, MAX_GOALS_PER_PLAN, todayInIndia } from "@/lib/iep/schema";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const DAY = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const TODAY = todayInIndia();
const STATEMENT_V1 = "Asha will request 5 preferred items using 2-word phrases";
const STATEMENT_V2 = "Asha will request 6 preferred items using 2-word phrases at home and school";
const DRAFT_SECRET = "DRAFT-ONLY wording that must never reach a guardian";

const goalBody = (version: number, overrides: Record<string, unknown> = {}) => ({
  domain: "communication",
  statement: STATEMENT_V1,
  specific: "Requests snacks and toys with 2-word phrases",
  measurable: "Count of independent requests per session",
  achievable: "Uses single words for 3 items today",
  relevant: "Reduces frustration at home and school",
  time_bound: "Within 3 months, checked weekly",
  measure_type: "count",
  baseline_value: 1,
  target_value: 5,
  target_date: shift(TODAY, 90),
  version,
  ...overrides,
});

describe.skipIf(!enabled)("IEP plans (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let ownerA: TestUser, providerA: TestUser, providerA2: TestUser, memberA: TestUser, providerB: TestUser;
  let guardianA: TestUser, guardianB: TestUser;
  let orgA: string, orgB: string, caseA: string, caseB: string, childA: string;
  let planId: string, goalId: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    plans: await import("@/app/api/cases/[id]/iep-plans/route"),
    plan: await import("@/app/api/iep-plans/[planId]/route"),
    publish: await import("@/app/api/iep-plans/[planId]/publish/route"),
    goals: await import("@/app/api/iep-plans/[planId]/goals/route"),
    goal: await import("@/app/api/iep-goals/[goalId]/route"),
    progress: await import("@/app/api/iep-goals/[goalId]/progress/route"),
    family: await import("@/app/api/family/children/[id]/plan/route"),
  });

  async function createPlan(body: Record<string, unknown>, caseId = caseA) {
    return (await routes()).plans.POST(post(`http://x/api/cases/${caseId}/iep-plans`, body), ctx({ id: caseId }));
  }
  async function getPlan(id: string) {
    return (await routes()).plan.GET(post("http://x", undefined, "GET"), ctx({ planId: id }));
  }
  async function patchPlan(id: string, body: Record<string, unknown>) {
    return (await routes()).plan.PATCH(post("http://x", body, "PATCH"), ctx({ planId: id }));
  }
  async function publish(id: string, version: number) {
    return (await routes()).publish.POST(post("http://x", { version }), ctx({ planId: id }));
  }
  async function addGoal(id: string, body: Record<string, unknown>) {
    return (await routes()).goals.POST(post("http://x", body), ctx({ planId: id }));
  }
  async function patchGoal(id: string, body: Record<string, unknown>) {
    return (await routes()).goal.PATCH(post("http://x", body, "PATCH"), ctx({ goalId: id }));
  }
  async function deleteGoal(id: string, version?: number) {
    return (await routes()).goal.DELETE(post(`http://x/api/iep-goals/${id}${version ? `?version=${version}` : ""}`, undefined, "DELETE"), ctx({ goalId: id }));
  }
  async function record(id: string, body: Record<string, unknown>) {
    return (await routes()).progress.POST(post("http://x", body), ctx({ goalId: id }));
  }
  async function familyPlan(childId = childA) {
    return (await routes()).family.GET(post("http://x", undefined, "GET"), ctx({ id: childId }));
  }
  const versionOf = async (id: string) => (await sql<{ version: number }[]>`select version from iep_plans where id = ${id}`)[0].version;
  const published = async (id: string) =>
    sql<{ version: number; content_md: string; visible_to_guardian: boolean }[]>`
      select version, content_md, visible_to_guardian from published_versions
      where entity_type = 'iep_plan' and entity_id = ${id} order by version`;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t025");
    ownerA = await world.user("ownera", "provider");
    providerA = await world.user("providera", "provider");
    providerA2 = await world.user("providera2", "provider");
    memberA = await world.user("membera", "provider");
    providerB = await world.user("providerb", "provider");
    guardianA = await world.user("guardiana", "guardian");
    guardianB = await world.user("guardianb", "guardian");
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
    for (const u of [providerA, providerA2, memberA]) await world.member(orgA, u);
    const kase = await world.kase(orgA);
    caseA = kase.caseId;
    childA = kase.childId;
    await world.link(childA, guardianA);
    for (const u of [providerA, providerA2]) {
      await sql`insert into case_assignments (case_id, user_id) values (${caseA}, ${u.id})`;
    }
    caseB = (await world.kase(orgB, { childId: childA })).caseId; // org B treats the same child
    const other = await world.kase(orgB);
    await world.link(other.childId, guardianB);
  });

  afterAll(async () => {
    as(null);
    if (sql && caseA) {
      await sql`delete from outbox_events where aggregate_type = 'iep_plan'
                and aggregate_id in (select id from iep_plans where case_id in (${caseA}, ${caseB}))`;
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("E-1.1: create a plan; a goal without `Measurable` is rejected; a full SMART goal is added", async () => {
    as(providerA);
    const created = await createPlan({ title: `${world.tag} Term 1`, start_date: TODAY, review_date: shift(TODAY, 180) });
    expect(created.status).toBe(201);
    const { plan } = await created.json();
    planId = plan.id;
    expect(plan).toMatchObject({ case_id: caseA, child_id: childA, org_id: orgA, status: "draft", version: 1 });

    const noMeasurable = goalBody(1) as Record<string, unknown>;
    delete noMeasurable.measurable;
    const bad = await addGoal(planId, noMeasurable);
    expect(bad.status).toBe(400);
    expect((await bad.json()).details).toHaveProperty("measurable");
    expect((await addGoal(planId, goalBody(1, { target_date: shift(TODAY, 181) }))).status).toBe(400);
    expect((await addGoal(planId, goalBody(1, { measure_type: "percent", target_value: 120 }))).status).toBe(400);

    const res = await addGoal(planId, goalBody(1));
    expect(res.status).toBe(201);
    const body = await res.json();
    goalId = body.goal.id;
    expect(body.goal).toMatchObject({ domain: "communication", statement: STATEMENT_V1, baseline_value: 1, target_value: 5, status: "active" });
    expect(body.plan_version).toBe(2);
    expect((await createPlan({ title: "x", start_date: TODAY, review_date: shift(TODAY, 400) })).status).toBe(400);
  });

  it("E-1.2: publish -> active, published version 1 visible to the guardian, outbox iep.published, audit", async () => {
    as(providerA);
    expect((await publish(planId, 1)).status).toBe(409); // stale version
    const res = await publish(planId, await versionOf(planId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published_version).toBe(1);
    expect(body.plan.status).toBe("active");
    const rows = await published(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0].visible_to_guardian).toBe(true);
    expect(rows[0].content_md).toContain(`# ${world.tag} Term 1`);
    expect(rows[0].content_md).toContain(STATEMENT_V1);

    const [event] = await sql<{ topic: string; payload: Record<string, unknown>; dedup_key: string }[]>`
      select topic, payload, dedup_key from outbox_events where aggregate_type = 'iep_plan' and aggregate_id = ${planId}`;
    expect(event).toEqual({ topic: "iep.published", payload: { plan_id: planId, child_id: childA, case_id: caseA }, dedup_key: `iep:${planId}:v1` });
    const actions = await sql<{ action: string; actor_user_id: string }[]>`
      select action, actor_user_id from audit_events where entity in ('iep_plan', 'iep_goal') and case_id = ${caseA} order by id`;
    expect(actions.map((a) => a.action)).toEqual(["iep.plan_created", "iep.goal_added", "iep.published"]);
    expect(actions.every((a) => a.actor_user_id === providerA.id)).toBe(true);

    as(guardianA);
    const fam = await familyPlan();
    expect(fam.status).toBe(200);
    const { plans } = await fam.json();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ plan_id: planId, version: 1, title: `${world.tag} Term 1` });
    expect(plans[0].content_md).toContain(STATEMENT_V1);
    expect(plans[0].goals.map((g: { statement: string }) => g.statement)).toEqual([STATEMENT_V1]);

    // Nothing changed -> nothing to publish.
    as(providerA);
    const again = await publish(planId, await versionOf(planId));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe(MSG.nothingToPublish);
  });

  it("E-1.3 / NFR-1: an unpublished edit shows `Unpublished changes`; the guardian keeps the old text until republished", async () => {
    as(providerA);
    const edit = await patchGoal(goalId, { statement: STATEMENT_V2, specific: DRAFT_SECRET, version: await versionOf(planId) });
    expect(edit.status).toBe(200);
    const detail = await (await getPlan(planId)).json();
    expect(detail.plan.has_unpublished_changes).toBe(true);
    expect(detail.plan.published.version).toBe(1);
    expect(detail.goals[0].statement).toBe(STATEMENT_V2);

    as(guardianA);
    const before = JSON.stringify(await (await familyPlan()).json());
    expect(before).toContain(STATEMENT_V1);
    expect(before).not.toContain(STATEMENT_V2);
    expect(before).not.toContain(DRAFT_SECRET);

    as(providerA);
    const res = await publish(planId, await versionOf(planId));
    expect((await res.json()).published_version).toBe(2);
    expect((await published(planId)).map((r) => r.version)).toEqual([1, 2]);
    expect((await (await getPlan(planId)).json()).plan.has_unpublished_changes).toBe(false);

    as(guardianA);
    const after = await (await familyPlan()).json();
    expect(after.plans[0].version).toBe(2);
    expect(after.plans[0].content_md).toContain(STATEMENT_V2);
    expect(after.plans[0].goals[0].statement).toBe(STATEMENT_V2);
  });

  it("E-2: progress 1, 2, 3 -> 3 points and on track for provider and guardian; future date 400; notes stay internal", async () => {
    as(providerA);
    for (const [i, value] of [1, 2, 3].entries()) {
      const res = await record(goalId, { observed_on: shift(TODAY, i - 3), value, ...(i === 0 ? { note: "Needed a model prompt" } : {}) });
      expect(res.status).toBe(201);
      if (i === 2) expect((await res.json()).trend).toEqual({ latest: 3, change_from_baseline: 2, percent_to_target: 50, on_track: true });
    }
    const future = await record(goalId, { observed_on: shift(TODAY, 1), value: 4 });
    expect(future.status).toBe(400);
    expect((await future.json()).details.observed_on).toBe(MSG.futureDate);
    expect((await record(goalId, { observed_on: TODAY, value: -1 })).status).toBe(400);
    const versionBefore = await versionOf(planId);

    const detail = await (await getPlan(planId)).json();
    expect(detail.goals[0].progress.map((p: { value: number }) => p.value)).toEqual([1, 2, 3]);
    expect(detail.goals[0].progress[0].note).toBe("Needed a model prompt");
    expect(detail.goals[0].trend.on_track).toBe(true);
    expect(await versionOf(planId)).toBe(versionBefore); // progress does not bump the plan version

    as(guardianA);
    const fam = await (await familyPlan()).json();
    expect(fam.plans[0].goals[0].points.map((p: { value: number }) => p.value)).toEqual([1, 2, 3]);
    expect(fam.plans[0].goals[0].trend).toMatchObject({ latest: 3, on_track: true });
    expect(JSON.stringify(fam)).not.toContain("Needed a model prompt");
    const [audit] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_events where action = 'iep.progress_recorded' and case_id = ${caseA}`;
    expect(audit.n).toBe(3);
  });

  it("E-3: two providers save from the same version -> the second gets 409 with the reload message", async () => {
    const version = await versionOf(planId);
    as(providerA);
    expect((await patchPlan(planId, { title: `${world.tag} Term 1 (A)`, version })).status).toBe(200);
    as(providerA2);
    const second = await patchPlan(planId, { title: `${world.tag} Term 1 (A2)`, version });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "This plan was changed by someone else. Reload to see the latest version.",
      details: { version: version + 1 },
    });
    expect((await patchGoal(goalId, { target_value: 6, version })).status).toBe(409);
    const [{ title }] = await sql<{ title: string }[]>`select title from iep_plans where id = ${planId}`;
    expect(title).toBe(`${world.tag} Term 1 (A)`);
    // Plan dates cannot move away from existing goal target dates.
    const narrow = await patchPlan(planId, { review_date: shift(TODAY, 30), version: version + 1 });
    expect(narrow.status).toBe(422);
    expect((await narrow.json()).error).toBe(MSG.planDatesExcludeGoals);
  });

  it("one active plan per case: publishing a new plan archives the previous one; guardian sees the newest", async () => {
    as(ownerA);
    const created = await (await createPlan({ title: `${world.tag} Term 2`, start_date: TODAY, review_date: shift(TODAY, 120) })).json();
    const second = created.plan.id as string;
    expect((await addGoal(second, goalBody(1, { domain: "social", statement: "Asha will take turns in a two-player game", measure_type: "percent", baseline_value: 20, target_value: 80 }))).status).toBe(201);
    const res = await publish(second, await versionOf(second));
    expect(res.status).toBe(200);
    expect((await res.json()).archived_plan_id).toBe(planId);
    const statuses = await sql<{ id: string; status: string }[]>`select id, status from iep_plans where case_id = ${caseA}`;
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({ [planId]: "archived", [second]: "active" });
    await expect(sql`update iep_plans set status = 'active' where id = ${planId}`).rejects.toThrow(/iep_plans_one_active_per_case/);
    expect((await patchPlan(planId, { title: "x", version: await versionOf(planId) })).status).toBe(409); // archived is closed
    expect((await record(goalId, { observed_on: TODAY, value: 4 })).status).toBe(409);

    as(guardianA);
    const fam = await (await familyPlan()).json();
    expect(fam.plans.map((p: { plan_id: string }) => p.plan_id)).toEqual([second]); // latest per organisation
  });

  it("delete: draft plans delete the goal, active plans discontinue it; max 20 goals", async () => {
    as(ownerA);
    const draft = (await (await createPlan({ title: `${world.tag} Draft`, start_date: TODAY, review_date: shift(TODAY, 120) })).json()).plan.id;
    const g1 = (await (await addGoal(draft, goalBody(1))).json()).goal.id;
    const del = await deleteGoal(g1, await versionOf(draft));
    expect(await del.json()).toMatchObject({ deleted: true, goal: null });
    expect(await sql`select id from iep_goals where id = ${g1}`).toHaveLength(0);
    expect((await deleteGoal(g1)).status).toBe(404);

    let version = await versionOf(draft);
    for (let i = 0; i < MAX_GOALS_PER_PLAN; i++) {
      const res = await addGoal(draft, goalBody(version, { statement: `Goal number ${i + 1} for the synthetic child` }));
      expect(res.status, `goal ${i + 1}`).toBe(201);
      version = (await res.json()).plan_version;
    }
    const tooMany = await addGoal(draft, goalBody(version));
    expect(tooMany.status).toBe(422);
    expect((await tooMany.json()).error).toBe(MSG.tooManyGoals);

    const [active] = await sql<{ id: string }[]>`select id from iep_plans where case_id = ${caseA} and status = 'active'`;
    const [activeGoal] = await sql<{ id: string }[]>`select id from iep_goals where plan_id = ${active.id}`;
    const disc = await deleteGoal(activeGoal.id, await versionOf(active.id));
    expect(await disc.json()).toMatchObject({ deleted: false, goal: { status: "discontinued" } });
    expect((await (await getPlan(active.id)).json()).plan.has_unpublished_changes).toBe(true);
    expect((await record(activeGoal.id, { observed_on: TODAY, value: 50 })).status).toBe(409);
    await sql`delete from iep_plans where id = ${draft}`;
  });

  it("E-4.1: provider_b (org B) gets 404 on org A's plan; with an `iep` grant it reads the published plan under `Shared with us`, read only", async () => {
    as(providerB);
    expect((await getPlan(planId)).status).toBe(404);
    expect((await patchPlan(planId, { title: "x", version: 1 })).status).toBe(404);
    expect((await patchGoal(goalId, { status: "achieved", version: 1 })).status).toBe(404);
    expect((await record(goalId, { observed_on: TODAY, value: 1 })).status).toBe(404);
    expect((await publish(planId, 1)).status).toBe(404);
    expect((await (await routes()).plans.GET(post("http://x", undefined, "GET"), ctx({ id: caseA }))).status).toBe(404);

    const { listSharedForCase, openSharedItem } = await import("@/lib/sharing/shared");
    const kaseB = { id: caseB, org_id: orgB, child_id: childA };
    expect(await listSharedForCase(providerB.id, kaseB)).toEqual([]);

    as(guardianA);
    const { POST: share } = await import("@/app/api/family/children/[id]/sharing-grants/route");
    const granted = await share(post("http://x", { source_org_id: orgA, grantee_org_id: orgB, scopes: ["iep"] }), ctx({ id: childA }));
    expect(granted.status).toBe(201);

    const sources = await listSharedForCase(providerB.id, kaseB);
    const iep = sources[0].scopes.find((s) => s.scope === "iep")!;
    expect(iep.available).toBe(true);
    expect(iep.items.map((i) => i.id).sort()).toEqual(
      (await sql<{ id: string }[]>`select distinct entity_id as id from published_versions where entity_type = 'iep_plan' and case_id = ${caseA}`)
        .map((r) => r.id)
        .sort(),
    );
    const opened = await openSharedItem(providerB.id, kaseB, "iep", planId);
    expect(opened?.item.body.kind).toBe("markdown");
    const md = opened?.item.body.kind === "markdown" ? opened.item.body.markdown : "";
    expect(md).toContain(STATEMENT_V2);
    expect(md).toContain("## Progress");
    expect(md).toContain("| Date | Value |");
    expect(md).not.toContain("Needed a model prompt");
    expect(await openSharedItem(providerB.id, kaseB, "iep", randomUUID())).toBeNull();

    // Read only: the grant never opens the provider APIs.
    as(providerB);
    expect((await patchPlan(planId, { title: "x", version: await versionOf(planId) })).status).toBe(404);
    expect((await getPlan(planId)).status).toBe(404);
  });

  it("E-4.2 / E-4.3: other guardians, unassigned members, guardians on provider APIs, anonymous", async () => {
    as(guardianB);
    expect((await familyPlan()).status).toBe(404);
    as(memberA);
    expect((await getPlan(planId)).status).toBe(404);
    expect((await record(goalId, { observed_on: TODAY, value: 1 })).status).toBe(404);
    as(guardianA);
    expect((await getPlan(planId)).status).toBe(403);
    expect((await createPlan({ title: "x", start_date: TODAY, review_date: shift(TODAY, 30) })).status).toBe(403);
    expect((await patchGoal(goalId, { status: "achieved", version: 1 })).status).toBe(403);
    expect((await record(goalId, { observed_on: TODAY, value: 1 })).status).toBe(403);
    as(providerA);
    expect((await familyPlan()).status).toBe(403);
    as(null);
    expect((await getPlan(planId)).status).toBe(401);
    expect((await familyPlan()).status).toBe(401);
    as(providerA);
    expect((await getPlan("not-a-uuid")).status).toBe(404);
    expect((await patchGoal(randomUUID(), { status: "achieved", version: 1 })).status).toBe(404);
  });

  it("a guardian with no published plan gets the empty list; a revoked link ends access", async () => {
    const other = await world.kase(orgA);
    await world.link(other.childId, guardianA);
    as(guardianA);
    expect(await (await familyPlan(other.childId)).json()).toEqual({ plans: [] });
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childA} and user_id = ${guardianA.id}`;
    try {
      expect((await familyPlan()).status).toBe(404);
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${childA} and user_id = ${guardianA.id}`;
    }
  });

  it("038 hook: confirmed AI suggestions record source and a recording of the same case only", async () => {
    const { recordProgress } = await import("@/lib/iep");
    const [active] = await sql<{ id: string }[]>`select id from iep_plans where case_id = ${caseA} and status = 'active'`;
    as(ownerA);
    const added = await addGoal(active.id, goalBody(await versionOf(active.id), { domain: "self_care", statement: "Asha will wash hands with one visual prompt", measure_type: "rating_1_5", baseline_value: 2, target_value: 4 }));
    const newGoal = (await added.json()).goal.id as string;
    const [rec] = await sql<{ id: string }[]>`select id from recordings where case_id = ${caseA}`;
    const [foreign] = await sql<{ id: string }[]>`select id from recordings where case_id = ${caseB}`;
    const ok = await recordProgress({ goalId: newGoal, actorUserId: ownerA.id, observedOn: TODAY, value: 3, source: "ai_suggested_confirmed", recordingId: rec.id });
    expect(ok).toMatchObject({ ok: true, entry: { source: "ai_suggested_confirmed", recording_id: rec.id, value: 3 } });
    expect(await recordProgress({ goalId: newGoal, actorUserId: ownerA.id, observedOn: TODAY, value: 3, recordingId: foreign.id })).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(await recordProgress({ goalId: newGoal, actorUserId: ownerA.id, observedOn: TODAY, value: 6 })).toMatchObject({ ok: false, status: 400 });
    await expect(sql`insert into goal_progress (goal_id, observed_on, value) values (${newGoal}, ${TODAY}, 9)`).rejects.toThrow(/out of range/);
  });

  it("RLS: the care team reads plans, goals and progress; guardians and other orgs read nothing; no client writes", async () => {
    const read = (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [{ p }] = await tx<{ p: number }[]>`select count(*)::int as p from iep_plans where id = ${planId}`;
        const [{ g }] = await tx<{ g: number }[]>`select count(*)::int as g from iep_goals where id = ${goalId}`;
        const [{ e }] = await tx<{ e: number }[]>`select count(*)::int as e from goal_progress where goal_id = ${goalId}`;
        return [p, g, Math.min(e, 1)];
      });
    expect(await read(providerA.id)).toEqual([1, 1, 1]);
    expect(await read(ownerA.id)).toEqual([1, 1, 1]);
    expect(await read(guardianA.id)).toEqual([0, 0, 0]);
    expect(await read(providerB.id)).toEqual([0, 0, 0]);
    expect(await read(memberA.id)).toEqual([0, 0, 0]);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: providerA.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`update iep_plans set title = 'x' where id = ${planId}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
