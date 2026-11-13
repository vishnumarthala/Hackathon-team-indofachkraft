// Ticket 040 FR-1 / NFR-1 (design rule 9): the follow-up agent's context is authorisation-first and contains only
// guardian-authorised published versions. Database checks with real producers (025 publishPlan, 026 publishProgram,
// 039 signPrescription / voidPrescription, 024's report trigger, 038-style shared notes): IEP v1 text in, the
// unpublished v2 edit out, no draft report, no hidden report or note, no voided prescription, no transcript, nothing
// of guardian_b's child; a revoked link -> null and 404. Then the eval's acceptance checks through the real route
// handlers: E-1 grounded answers with citations (DEMO fixture), E-2 safety, E-3 consent and authz, E-4 the voice
// tool (valid session -> same answer; expired / foreign / no secret -> 401).
// Synthetic users/orgs/cases via tests/helpers/world.ts; everything is removed afterwards.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { citationHref, MEDICINE_ANSWER, NOT_FOUND_ANSWER, type FollowupCitation } from "@/lib/followup/constants";
import { buildFollowupContext, citationExcerpt, MAX_CONTEXT_CHARS, type ContextDoc } from "@/lib/followup/context";
import { todayInIndia } from "@/lib/iep/schema";
import { URGENT_MESSAGE } from "@/lib/screen/questions";
import { purgeTestAudit } from "./helpers/audit";
import { closeOpenVoiceCalls, stubGenerousVoiceLimits } from "./helpers/voice";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const doc = (over: Partial<ContextDoc>): ContextDoc => ({
  kind: "home",
  entity_type: "home_program",
  entity_id: randomUUID(),
  version: 1,
  label: "Home program: Practice (v1)",
  org_name: "Synthetic Centre",
  published_at: "2026-11-10T10:00:00.000Z",
  content: "# Home program\n\n- Snack-time requesting: 5 times a week",
  ...over,
});

describe("buildFollowupContext (FR-1, pure)", () => {
  it("numbers documents per kind, newest first, and never exceeds 60,000 characters", () => {
    const docs = [
      doc({ kind: "plan", entity_type: "iep_plan", published_at: "2026-11-01T00:00:00Z", content: "PLAN-OLD" }),
      doc({ published_at: "2026-11-12T00:00:00Z", content: "HOME-NEW" }),
      doc({ kind: "plan", entity_type: "iep_plan", published_at: "2026-11-11T00:00:00Z", content: "PLAN-NEW" }),
    ];
    const ctx1 = buildFollowupContext(docs);
    expect([...ctx1.citable.keys()]).toEqual(["HOME1", "PLAN1", "PLAN2"]);
    expect(ctx1.text.indexOf("HOME-NEW")).toBeLessThan(ctx1.text.indexOf("PLAN-NEW"));
    expect(ctx1.text.indexOf("PLAN-NEW")).toBeLessThan(ctx1.text.indexOf("PLAN-OLD"));
    expect(MAX_CONTEXT_CHARS).toBe(60_000);

    const big = Array.from({ length: 8 }, (_, i) =>
      doc({ published_at: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00Z`, content: `DOC${i} ${"x".repeat(15_000)}` }),
    );
    const cut = buildFollowupContext(big);
    expect(cut.text.length).toBeLessThanOrEqual(60_000);
    expect(cut.text).toContain("DOC7"); // newest kept
    expect(cut.text).not.toContain("DOC0"); // oldest left out
    expect(cut.citable.size).toBeLessThan(8);
    for (const [ref] of cut.citable) expect(cut.text).toContain(`[${ref}]`);
  });

  it("chip excerpts are verbatim from the cited document, never the model's invention", () => {
    const d = doc({ content: "# Home program\n\nHold up two snacks and wait 5 seconds." });
    expect(citationExcerpt(d, "wait 5 seconds")).toBe("wait 5 seconds");
    expect(citationExcerpt(d, "give extra medicine")).toBe("Hold up two snacks and wait 5 seconds.");
  });
});

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("@/lib/i18n/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/server")>();
  return { ...actual, getTimeZone: vi.fn(async () => "Asia/Kolkata") };
});
// The fixture reader is spied on so E-2 can show that a red flag makes no model call (DEMO_MODE "fixture access log").
const fixtureReads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("@/lib/demo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo")>();
  return {
    ...actual,
    loadFixture: ((rel: string, schema?: unknown) => {
      fixtureReads.paths.push(rel);
      return (actual.loadFixture as (r: string, s?: unknown) => unknown)(rel, schema);
    }) as typeof actual.loadFixture,
  };
});

const MARK = {
  planV1: "Uses two-word requests at snack time (PLANV1MARK)",
  planV2: "DRAFTV2MARK unpublished goal wording",
  home: "Snack-time requesting HOMEMARK",
  homeNote: "GUARDIANNOTEMARK private note",
  summary: "PARENTSUMMARYMARK Asha did well this month.",
  draftReport: "DRAFTREPORTMARK not final",
  hiddenReport: "# Report (synthetic)",
  note: "SHAREDNOTEMARK Practised turn-taking with bubbles.",
  hiddenNote: "HIDDENNOTEMARK not shared",
  rxDrug: "Synthetic-iron",
  voidDrug: "Voidedmark-syrup",
  other: "OTHERCHILDMARK plan of another child",
  transcript: "He lines up toys.",
};

describe.skipIf(!enabled)("follow-up context and routes (database)", () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let owner: TestUser;
  let guardianA: TestUser;
  let guardianB: TestUser;
  let guardianA2: TestUser;
  let caseA: string;
  let caseB: string;
  let childA: string;
  let childB: string;
  let linkA2: string;
  let planA: string;
  let programA: string;
  let rxSigned: string;
  let rxVoid: string;
  let profileId: string;

  const as = (u: TestUser | null) => {
    session.user = u ? { id: u.id, email: u.email } : null;
  };
  type Res = { status: number; body: Record<string, unknown> };
  const json = async (res: Response): Promise<Res> => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> });
  const routes = async () => ({
    ask: await import("@/app/api/family/children/[id]/ask/route"),
    session: await import("@/app/api/agents/followup/session/route"),
    tool: await import("@/app/api/agents/followup/tools/answer_question/route"),
    demo: await import("@/app/api/agents/followup/demo/answer_question/route"),
  });
  const ask = async (childId: string, question: string) =>
    json(await (await routes()).ask.POST(post(`http://x/api/family/children/${childId}/ask`, { question }), ctx({ id: childId })));
  const history = async (childId: string) => json(await (await routes()).ask.GET(post("http://x", undefined, "GET"), ctx({ id: childId })));
  // 051: one open voice call per user; the previous call of this guardian is closed first (as the page would).
  const startVoice = async (childId: string) => {
    if (session.user) await closeOpenVoiceCalls(sql, session.user.id);
    return json(await (await routes()).session.POST(post("http://x/api/agents/followup/session", { child_id: childId })));
  };
  const toolCall = (body: Record<string, unknown>, secret: string | null = "t040-secret") =>
    new Request("http://x/api/agents/followup/tools/answer_question", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "x-agent-secret": secret } : {}) },
      body: JSON.stringify(body),
    });

  async function publishedPlan(caseId: string, title: string, statement: string) {
    const iep = await import("@/lib/iep");
    const plan = await iep.createPlan({ caseId, actorUserId: owner.id, body: { title, start_date: todayInIndia(), review_date: "2027-03-31" } });
    if (!plan.ok) throw new Error(plan.error);
    const goal = await iep.addGoal({
      planId: plan.plan.id,
      actorUserId: owner.id,
      body: {
        domain: "communication",
        statement,
        specific: "Requests snacks",
        measurable: "Count per session",
        achievable: "Uses single words",
        relevant: "Less frustration",
        time_bound: "Within 3 months",
        measure_type: "count",
        baseline_value: 1,
        target_value: 5,
        target_date: "2027-02-28",
        version: 1,
      },
    });
    if (!goal.ok) throw new Error(goal.error);
    const published = await iep.publishPlan({ planId: plan.plan.id, actorUserId: owner.id, version: goal.plan_version });
    if (!published.ok) throw new Error(published.error);
    return { planId: plan.plan.id, version: goal.plan_version + 1 };
  }

  async function signedRx(drug: string) {
    const rx = await import("@/lib/rx");
    const created = await rx.createPrescription({ caseId: caseA, actorUserId: owner.id, profileId });
    if (!created.ok) throw new Error(created.error);
    const [{ version }] = await sql<{ version: number }[]>`select version from prescriptions where id = ${created.id}`;
    const item = { drug, strength: "20 mg/ml", form: "drops", dose: "1 ml", frequency: "once a day", duration_days: 30, route: "oral", instructions: "After breakfast" };
    const edited = await rx.updateDraft({ prescriptionId: created.id, actorUserId: owner.id, body: { items: [item], advice: null, follow_up: null, version } as never });
    if (!edited.ok) throw new Error(edited.error);
    const signed = await rx.signPrescription({ prescriptionId: created.id, actorUserId: owner.id, allergyOverrideReason: null });
    if (!signed.ok) throw new Error(signed.error);
    return created.id;
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", "t040-secret");
    stubGenerousVoiceLimits();
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t040");
    owner = await world.user("paed", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianA2 = await world.user("guardian-a2", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    const orgA = await world.org(owner, "Centre A");
    const orgB = await world.org(owner, "Centre B");
    const [p] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, qualifications, registration_council,
                                     registration_number, verification_status, verified_at, claimed, is_synthetic, created_by)
      values (${owner.id}, ${`t040-paed-${owner.id.slice(0, 8)}`}, 'Dr Synthetic Follow-up', 'pediatrician', 'MBBS, MD (synthetic)',
              'NMC', 'SYN-0040', 'verified', now(), true, true, ${owner.id})
      returning id`;
    profileId = p.id;

    const a = await world.kase(orgA);
    caseA = a.caseId;
    childA = a.childId;
    await sql`update children set display_name = 'Asha Synthetic', date_of_birth = '2022-07-10' where id = ${childA}`;
    const linkA = await world.link(childA, guardianA);
    linkA2 = await world.link(childA, guardianA2, "father");
    await world.grant(childA, guardianA, linkA, ["ai_follow_up"]);
    const b = await world.kase(orgB);
    caseB = b.caseId;
    childB = b.childId;
    await world.link(childB, guardianB);

    // 025: IEP v1 published, then an unpublished edit (v2 draft wording).
    const plan = await publishedPlan(caseA, "Term 1 plan", MARK.planV1);
    planA = plan.planId;
    const iep = await import("@/lib/iep");
    const [{ version: planVersion }] = await sql<{ version: number }[]>`select version from iep_plans where id = ${planA}`;
    const edit = await iep.addGoal({
      planId: planA,
      actorUserId: owner.id,
      body: {
        domain: "social",
        statement: MARK.planV2,
        specific: "Takes turns in play",
        measurable: "Turns per session",
        achievable: "Takes one turn today",
        relevant: "Plays with cousins",
        time_bound: "Within 3 months",
        measure_type: "count",
        baseline_value: 0,
        target_value: 3,
        target_date: "2027-02-28",
        version: planVersion,
      },
    });
    if (!edit.ok) throw new Error(edit.error);
    await publishedPlan(caseB, "Other child plan", MARK.other);

    // 026: a published home program with one activity, and a guardian practice log with a private note.
    const hp = await import("@/lib/home-program");
    const program = await hp.createProgram({ caseId: caseA, actorUserId: owner.id, body: { title: "Home practice" } });
    if (!program.ok) throw new Error(program.error);
    programA = program.program.id;
    const act = await hp.addActivity({
      programId: programA,
      actorUserId: owner.id,
      body: { title: MARK.home, instructions_md: "Hold up two snacks and wait 5 seconds.", frequency_per_week: 5, duration_min: 10, materials: null, goal_id: null, document_id: null },
    });
    if (!act.ok) throw new Error(act.error);
    const pub = await hp.publishProgram({ programId: programA, actorUserId: owner.id, version: act.program_version });
    if (!pub.ok) throw new Error(pub.error);
    const saved = await hp.saveLog({ activityId: act.activity.id, userId: guardianA.id, body: { done_on: todayInIndia(), difficulty: "okay", duration_min: 10, note: MARK.homeNote } });
    expect(saved).toBeTruthy();

    // Reports are unique per (recording, kind): one synthetic recording each.
    let sessionNumber = 1;
    const recording = async () => {
      sessionNumber += 1;
      const [r] = await sql<{ id: string }[]>`
        insert into recordings (case_id, kind, session_number, status, mime_type, segments)
        values (${caseA}, 'session', ${sessionNumber}, 'transcribed', 'audio/wav', '[]'::jsonb) returning id`;
      return r.id;
    };
    // 024: a draft report (never published) and a finalized parent summary (published, visible to the guardian).
    await sql`insert into reports (case_id, recording_id, kind, content, content_md, status)
              values (${caseA}, ${await recording()}, 'parent_summary', '{}'::jsonb, ${MARK.draftReport}, 'draft')`;
    await sql`insert into reports (case_id, recording_id, kind, content, content_md, status)
              values (${caseA}, ${await recording()}, 'parent_summary', '{}'::jsonb, ${MARK.summary}, 'final')`;
    // 038: one shared and one not-shared session note (published by finalizeSessionNote in the app).
    const { publishVersion } = await import("@/lib/clinical/publish");
    for (const [text, visible] of [[MARK.note, true], [MARK.hiddenNote, false]] as const) {
      const [r] = await sql<{ id: string }[]>`
        insert into reports (case_id, recording_id, kind, content, content_md, status)
        values (${caseA}, ${await recording()}, 'session_note', '{}'::jsonb, ${text}, 'final') returning id`;
      await publishVersion(sql, { entityType: "report", entityId: r.id, caseId: caseA, contentMd: text, visibleToGuardian: visible, publishedBy: owner.id });
    }

    // 039: a signed prescription and a voided one.
    rxSigned = await signedRx(MARK.rxDrug);
    rxVoid = await signedRx(MARK.voidDrug);
    const rx = await import("@/lib/rx");
    const voided = await rx.voidPrescription({ prescriptionId: rxVoid, actorUserId: owner.id, reason: "Entered for the wrong day (synthetic)" });
    if (!voided.ok) throw new Error(voided.error);
  }, 60_000);

  afterAll(async () => {
    as(null);
    vi.unstubAllEnvs();
    if (sql && caseA) {
      const rows = await sql<{ path: string }[]>`
        select v.pdf_path as path from prescription_versions v join prescriptions p on p.id = v.prescription_id
        where p.case_id = ${caseA} and v.pdf_path is not null`;
      if (rows.length) await db.storage.from("prescriptions").remove(rows.map((r) => r.path));
      await sql`delete from followup_questions where child_id in ${sql([childA, childB])}`;
      await sql`delete from followup_agent_sessions where child_id in ${sql([childA, childB])}`;
      await sql`delete from home_activity_logs where child_id = ${childA}`;
      await sql`delete from outbox_events where payload ->> 'child_id' in ${sql([childA, childB])}`;
      await sql`delete from outbox_events where aggregate_type in ('home_program', 'iep_plan') and payload ->> 'case_id' in ${sql([caseA, caseB])}`;
      await sql`delete from cases where id in ${sql([caseA, caseB])}`;
      await sql`delete from provider_profiles where id = ${profileId}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action like 'followup.%' and child_id in ${tx([childA, childB])}`);
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("NFR-1: the context has IEP v1 but not the v2 draft, no draft/hidden report or note, no voided Rx, no transcript, nothing of another child", async () => {
    const { loadGuardianContext } = await import("@/lib/followup/context");
    const context = await loadGuardianContext(guardianA.id, childA, { timeZone: "Asia/Kolkata" });
    expect(context).not.toBeNull();
    const text = context!.text;
    for (const m of [MARK.planV1, MARK.home, MARK.summary, MARK.note, MARK.rxDrug]) expect(text, m).toContain(m);
    for (const m of [MARK.planV2, MARK.draftReport, MARK.hiddenReport, MARK.hiddenNote, MARK.voidDrug, "Prescription cancelled", MARK.other, MARK.transcript, MARK.homeNote]) {
      expect(text, m).not.toContain(m);
    }
    // This week's adherence (logged by the family) comes with the home program.
    expect(text).toMatch(/done 1 of 5 times this week/);
    const types = context!.docs.map((d) => `${d.entity_type}:${d.entity_id}`);
    expect(types).toContain(`iep_plan:${planA}`);
    expect(types).toContain(`home_program:${programA}`);
    expect(types).toContain(`prescription:${rxSigned}`);
    expect(types).not.toContain(`prescription:${rxVoid}`);
    expect(context!.docs.find((d) => d.entity_id === planA)?.version).toBe(1);
    // Newest first.
    const times = context!.docs.map((d) => d.published_at);
    expect([...times].sort().reverse()).toEqual(times);

    // Nothing for guardian_b (not linked to child A) and nothing of child A for guardian_b's own child.
    expect(await loadGuardianContext(guardianB.id, childA)).toBeNull();
    const other = await loadGuardianContext(guardianB.id, childB);
    expect(other!.text).toContain(MARK.other);
    expect(other!.text).not.toContain(MARK.planV1);
  });

  it("E-1: `What should we practise this week?` cites the home program at its version; the chip opens that version", async () => {
    as(guardianA);
    fixtureReads.paths = [];
    const res = await ask(childA, "What should we practise this week?");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ found: true });
    const citations = res.body.citations as FollowupCitation[];
    expect(citations[0]).toMatchObject({ entity_type: "home_program", entity_id: programA, version: 1 });
    expect(citations[0].label).toMatch(/^Home program: Home practice \(v1\)$/);
    expect(citations[0].excerpt.length).toBeGreaterThan(0);
    expect(citationHref(childA, citations[0])).toBe(`/family/children/${childA}/ask/sources/home_program/${programA}/1`);
    expect(fixtureReads.paths).toEqual(["gemini/follow-up.json"]);

    // Something absent -> the not-found text (the UI adds the Messages link).
    const absent = await ask(childA, "What time does the school bus come?");
    expect(absent).toMatchObject({ status: 200, body: { found: false, answer: NOT_FOUND_ANSWER, citations: [] } });

    // FR-6: history is the asking guardian's own (a second guardian of the same child sees none of it).
    const mine = await history(childA);
    expect((mine.body.questions as { question: string }[]).map((q) => q.question)).toEqual([
      "What time does the school bus come?",
      "What should we practise this week?",
    ]);
    expect(mine.body.remaining_today).toBe(28);
    as(guardianA2);
    expect(((await history(childA)).body.questions as unknown[]).length).toBe(0);
  });

  it("E-2: dose change -> fixed medicine message; `not breathing properly` -> 108/112 with no model call, audited without text", async () => {
    as(guardianA);
    expect(await ask(childA, "Can I double the syrup dose?")).toMatchObject({ status: 200, body: { safety: "medical_advice", answer: MEDICINE_ANSWER } });
    fixtureReads.paths = [];
    const urgent = await ask(childA, "My child is not breathing properly");
    expect(urgent).toMatchObject({ status: 200, body: { safety: "red_flag", answer: URGENT_MESSAGE, citations: [] } });
    expect(fixtureReads.paths).toEqual([]);
    const rows = await sql<{ details: Record<string, unknown> }[]>`
      select details from audit_events where action = 'followup.red_flag' and child_id = ${childA}`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].details)).not.toMatch(/breathing properly/);
  });

  it("E-3: without ai_follow_up -> 422; guardian_b on child A -> 404; a provider -> 403; anonymous -> 401", async () => {
    as(guardianB);
    expect(await ask(childB, "What should we practise this week?")).toMatchObject({ status: 422, body: { details: { feature: "ai_follow_up" } } });
    expect((await startVoice(childB)).status).toBe(422);
    expect((await ask(childA, "What should we practise this week?")).status).toBe(404);
    expect((await history(childA)).status).toBe(404);
    expect((await startVoice(childA)).status).toBe(404);
    as(owner);
    expect((await ask(childA, "What should we practise this week?")).status).toBe(403);
    as(null);
    expect((await ask(childA, "What should we practise this week?")).status).toBe(401);
    as(guardianA);
    expect((await ask(childA, "hi")).status).toBe(400);
  });

  it("E-4: the agent's tool with a valid session gives the same answer; expired, foreign, ended or unsigned -> 401", async () => {
    as(guardianA);
    const started = await startVoice(childA);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ demo: true, conversation_token: null, max_seconds: 600 });
    // 051: the start is recorded against the guardian's `followup` voice quota.
    expect((await sql`select agent, status from voice_usage where id = ${started.body.voice_usage_id as string}`)[0]).toEqual({ agent: "followup", status: "started" });
    const token = started.body.followup_session as string;
    expect(started.body.dynamic_variables).toEqual({ followup_session: token });
    const stored = await sql`select token_hash from followup_agent_sessions where child_id = ${childA}`;
    expect(stored[0].token_hash).not.toContain(token);

    const r = await routes();
    const text = await ask(childA, "When is the next review?");
    const voice = await json(await r.tool.POST(toolCall({ followup_session: token, question: "When is the next review?" })));
    expect(voice.status).toBe(200);
    const strip = (b: Record<string, unknown>) => ({ found: b.found, answer: b.answer, citations: b.citations, safety: b.safety });
    expect(strip(voice.body)).toEqual(strip(text.body));
    expect((voice.body.citations as { entity_type: string }[])[0].entity_type).toBe("iep_plan");
    const [row] = await sql`select channel from followup_questions where id = ${voice.body.id as string}`;
    expect(row.channel).toBe("voice");

    // No or wrong secret -> 401; unknown token -> 401.
    expect((await r.tool.POST(toolCall({ followup_session: token, question: "When is the next review?" }, null))).status).toBe(401);
    expect((await r.tool.POST(toolCall({ followup_session: token, question: "When is the next review?" }, "wrong"))).status).toBe(401);
    expect((await r.tool.POST(toolCall({ followup_session: "x".repeat(43), question: "When is the next review?" }))).status).toBe(401);

    // DEMO route: the owner may use it; another guardian (foreign session) gets 401.
    as(guardianB);
    expect((await r.demo.POST(post("http://x", { followup_session: token, question: "When is the next review?" }))).status).toBe(401);
    as(guardianA);
    expect((await r.demo.POST(post("http://x", { followup_session: token, question: "When is the next review?" }))).status).toBe(200);

    // Expired -> 401.
    await sql`update followup_agent_sessions set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' where child_id = ${childA}`;
    expect((await r.tool.POST(toolCall({ followup_session: token, question: "When is the next review?" }))).status).toBe(401);

    // A red flag by voice ends the session: the next call is 401.
    const next = await startVoice(childA);
    const t2 = next.body.followup_session as string;
    expect(await json(await r.tool.POST(toolCall({ followup_session: t2, question: "She is having a seizure" })))).toMatchObject({ status: 200, body: { safety: "red_flag" } });
    expect((await r.tool.POST(toolCall({ followup_session: t2, question: "When is the next review?" }))).status).toBe(401);

    // Ending the session (with the conversation id for erasure) -> 401 afterwards.
    const third = await startVoice(childA);
    const t3 = third.body.followup_session as string;
    const ended = await json(await r.session.DELETE(post("http://x", { followup_session: t3, conversation_id: "conv_t040_synthetic" }, "DELETE")));
    expect(ended.status).toBe(200);
    expect((await r.tool.POST(toolCall({ followup_session: t3, question: "When is the next review?" }))).status).toBe(401);
    const { REGISTRY } = await import("@/lib/privacy/registry");
    const entry = REGISTRY.find((c) => c.key === "followup_questions")!;
    const refs = await entry.erase!.externalRefs!(sql, { childId: childA, requestId: randomUUID(), scope: "all_ai_processing", requestedBy: guardianA.id, caseIds: [caseA] });
    expect(refs).toEqual([{ processor: "elevenlabs", ref: "conv_t040_synthetic" }]);
    const exported = (await entry.export!({ sql, childId: childA, guardianUserId: guardianA.id }))!.data as { channel: string }[];
    expect(exported.length).toBeGreaterThanOrEqual(3);
    expect((await entry.export!({ sql, childId: childA, guardianUserId: guardianA2.id }))!.data).toEqual([]);
  });

  it("NFR-1: a revoked guardian link -> no context, 404 on the routes, and the voice session stops working", async () => {
    as(guardianA2);
    await sql`insert into followup_questions (child_id, guardian_user_id, question, answer) values (${childA}, ${guardianA2.id}, 'Synthetic question', 'Synthetic answer')`;
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${linkA2}`;
    const { loadGuardianContext } = await import("@/lib/followup/context");
    expect(await loadGuardianContext(guardianA2.id, childA)).toBeNull();
    expect((await ask(childA, "What should we practise this week?")).status).toBe(404);
    expect((await history(childA)).status).toBe(404);

    // A voice session started while linked dies with the link.
    as(guardianA);
    const started = await startVoice(childA);
    const token = started.body.followup_session as string;
    const [{ id: linkA }] = await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childA} and user_id = ${guardianA.id}`;
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${linkA}`;
    try {
      const r = await routes();
      expect((await r.tool.POST(toolCall({ followup_session: token, question: "When is the next review?" }))).status).toBe(401);
      expect((await ask(childA, "When is the next review?")).status).toBe(404);
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where id = ${linkA}`;
    }
  });

  it("FR-6: questions older than 90 days are removed by the retention step", async () => {
    const { purgeFollowupQuestions } = await import("@/lib/privacy/retention");
    await sql`update followup_questions set created_at = now() - interval '91 days' where child_id = ${childA} and question = 'Synthetic question'`;
    const before = await sql`select id from followup_questions where child_id = ${childA}`;
    const removed = await purgeFollowupQuestions(sql, new Date());
    expect(removed).toBeGreaterThanOrEqual(1);
    const after = await sql`select id from followup_questions where child_id = ${childA}`;
    expect(after.length).toBe(before.length - 1);
  });
});
