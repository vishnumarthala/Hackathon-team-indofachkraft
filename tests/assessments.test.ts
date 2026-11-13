// Ticket 024 Part 2 (FR-7..FR-10, NFR-2, NFR-3): the assessment portal. Pure checks of validation, error
// mapping, the published summary and the guardian form; database checks (local Supabase, DATABASE_URL) that
// drive the real route handlers for E-2 (assign, save and continue later, submit), E-3 (red flag), E-4
// (concurrency and authz negatives), the `assessments` share loader and RLS. Synthetic data only; everything is
// removed afterwards.
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckinForm, saveAnswers, submitAnswers, type FormItem } from "@/components/assessments/CheckinForm";
import { assessmentErrorKey } from "@/components/assessments/view";
import { MSG, PARENT_CHECKIN_TEMPLATE_ID, ResponsesSchema, makeAssignSchema, todayInIndia } from "@/lib/assessments/schemas";
import { assessmentSummaryMarkdown } from "@/lib/assessments/summary";
import { CHECKIN, CHECKIN_ITEM_IDS, scoreCheckin } from "@/lib/clinical/checkin";
import { getInstrument } from "@/lib/clinical/instruments";
import { withI18n } from "./helpers/i18n";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const notify = vi.hoisted(() => ({ calls: [] as [string, Record<string, unknown>][] }));
vi.mock("@/lib/notify/topics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/topics")>();
  return {
    ...actual,
    notifyLater: vi.fn(async (topic: string, payload: Record<string, unknown>) => void notify.calls.push([topic, payload])),
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const QUESTION_IDS = CHECKIN.questions.map((q) => q.id);
const allAnswers = (overrides: Record<string, string> = {}) => ({
  ...Object.fromEntries(QUESTION_IDS.map((id) => [id, "sometimes"])),
  ...Object.fromEntries(CHECKIN.red_flags.map((r) => [r.id, "no"])),
  ...overrides,
});
const asList = (answers: Record<string, string>) => Object.entries(answers).map(([item_id, value]) => ({ item_id, value }));

describe("request validation (FR-8, FR-9)", () => {
  const now = new Date("2026-11-13T10:00:00+05:30");
  const base = { template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: randomUUID() };

  it("due date: optional, not in the past (India), within a year", () => {
    const schema = makeAssignSchema(now);
    expect(schema.parse(base).due_on).toBeNull();
    expect(schema.parse({ ...base, due_on: "2026-11-13" }).due_on).toBe("2026-11-13");
    expect(schema.parse({ ...base, due_on: "2026-11-20" }).due_on).toBe("2026-11-20");
    expect(schema.safeParse({ ...base, due_on: "2026-11-12" }).success).toBe(false);
    expect(schema.safeParse({ ...base, due_on: "2028-01-01" }).success).toBe(false);
    expect(schema.safeParse({ ...base, due_on: "13/11/2026" }).success).toBe(false);
    expect(schema.safeParse({ ...base, template_id: "x" }).success).toBe(false);
    expect(schema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(todayInIndia(new Date("2026-11-12T20:00:00Z"))).toBe("2026-11-13");
  });

  it("responses need a version", () => {
    expect(ResponsesSchema.safeParse({ answers: [] }).success).toBe(false);
    expect(ResponsesSchema.safeParse({ answers: [{ item_id: "q1", value: "never" }], version: 1 }).success).toBe(true);
  });

  it("maps API errors to translated message keys", () => {
    expect(assessmentErrorKey(MSG.notLinked)).toBe("notLinked");
    expect(assessmentErrorKey(MSG.stale)).toBe("stale");
    expect(assessmentErrorKey(MSG.answerAll)).toBe("answerAll");
    expect(assessmentErrorKey("Something else")).toBe("saveFailed");
  });
});

describe("published summary (FR-8)", () => {
  it("states the band copy and disclaimer, lists red-flag questions answered yes, never the reviewer note", () => {
    const answers = allAnswers({ rf_skill_regression: "yes" });
    const md = assessmentSummaryMarkdown({
      title: "Parent developmental check-in",
      instrumentKey: "ISAA_PARENT_CHECKIN",
      submittedAt: "2026-11-13T05:00:00Z",
      reviewedAt: "2026-11-14T05:00:00Z",
      score: scoreCheckin(answers),
      answers,
    });
    expect(md).toContain("# Parent developmental check-in");
    expect(md).toContain("13 November 2026");
    expect(md).toContain(CHECKIN.result_copy.see_professional_soon);
    expect(md).toContain("This is a developmental check-in, not a diagnosis.");
    expect(md).toContain(CHECKIN.red_flags[0].text_en);
    expect(md).toContain("108 (ambulance) or 112");
    expect(md.match(/not a diagnosis/g)).toHaveLength(1);
  });
});

describe("guardian form (FR-9, NFR-3)", () => {
  const items: FormItem[] = getInstrument("ISAA_PARENT_CHECKIN").items.map((i) => ({
    id: i.id,
    text: i.text,
    options: i.scale.type === "choice" ? i.scale.options.map((o) => o.value) : [],
    redFlag: Boolean(i.red_flag),
  }));
  const html = (answers: Record<string, string>, locale: "en" | "te" = "en") =>
    renderToStaticMarkup(withI18n(createElement(CheckinForm, { assessmentId: "A", items, initialAnswers: answers, initialVersion: 3 }), locale));

  it("shows one question per screen, starting at the first unanswered one, question text in English", () => {
    const out = html({ q1: "never", q2: "often" });
    expect(out.match(/<fieldset/g)).toHaveLength(1);
    expect(out).toContain(`data-item="q3"`);
    expect(out).toContain(`lang="en"`);
    expect(out).toContain("Question 3 of 21");
    expect(out).toContain("Save and continue later");
    expect(out).not.toContain("Please contact your child");
  });

  it("a red-flag yes shows the 108/112 advice at once; chrome is translated", () => {
    expect(html({ rf_self_injury: "yes" })).toContain("Please contact your child&#x27;s doctor now. In an emergency call 108 (ambulance) or 112.");
    const te = html({ rf_self_injury: "yes" }, "te");
    expect(te).toContain("108 (అంబులెన్స్) లేదా 112");
    expect(te).toContain("సేవ్ చేసి తర్వాత కొనసాగించండి");
  });

  it("client helpers send the version and map 409/422", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const reply = (status: number, body: unknown) =>
      (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    expect(await saveAnswers(reply(200, { version: 4 }), "A", { q1: "never" }, 3)).toEqual({ ok: true, version: 4 });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ answers: [{ item_id: "q1", value: "never" }], version: 3 });
    expect(calls[0].init?.method).toBe("PUT");
    expect(await saveAnswers(reply(409, { error: MSG.stale }), "A", {}, 3)).toEqual({ ok: false, error: "stale" });
    expect(await submitAnswers(reply(422, { error: MSG.answerAll, details: { missing: ["q2"] } }), "A")).toEqual({
      ok: false,
      error: "answerAll",
      missing: ["q2"],
    });
  });
});

describe.skipIf(!enabled)("assessment portal (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let ownerA: TestUser, memberA: TestUser, providerB: TestUser, guardianA: TestUser, guardianB: TestUser;
  let orgA: string, orgB: string;
  let caseA: string, childA: string, linkA: string;
  let assessmentId: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    list: await import("@/app/api/cases/[id]/assessments/route"),
    one: await import("@/app/api/assessments/[id]/route"),
    review: await import("@/app/api/assessments/[id]/review/route"),
    cancel: await import("@/app/api/assessments/[id]/cancel/route"),
    responses: await import("@/app/api/family/assessments/[id]/responses/route"),
    submit: await import("@/app/api/family/assessments/[id]/submit/route"),
  });

  async function assign(body: Record<string, unknown>, caseId = caseA) {
    const r = await routes();
    return r.list.POST(post(`http://x/api/cases/${caseId}/assessments`, body), ctx({ id: caseId }));
  }
  async function save(id: string, answers: Record<string, string>, version: number) {
    const r = await routes();
    return r.responses.PUT(post("http://x", { answers: asList(answers), version }, "PUT"), ctx({ id }));
  }
  async function submit(id: string) {
    const r = await routes();
    return r.submit.POST(post("http://x"), ctx({ id }));
  }
  async function review(id: string, body: Record<string, unknown>) {
    const r = await routes();
    return r.review.POST(post("http://x", body), ctx({ id }));
  }
  const versionOf = async (id: string) => (await sql<{ version: number }[]>`select version from assessments where id = ${id}`)[0].version;
  const auditActions = async (id: string) =>
    (await sql<{ action: string }[]>`select action from audit_events where entity = 'assessment' and entity_id = ${id} order by id`).map((r) => r.action);

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t024a");
    ownerA = await world.user("ownera", "provider");
    memberA = await world.user("membera", "provider");
    providerB = await world.user("providerb", "provider");
    guardianA = await world.user("guardiana", "guardian");
    guardianB = await world.user("guardianb", "guardian");
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
    await world.member(orgA, memberA); // unassigned member: no case access (022)
    const kase = await world.kase(orgA);
    caseA = kase.caseId;
    childA = kase.childId;
    linkA = await world.link(childA, guardianA);
    const other = await world.kase(orgB);
    await world.link(other.childId, guardianB); // guardian B has a child, but not this one
  });

  afterAll(async () => {
    as(null);
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => {
    notify.calls.length = 0;
  });

  it("E-2.1: provider sends `Parent developmental check-in` to guardian_a, due in 7 days", async () => {
    as(ownerA);
    const due = new Date(Date.parse(`${todayInIndia()}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const res = await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id, due_on: due });
    expect(res.status).toBe(201);
    const { assessment } = await res.json();
    assessmentId = assessment.id;
    expect(assessment).toMatchObject({
      case_id: caseA,
      child_id: childA,
      org_id: orgA,
      status: "assigned",
      due_on: due,
      version: 1,
      title: "Parent developmental check-in",
      instrument_key: "ISAA_PARENT_CHECKIN",
    });
    expect(await auditActions(assessmentId)).toEqual(["assessment.assigned"]);
    expect(notify.calls).toEqual([["assessment.assigned", { assessment_id: assessmentId, case_id: caseA, assigned_to: guardianA.id }]]);

    const r = await routes();
    const list = await (await r.list.GET(post("http://x"), ctx({ id: caseA }))).json();
    expect(list.assessments.map((a: { id: string }) => a.id)).toEqual([assessmentId]);
  });

  it("E-4.3: not linked guardian -> 422; duplicate open questionnaire -> 409; other org / unassigned member -> 404; guardian -> 403", async () => {
    as(ownerA);
    const notLinked = await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianB.id });
    expect(notLinked.status).toBe(422);
    expect(await notLinked.json()).toEqual({ error: "This parent is not linked to the child" });
    expect((await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: providerB.id })).status).toBe(422);
    expect((await assign({ template_id: randomUUID(), assigned_to: guardianA.id })).status).toBe(422);
    const dup = await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id });
    expect(dup.status).toBe(409);
    expect((await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id, due_on: "2020-01-01" })).status).toBe(400);
    as(providerB);
    expect((await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id })).status).toBe(404);
    as(memberA);
    expect((await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id })).status).toBe(404);
    as(guardianA);
    expect((await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id })).status).toBe(403);
    as(null);
    expect((await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id })).status).toBe(401);
  });

  it("E-2.2: answer 5, save and continue later, reload keeps them; submit with missing -> 422 listing them", async () => {
    as(guardianA);
    const five = Object.fromEntries(QUESTION_IDS.slice(0, 5).map((id) => [id, "often"]));
    const res = await save(assessmentId, five, 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2, status: "in_progress", red_flags: [] });

    const { getGuardianAssessment, listGuardianAssessments } = await import("@/lib/assessments");
    const reloaded = await getGuardianAssessment(assessmentId, guardianA.id);
    expect(reloaded?.answers).toEqual(five);
    expect(reloaded?.assessment).toMatchObject({ status: "in_progress", version: 2, child_name: expect.any(String) });
    expect((await listGuardianAssessments(guardianA.id)).map((a) => a.id)).toEqual([assessmentId]);

    const missing = await submit(assessmentId);
    expect(missing.status).toBe(422);
    const body = await missing.json();
    expect(body.error).toBe("Please answer all questions");
    expect(body.details.missing).toEqual(CHECKIN_ITEM_IDS.slice(5));
    expect(await versionOf(assessmentId)).toBe(2);
  });

  it("E-4.1: two tabs save with the same version -> the second gets 409", async () => {
    as(guardianA);
    expect((await save(assessmentId, { q6: "never" }, 2)).status).toBe(200);
    const stale = await save(assessmentId, { q6: "always" }, 2);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe(MSG.stale);
    const [{ value }] = await sql<{ value: string }[]>`select value from assessment_responses where assessment_id = ${assessmentId} and item_id = 'q6'`;
    expect(value).toBe("never");
  });

  it("rejects unknown items and invalid values (400) without saving", async () => {
    as(guardianA);
    const version = await versionOf(assessmentId);
    expect((await save(assessmentId, { q99: "never" }, version)).status).toBe(400);
    expect((await save(assessmentId, { q1: "maybe" }, version)).status).toBe(400);
    expect((await save(assessmentId, { rf_seizure: "often" }, version)).status).toBe(400);
    expect(await versionOf(assessmentId)).toBe(version);
  });

  it("E-3: a red-flag yes is saved at once, notifies the care team once, audits, and the provider sees it", async () => {
    as(guardianA);
    let version = await versionOf(assessmentId);
    const res = await save(assessmentId, { rf_skill_regression: "yes" }, version);
    expect(res.status).toBe(200);
    expect((await res.json()).red_flags).toEqual(["skill_regression"]);
    expect(notify.calls).toEqual([["assessment.red_flag", { assessment_id: assessmentId, case_id: caseA, codes: "skill_regression" }]]);
    expect(await auditActions(assessmentId)).toContain("assessment.red_flag");

    notify.calls.length = 0;
    version = await versionOf(assessmentId);
    expect((await save(assessmentId, { rf_skill_regression: "yes", q7: "never" }, version)).status).toBe(200);
    expect(notify.calls).toEqual([]);

    as(ownerA);
    const { listCaseAssessments } = await import("@/lib/assessments");
    expect((await listCaseAssessments(caseA))[0].red_flag_count).toBe(1);
    const r = await routes();
    const detail = await (await r.one.GET(post("http://x"), ctx({ id: assessmentId }))).json();
    expect(detail.red_flags).toEqual(["skill_regression"]);
    expect(detail.answers.rf_skill_regression).toBe("yes");
  });

  it("E-4.2: other guardian and other org -> 404; guardians on provider APIs -> 403; providers on family APIs -> 403", async () => {
    const r = await routes();
    as(guardianB);
    expect((await save(assessmentId, { q1: "never" }, await versionOf(assessmentId))).status).toBe(404);
    expect((await submit(assessmentId)).status).toBe(404);
    const { getGuardianAssessment } = await import("@/lib/assessments");
    expect(await getGuardianAssessment(assessmentId, guardianB.id)).toBeNull();
    as(providerB);
    expect((await r.one.GET(post("http://x"), ctx({ id: assessmentId }))).status).toBe(404);
    expect((await review(assessmentId, { share_with_parent: true })).status).toBe(404);
    expect((await r.cancel.POST(post("http://x"), ctx({ id: assessmentId }))).status).toBe(404);
    expect((await save(assessmentId, { q1: "never" }, 1)).status).toBe(403);
    as(memberA);
    expect((await r.one.GET(post("http://x"), ctx({ id: assessmentId }))).status).toBe(404);
    as(guardianA);
    expect((await r.one.GET(post("http://x"), ctx({ id: assessmentId }))).status).toBe(403);
    as(ownerA);
    expect((await r.one.GET(post("http://x"), ctx({ id: randomUUID() }))).status).toBe(404);
    expect((await r.one.GET(post("http://x"), ctx({ id: "not-a-uuid" }))).status).toBe(404);
  });

  it("E-2.2 / E-4.3: answer everything and submit; submitting twice -> 409; saving after submit -> 409", async () => {
    as(guardianA);
    expect((await review(assessmentId, {})).status).toBe(403);
    as(ownerA);
    expect((await review(assessmentId, { share_with_parent: true })).status).toBe(409); // not submitted yet
    as(guardianA);
    const version = await versionOf(assessmentId);
    expect((await save(assessmentId, allAnswers({ rf_skill_regression: "yes" }), version)).status).toBe(200);
    const res = await submit(assessmentId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "submitted", red_flags: ["skill_regression"] });
    expect(notify.calls.map((c) => c[0])).toContain("assessment.submitted");
    const [row] = await sql<{ status: string; submitted_at: Date | null; score: { band: string; total: number } }[]>`
      select status, submitted_at, score from assessments where id = ${assessmentId}`;
    expect(row.status).toBe("submitted");
    expect(row.submitted_at).not.toBeNull();
    expect(row.score).toEqual(scoreCheckin(allAnswers({ rf_skill_regression: "yes" })));
    expect(row.score).toMatchObject({ band: "see_professional_soon", complete: true });

    const twice = await submit(assessmentId);
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("Already submitted");
    expect((await save(assessmentId, { q1: "never" }, await versionOf(assessmentId))).status).toBe(409);
  });

  it("E-2.3: provider reviews with `Share result with parent` -> published summary visible to the guardian", async () => {
    as(ownerA);
    const r = await routes();
    const detail = await (await r.one.GET(post("http://x"), ctx({ id: assessmentId }))).json();
    expect(detail.score).toMatchObject({ band: "see_professional_soon", disclaimer: "This is a developmental check-in, not a diagnosis." });

    const res = await review(assessmentId, { note: "Internal: call the family today (synthetic).", share_with_parent: true });
    expect(res.status).toBe(200);
    const { assessment, published } = await res.json();
    expect(assessment).toMatchObject({ status: "reviewed", reviewed_by: ownerA.id, reviewer_note: "Internal: call the family today (synthetic)." });
    expect(published).toMatchObject({
      entity_type: "assessment",
      entity_id: assessmentId,
      version: 1,
      child_id: childA,
      case_id: caseA,
      org_id: orgA,
      visible_to_guardian: true,
      published_by: ownerA.id,
    });
    expect(published.content_md).toContain("This is a developmental check-in, not a diagnosis.");
    expect(published.content_md).not.toContain("Internal: call the family");
    expect(await auditActions(assessmentId)).toContain("assessment.reviewed");
    expect((await review(assessmentId, { share_with_parent: true })).status).toBe(409);

    const { getGuardianAssessment } = await import("@/lib/assessments");
    const seen = await getGuardianAssessment(assessmentId, guardianA.id);
    expect(seen?.summary?.content_md).toBe(published.content_md);
    expect(seen?.assessment.status).toBe("reviewed");
  });

  it("a review without sharing publishes a provider-only version; the guardian sees no result", async () => {
    as(ownerA);
    const second = await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id });
    const id = (await second.json()).assessment.id as string;
    as(guardianA);
    expect((await save(id, allAnswers(), 1)).status).toBe(200);
    expect((await submit(id)).status).toBe(200);
    as(ownerA);
    const res = await review(id, { share_with_parent: false });
    expect((await res.json()).published.visible_to_guardian).toBe(false);
    const { getGuardianAssessment } = await import("@/lib/assessments");
    expect((await getGuardianAssessment(id, guardianA.id))?.summary).toBeNull();
  });

  it("cancel: only open questionnaires; the guardian can no longer answer", async () => {
    as(ownerA);
    const created = await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id });
    const id = (await created.json()).assessment.id as string;
    const r = await routes();
    expect((await r.cancel.POST(post("http://x"), ctx({ id }))).status).toBe(200);
    expect((await r.cancel.POST(post("http://x"), ctx({ id }))).status).toBe(409);
    expect((await r.cancel.POST(post("http://x"), ctx({ id: assessmentId }))).status).toBe(409); // reviewed
    as(guardianA);
    const res = await save(id, { q1: "never" }, await versionOf(id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MSG.cancelled);
    const { listGuardianAssessments } = await import("@/lib/assessments");
    expect((await listGuardianAssessments(guardianA.id)).map((a) => a.id)).not.toContain(id);
  });

  it("FR-10: the `assessments` share loader lists reviewed questionnaires of the source orgs only", async () => {
    const { SHARE_LOADERS } = await import("@/lib/sharing/registry");
    const loader = SHARE_LOADERS.assessments!;
    const items = await loader.list({ childId: childA, sourceOrgIds: [orgA] });
    expect(items.map((i) => i.id)).toContain(assessmentId);
    expect(items.every((i) => i.sourceOrgId === orgA && i.title === "Parent developmental check-in")).toBe(true);
    expect(await loader.list({ childId: childA, sourceOrgIds: [orgB] })).toEqual([]);
    expect(await loader.list({ childId: randomUUID(), sourceOrgIds: [orgA] })).toEqual([]);
    const item = await loader.get({ childId: childA, sourceOrgIds: [orgA] }, assessmentId);
    expect(item?.body).toEqual({ kind: "markdown", markdown: expect.stringContaining("not a diagnosis") });
    expect(await loader.get({ childId: childA, sourceOrgIds: [orgB] }, assessmentId)).toBeNull();

    // Open (unreviewed) questionnaires are never shared.
    as(ownerA);
    const open = await (await assign({ template_id: PARENT_CHECKIN_TEMPLATE_ID, assigned_to: guardianA.id })).json();
    expect(await loader.get({ childId: childA, sourceOrgIds: [orgA] }, open.assessment.id)).toBeNull();
  });

  it("NFR-2: a revoked guardian link ends access on the next request", async () => {
    as(ownerA);
    const { listCaseAssessments, getGuardianAssessment } = await import("@/lib/assessments");
    const open = (await listCaseAssessments(caseA)).find((a) => a.status === "assigned")!;
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${linkA}`;
    try {
      as(guardianA);
      expect((await save(open.id, { q1: "never" }, open.version)).status).toBe(404);
      expect(await getGuardianAssessment(open.id, guardianA.id)).toBeNull();
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where id = ${linkA}`;
    }
  });

  it("RLS: the assigned guardian and the care team read; other guardians and orgs read nothing; no client writes", async () => {
    const read = (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [{ a }] = await tx<{ a: number }[]>`select count(*)::int as a from assessments where id = ${assessmentId}`;
        const [{ r }] = await tx<{ r: number }[]>`select count(*)::int as r from assessment_responses where assessment_id = ${assessmentId}`;
        return [a, r];
      });
    expect(await read(guardianA.id)).toEqual([1, 21]);
    expect(await read(ownerA.id)).toEqual([1, 21]);
    expect(await read(guardianB.id)).toEqual([0, 0]);
    expect(await read(providerB.id)).toEqual([0, 0]);
    expect(await read(memberA.id)).toEqual([0, 0]);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: guardianA.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`update assessments set status = 'assigned' where id = ${assessmentId}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
