// Ticket 038: AI scribe for any provider type.
// Pure checks: template routing by provider type (FR-2), Zod validation of every DEMO fixture (NFR-2), citations point
// to existing transcript segments (FR-4), goal-suggestion mapping, copy rules (NFR-3), the upload flow's third step.
// Database checks (real route handlers, DEMO fixtures for Scribe and Gemini, local Supabase): E-1 therapy note + goal
// progress (accept -> goal_progress `ai_suggested_confirmed`, guardian chart; reject -> nothing), idempotent re-run that
// keeps final notes, E-2 Rx draft only for verified prescribers, E-3 guards (video appointment 422, consent before
// Gemini, consent withdrawn between transcription and scribe -> `consent_withdrawn`, guardian sees nothing until the
// note is finalized and shared), E-4 authz negatives (other org -> 404). Synthetic data only; removed afterwards.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newProgress, runFlow, type ApiResult, type FlowDeps } from "@/components/session/uploadFlow";
import { PROVIDER_TYPES, PRESCRIBER_TYPES } from "@/lib/providers/constants";
import { REPORT_KINDS, REPORT_KIND_KEYS } from "@/lib/clinical/reports";
import { appointmentMatchesCase, appointmentMode, toScribeAppointment } from "@/lib/scribe/appointments";
import {
  applyCopyRules,
  buildNotePrompt,
  citedSegmentIds,
  goalsForPrompt,
  noteMarkdown,
  processGoalSuggestions,
  processNote,
  processRx,
  resolveCitations,
  stripCitations,
  violatesCopyRules,
} from "@/lib/scribe/process";
import { noteOutputSchema, RxOutputSchema } from "@/lib/scribe/schema";
import {
  defaultTemplateFor,
  demoTranscriptFor,
  IN_CLINIC_ONLY,
  NOTE_TEMPLATES,
  recordingKindFor,
  SCRIBE_LABEL,
  TEMPLATE_BY_PROVIDER_TYPE,
} from "@/lib/scribe/templates";
import { buildSegments, mapSpeakers } from "@/lib/transcript";
import type { Segment } from "@/lib/types";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1" && process.env.DEMO_MODE === "true";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

// Every Gemini request is recorded and still answered from the DEMO fixtures.
const gemini = vi.hoisted(() => ({ tasks: [] as string[] }));
vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return {
    ...actual,
    generateJson: vi.fn(async (args: Parameters<typeof actual.generateJson>[0]) => {
      gemini.tasks.push(args.task);
      return actual.generateJson(args);
    }),
  };
});

const FX = path.join(process.cwd(), "demo/fixtures");
const fixture = (rel: string): unknown => JSON.parse(readFileSync(path.join(FX, rel), "utf8"));

/** The transcript the DEMO transcription produces for a template (same code path as the transcribe route). */
function demoSegments(file: string): Segment[] {
  const scribe = fixture(file) as { words: Parameters<typeof buildSegments>[0] };
  return mapSpeakers(buildSegments(scribe.words)).segments;
}

const THERAPY = demoSegments("scribe-response-therapy.json");
const CONSULT = demoSegments("scribe-response-consult.json");

describe("FR-2 template routing by provider type", () => {
  it("maps every provider type; prescribers and psychologists get the medical template, therapists the therapy one", () => {
    for (const type of PROVIDER_TYPES) expect(defaultTemplateFor(type)).toBe(TEMPLATE_BY_PROVIDER_TYPE[type]);
    for (const type of PRESCRIBER_TYPES) expect(defaultTemplateFor(type)).toBe("medical_consult_note");
    expect(defaultTemplateFor("child_psychologist")).toBe("medical_consult_note");
    for (const type of ["speech_language_pathologist", "occupational_therapist", "aba_therapist", "special_educator", "physiotherapist"]) {
      expect(defaultTemplateFor(type)).toBe("therapy_session_note");
    }
    // No provider profile (legacy accounts) or an unknown value: the unchanged Child Development path.
    expect(defaultTemplateFor(null)).toBe("child_dev_isaa");
    expect(defaultTemplateFor("astrologer")).toBe("child_dev_isaa");
    expect(recordingKindFor("medical_consult_note")).toBe("consult");
    expect(recordingKindFor("therapy_session_note")).toBe("session");
    expect(recordingKindFor("child_dev_isaa")).toBe("session");
    expect(demoTranscriptFor("child_dev_isaa")).toBeNull();
    expect(demoTranscriptFor("therapy_session_note")).toBe("scribe-response-therapy.json");
  });

  it("024 report kinds: session_note and rx_draft are in use and provider-audience", () => {
    expect(REPORT_KIND_KEYS.filter((k) => REPORT_KINDS[k].inUse)).toContain("session_note");
    expect(REPORT_KINDS.session_note.audience).toBe("provider");
    expect(REPORT_KINDS.rx_draft.publishable).toBe(false);
  });
});

describe("NFR-2 / FR-4 fixtures: Zod validation and citations", () => {
  const therapy = noteOutputSchema("therapy_session_note").parse(fixture("gemini/scribe-therapy.json"));
  const medical = noteOutputSchema("medical_consult_note").parse(fixture("gemini/scribe-medical.json"));
  const rx = RxOutputSchema.parse(fixture("gemini/scribe-rx.json"));

  it("every scribe fixture parses with its schema; wrong shapes are rejected", () => {
    expect(therapy.sections.map((s) => s.key)).toEqual(NOTE_TEMPLATES.therapy_session_note.sections.map((s) => s.key));
    expect(medical.sections.map((s) => s.key)).toEqual(NOTE_TEMPLATES.medical_consult_note.sections.map((s) => s.key));
    expect(rx.items).toHaveLength(1);
    // A therapy fixture is not a valid medical note (section keys are per template) and vice versa.
    expect(noteOutputSchema("medical_consult_note").safeParse(fixture("gemini/scribe-therapy.json")).success).toBe(false);
    expect(noteOutputSchema("therapy_session_note").safeParse(fixture("gemini/scribe-medical.json")).success).toBe(false);
    const badRx = structuredClone(fixture("gemini/scribe-rx.json")) as { items: { form: string; duration_days: number }[] };
    badRx.items[0].form = "injection";
    expect(RxOutputSchema.safeParse(badRx).success).toBe(false);
    badRx.items[0].form = "tablet";
    badRx.items[0].duration_days = 400;
    expect(RxOutputSchema.safeParse(badRx).success).toBe(false);
    expect(noteOutputSchema("therapy_session_note").safeParse({ sections: [], goal_suggestions: [{ goal_ref: "goal-1" }] }).success).toBe(false);
  });

  it("every citation of every fixture points to an existing segment of its DEMO transcript and its quote is verified", () => {
    for (const [template, output, segments] of [
      ["therapy_session_note", therapy, THERAPY],
      ["medical_consult_note", medical, CONSULT],
    ] as const) {
      const ids = new Set(segments.map((s) => s.id));
      const note = processNote({ template, output, segments, healthSummary: null });
      const statements = note.sections.flatMap((s) => s.statements);
      expect(statements.length).toBeGreaterThan(4);
      for (const st of statements) {
        expect(st.citations.length, st.text).toBeGreaterThan(0);
        for (const c of st.citations) {
          expect(ids.has(c.segment_id)).toBe(true);
          expect(c.verified, `${c.segment_id}: ${c.quote}`).toBe(true);
          expect(c.start_sec).toBe(segments.find((s) => s.id === c.segment_id)?.start_sec);
        }
      }
      const md = noteMarkdown(note);
      expect(citedSegmentIds(md).length).toBeGreaterThan(0);
      expect(citedSegmentIds(md).every((id) => ids.has(id))).toBe(true);
      // The guardian version has no audio links.
      expect(citedSegmentIds(stripCitations(md))).toEqual([]);
      expect(stripCitations(md)).not.toContain("#seg-");
    }
    const draft = processRx(rx, CONSULT, "Allergies: amoxicillin (rash)");
    expect(draft.items[0].citations.every((c) => c.verified && CONSULT.some((s) => s.id === c.segment_id))).toBe(true);
  });

  it("unknown segment ids are dropped; quotes not in the segment are kept but unverified", () => {
    const out = resolveCitations(
      [
        { segment_id: "s999", quote: "invented" },
        { segment_id: "s4", quote: "made four two-word requests" },
        { segment_id: "s4", quote: "duplicate" },
        { segment_id: "s2", quote: "something the parent never said" },
      ],
      THERAPY,
    );
    expect(out.map((c) => [c.segment_id, c.verified])).toEqual([
      ["s4", true],
      ["s2", false],
    ]);
  });

  it("goal suggestions: only listed goals, values inside the measure, one per goal, evidence required", () => {
    const goals = goalsForPrompt([
      { id: "g-requests", statement: "Requests", measure_type: "count", baseline_value: 1, target_value: 5, latest_value: null },
      { id: "g-turns", statement: "Turns", measure_type: "percent", baseline_value: 20, target_value: 80, latest_value: 40 },
    ]);
    expect(goals.map((g) => g.ref)).toEqual(["G1", "G2"]);
    const processed = processGoalSuggestions(therapy.goal_suggestions, goals, THERAPY);
    expect(processed.map((p) => [p.goal_id, p.suggested_value])).toEqual([
      ["g-requests", 4],
      ["g-turns", 60],
    ]);
    expect(processed[0].evidence[0]).toMatchObject({ segment_id: "s4", verified: true });
    const noisy = processGoalSuggestions(
      [
        { goal_ref: "G3", suggested_value: 1, segment_id: "s4", quote: "x", rationale: "unknown goal" },
        { goal_ref: "G2", suggested_value: 120, segment_id: "s6", quote: "x", rationale: "out of range" },
        { goal_ref: "G1", suggested_value: -1, segment_id: "s4", quote: "x", rationale: "count cannot be negative" },
        { goal_ref: "G1", suggested_value: 3, segment_id: "s404", quote: "x", rationale: "no such segment" },
        { goal_ref: "G1", suggested_value: 3, segment_id: "s4", quote: "made four", rationale: "first" },
        { goal_ref: "G1", suggested_value: 4, segment_id: "s4", quote: "made four", rationale: "second" },
      ],
      goals,
      THERAPY,
    );
    expect(noisy).toHaveLength(1);
    expect(noisy[0]).toMatchObject({ goal_id: "g-requests", suggested_value: 3, rationale: "first" });
  });

  it("the note prompt carries the template sections, goal refs with measures, health summary, speaker roles and the transcript", () => {
    const goals = goalsForPrompt([
      { id: "g1", statement: "Two-word requests", measure_type: "count", baseline_value: 1, target_value: 5, latest_value: 2 },
    ]);
    const prompt = buildNotePrompt({ template: "therapy_session_note", segments: THERAPY, goals, healthSummary: "Allergies: none" });
    expect(prompt).toContain("- caregiver_coaching: Caregiver coaching");
    expect(prompt).toContain("G1. Two-word requests | measure: count");
    expect(prompt).toContain("latest recorded 2");
    expect(prompt).toContain("Health summary: Allergies: none");
    expect(prompt).toContain("THERAPIST = Clinician");
    expect(prompt).toContain("CHILD = Child");
    expect(prompt).toMatch(/\[s4 \| \d{2}:\d{2}-\d{2}:\d{2} \| THERAPIST\]/);
  });

  it("NFR-3 copy rules: AI text is rewritten and no scribe fixture or prompt uses the banned stem", () => {
    const banned = new RegExp("diag" + "nos", "i");
    const word = (suffix: string) => `diag${"nos"}${suffix}`;
    expect(applyCopyRules(`A ${word("is")} of X; we ${word("ed")} it; ${word("es")}; to ${word("e")}`)).toBe(
      "A clinical impression of X; we identified it; clinical impressions; to identify",
    );
    expect(violatesCopyRules(`no ${word("is")}`)).toBe(true);
    expect(violatesCopyRules("clinical impression")).toBe(false);
    for (const file of ["gemini/scribe-therapy.json", "gemini/scribe-medical.json", "gemini/scribe-rx.json"]) {
      expect(readFileSync(path.join(FX, file), "utf8")).not.toMatch(banned);
    }
    for (const file of ["session-note-therapy.md", "session-note-medical.md", "rx-draft.md"]) {
      expect(readFileSync(path.join(process.cwd(), "prompts", file), "utf8")).not.toMatch(banned);
    }
    expect(SCRIBE_LABEL).toBe("Suggested by DoctorNearMe - the clinician decides");
  });
});

describe("FR-3 appointments (pure)", () => {
  it("reads the mode from the 030 service snapshot, a mode column or a Meet link", () => {
    expect(appointmentMode({ service_snapshot: { mode: "video" } })).toBe("video");
    expect(appointmentMode({ service_snapshot: { mode: "in_clinic" } })).toBe("in_clinic");
    expect(appointmentMode({ mode: "in_clinic", meet_url: "https://meet.google.com/abc-defg-hij" })).toBe("video");
    expect(appointmentMode({})).toBe("unknown");
    const a = toScribeAppointment({ id: "a1", org_id: "o1", child_id: "c1", slot: '["2026-11-20 10:00:00+00","2026-11-20 10:30:00+00")' });
    expect(a.starts_at).toBe("2026-11-20 10:00:00+00");
    expect(appointmentMatchesCase(a, { id: "k1", org_id: "o1", child_id: "c1" })).toBe(true);
    expect(appointmentMatchesCase(a, { id: "k1", org_id: "o2", child_id: "c1" })).toBe(false);
    expect(appointmentMatchesCase(a, { id: "k1", org_id: "o1", child_id: "c2" })).toBe(false);
  });
});

describe("upload flow with a Session type (FR-3)", () => {
  const file = new File([new Uint8Array(10)], "a.wav", { type: "audio/wav" });
  const ok = (json: Record<string, unknown> = {}): ApiResult => ({ ok: true, status: 200, json });
  function deps() {
    const calls: { url: string; body?: unknown }[] = [];
    const d: FlowDeps = {
      post: async (url, body) => {
        calls.push({ url, body });
        return url.endsWith("/sessions") ? ok({ recording_id: "rec-1", path: "c/rec-1.wav", token: "tok" }) : ok();
      },
      uploadToSignedUrl: async () => ({ error: null }),
    };
    return { calls, d };
  }

  it("AI scribe templates send the template and appointment and run the scribe instead of the ISAA extraction", async () => {
    const { calls, d } = deps();
    const result = await runFlow({
      caseId: "c",
      file,
      progress: newProgress(),
      deps: d,
      onStep: () => {},
      template: "therapy_session_note",
      appointmentId: "appt-1",
    });
    expect(result).toEqual({ ok: true, recordingId: "rec-1" });
    expect(calls.map((c) => c.url)).toEqual(["/api/cases/c/sessions", "/api/sessions/rec-1/transcribe", "/api/sessions/rec-1/scribe"]);
    expect(calls[0].body).toMatchObject({ template: "therapy_session_note", appointment_id: "appt-1" });
  });

  it("the Child Development template keeps the ISAA extraction", async () => {
    const { calls, d } = deps();
    await runFlow({ caseId: "c", file, progress: newProgress(), deps: d, onStep: () => {}, template: "child_dev_isaa" });
    expect(calls.map((c) => c.url).at(-1)).toBe("/api/sessions/rec-1/extract");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!enabled)("AI scribe (database, DEMO fixtures)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let owner: TestUser, providerA: TestUser, providerRx: TestUser, memberA: TestUser, providerB: TestUser, guardian: TestUser;
  let orgA: string, orgB: string, caseA: string, childA: string, isaaRecording: string, linkId: string;
  let goal1: string, goal2: string;
  // 030: appointments reference a provider profile; a synthetic, unlisted one owns this suite's appointments.
  let appointmentProfileId: string | null = null;
  const profiles: string[] = [];

  const as = (u: TestUser | null) => {
    session.user = u;
  };
  const routes = async () => ({
    sessions: await import("@/app/api/cases/[id]/sessions/route"),
    transcribe: await import("@/app/api/sessions/[id]/transcribe/route"),
    extract: await import("@/app/api/sessions/[id]/extract/route"),
    scribe: await import("@/app/api/sessions/[id]/scribe/route"),
    suggestion: await import("@/app/api/goal-suggestions/[id]/route"),
  });
  async function call(res: Response) {
    return { status: res.status, body: await res.json() };
  }
  async function upload(caseId: string, body: Record<string, unknown>) {
    const res = await call(
      await (await routes()).sessions.POST(
        post(`http://x/api/cases/${caseId}/sessions`, { file_name: "s.wav", mime_type: "audio/wav", size_bytes: 20, consent: true, ...body }),
        ctx({ id: caseId }),
      ),
    );
    if (res.status === 201) {
      const { error } = await db.storage.from("recordings").upload(res.body.path, Buffer.from("RIFF synthetic"), { contentType: "audio/wav", upsert: true });
      expect(error).toBeNull();
    }
    return res;
  }
  const transcribe = async (id: string) => call(await (await routes()).transcribe.POST(post("http://x"), ctx({ id })));
  const runScribeRoute = async (id: string) => call(await (await routes()).scribe.POST(post("http://x"), ctx({ id })));
  const getScribe = async (id: string) => call(await (await routes()).scribe.GET(post("http://x", undefined, "GET"), ctx({ id })));
  const patchNote = async (id: string, body: Record<string, unknown>) =>
    call(await (await routes()).scribe.PATCH(post("http://x", body, "PATCH"), ctx({ id })));
  const decide = async (id: string, body: Record<string, unknown>) =>
    call(await (await routes()).suggestion.PATCH(post("http://x", body, "PATCH"), ctx({ id })));

  async function verifiedProfile(user: TestUser, type: string, council: string | null, status = "verified") {
    const [row] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, registration_council, registration_number,
                                     verification_status, verified_at, claimed, is_synthetic, created_by)
      values (${user.id}, ${`t038-${type.replace(/_/g, "-")}-${world.tag}`}, ${`Dr Synthetic ${type}`}, ${type}, ${council},
              ${council ? "SYN-0001" : null}, ${status}, ${status === "verified" ? new Date() : null}, true, true, ${user.id})
      returning id`;
    profiles.push(row.id);
    return row.id;
  }

  async function newScribeSession(user: TestUser, template: string) {
    as(user);
    const up = await upload(caseA, { template });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const tr = await transcribe(up.body.recording_id);
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);
    return up.body.recording_id as string;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t038");
    owner = await world.user("owner", "provider");
    providerA = await world.user("slp", "provider");
    providerRx = await world.user("paed", "provider");
    memberA = await world.user("member", "provider");
    providerB = await world.user("otherorg", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    orgA = await world.org(owner, "Centre A");
    orgB = await world.org(providerB, "Solo B");
    for (const u of [providerA, providerRx, memberA]) await world.member(orgA, u);
    await verifiedProfile(providerA, "speech_language_pathologist", "RCI");
    await verifiedProfile(providerRx, "pediatrician", "NMC");
    const kase = await world.kase(orgA);
    caseA = kase.caseId;
    childA = kase.childId;
    isaaRecording = kase.recordingId;
    for (const u of [providerA, providerRx]) await sql`insert into case_assignments (case_id, user_id) values (${caseA}, ${u.id})`;
    linkId = await world.link(childA, guardian);
    await world.grant(childA, guardian, linkId);

    // An active (published) IEP plan with two goals (025), as the eval's setup.
    const iep = await import("@/lib/iep");
    const { GoalCreateSchema, PlanCreateSchema } = await import("@/lib/iep/schema");
    const plan = await iep.createPlan({
      caseId: caseA,
      actorUserId: providerA.id,
      body: PlanCreateSchema.parse({ title: `t038 plan ${world.tag}`, start_date: TODAY, review_date: shift(TODAY, 180) }),
    });
    if (!plan.ok) throw new Error(plan.error);
    const smart = {
      specific: "Requests snacks and toys with 2-word phrases",
      measurable: "Counted by the therapist each session",
      achievable: "Uses single words today",
      relevant: "Reduces frustration at home",
      time_bound: "Within 3 months, checked weekly",
      target_date: shift(TODAY, 90),
    };
    const g1 = await iep.addGoal({
      planId: plan.plan.id,
      actorUserId: providerA.id,
      body: GoalCreateSchema.parse({ ...smart, domain: "communication", statement: "Asha will make 5 two-word requests without a prompt", measure_type: "count", baseline_value: 1, target_value: 5, version: 1 }),
    });
    if (!g1.ok) throw new Error(g1.error);
    const g2 = await iep.addGoal({
      planId: plan.plan.id,
      actorUserId: providerA.id,
      body: GoalCreateSchema.parse({ ...smart, domain: "social", statement: "Asha will wait for her turn in 80% of turn-taking games", measure_type: "percent", baseline_value: 20, target_value: 80, version: g1.plan_version }),
    });
    if (!g2.ok) throw new Error(g2.error);
    goal1 = g1.goal.id;
    goal2 = g2.goal.id;
    const published = await iep.publishPlan({ planId: plan.plan.id, actorUserId: providerA.id, version: g2.plan_version });
    if (!("ok" in published) || !published.ok) throw new Error("publish failed");

    const [profile] = await sql<{ id: string }[]>`
      insert into provider_profiles (slug, display_name, provider_type, is_synthetic)
      values (${`t038-appt-${randomUUID().slice(0, 8)}`}, 't038 Appointment provider (synthetic)', 'speech_language_pathologist', true)
      returning id`;
    appointmentProfileId = profile.id;
  });

  afterAll(async () => {
    as(null);
    if (sql) {
      if (appointmentProfileId) await sql`delete from provider_profiles where id = ${appointmentProfileId}`; // appointments cascade
      if (caseA) {
        const { data } = await db.storage.from("recordings").list(caseA, { limit: 100 });
        const keys = (data ?? []).map((o) => `${caseA}/${o.name}`);
        if (keys.length) await db.storage.from("recordings").remove(keys);
        await sql`delete from outbox_events where aggregate_type = 'iep_plan' and aggregate_id in (select id from iep_plans where case_id = ${caseA})`;
      }
      if (profiles.length) await sql`delete from provider_profiles where id in ${sql(profiles)}`;
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => {
    gemini.tasks.length = 0;
  });

  it("the DB report-kind check matches the in-use kinds of lib/clinical/reports.ts", async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'reports_kind_check' and conrelid = 'public.reports'::regclass`;
    for (const kind of REPORT_KIND_KEYS) {
      expect(row.def.includes(`'${kind}'`), kind).toBe(REPORT_KINDS[kind].inUse);
    }
  });

  let therapyRec: string;
  let suggestions: { id: string; goal_id: string; suggested_value: number; evidence: { quote: string }[] }[];

  it("E-1: therapy session -> draft note with citations and 2 goal suggestions with quotes (no Rx draft)", async () => {
    therapyRec = await newScribeSession(providerA, "therapy_session_note");
    const [rec] = await sql<{ kind: string; template: string; uploaded_by: string; status: string }[]>`
      select kind, template, uploaded_by, status from recordings where id = ${therapyRec}`;
    expect(rec).toEqual({ kind: "session", template: "therapy_session_note", uploaded_by: providerA.id, status: "transcribed" });

    const res = await runScribeRoute(therapyRec);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(gemini.tasks).toEqual(["scribe-therapy"]);
    expect(res.body.rx_draft_id).toBeUndefined();
    expect(res.body.session_note_status).toBe("draft");
    suggestions = res.body.goal_suggestions;
    expect(suggestions.map((s) => [s.goal_id, s.suggested_value])).toEqual([
      [goal1, 4],
      [goal2, 60],
    ]);
    for (const s of suggestions) expect(s.evidence[0].quote.length).toBeGreaterThan(10);

    const [note] = await sql<{ id: string; status: string; content_md: string; content: { sections: { statements: unknown[] }[] } }[]>`
      select id, status, content_md, content from reports where recording_id = ${therapyRec} and kind = 'session_note'`;
    expect(note.id).toBe(res.body.session_note_id);
    expect(note.status).toBe("draft");
    const [{ segments }] = await sql<{ segments: Segment[] }[]>`select segments from recordings where id = ${therapyRec}`;
    const cited = citedSegmentIds(note.content_md);
    expect(cited.length).toBeGreaterThan(5);
    expect(cited.every((id) => segments.some((s) => s.id === id))).toBe(true);
    // Nothing is published (NFR-1).
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from published_versions where entity_id = ${note.id}`;
    expect(n).toBe(0);
  });

  it("E-1: Accept one suggestion -> goal_progress `ai_suggested_confirmed` with the recording; the guardian chart shows it", async () => {
    as(providerA);
    const g1 = suggestions.find((s) => s.goal_id === goal1)!;
    const res = await decide(g1.id, { status: "accepted" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entry).toMatchObject({ goal_id: goal1, value: 4, source: "ai_suggested_confirmed", recording_id: therapyRec, recorded_by: providerA.id });
    const [row] = await sql<{ status: string; decided_by: string; progress_id: string; decided_value: number }[]>`
      select status, decided_by, progress_id, decided_value::float8 as decided_value from goal_progress_suggestions where id = ${g1.id}`;
    expect(row).toMatchObject({ status: "accepted", decided_by: providerA.id, progress_id: res.body.entry.id, decided_value: 4 });

    const { getGuardianPlans } = await import("@/lib/iep");
    const plans = await getGuardianPlans(childA);
    const chart = plans[0].goals.find((g) => g.id === goal1)!;
    expect(chart.points.map((p) => p.value)).toEqual([4]);

    expect((await decide(g1.id, { status: "accepted" })).status).toBe(409);
    expect((await decide(g1.id, { status: "rejected" })).status).toBe(409);
  });

  it("E-1: Reject the other -> no progress row; Edit value is validated against the goal's measure", async () => {
    as(providerA);
    const g2 = suggestions.find((s) => s.goal_id === goal2)!;
    expect((await decide(g2.id, { status: "accepted", value: 140 })).status).toBe(400);
    expect((await decide(g2.id, { status: "rejected", value: 50 })).status).toBe(400);
    const res = await decide(g2.id, { status: "rejected" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.suggestion.status).toBe("rejected");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goal_progress where goal_id = ${goal2}`;
    expect(n).toBe(0);
  });

  it("idempotent re-run keeps decisions; a final note is never replaced; the guardian sees it only once finalized and shared", async () => {
    as(providerA);
    const first = await runScribeRoute(therapyRec);
    expect(first.status).toBe(200);
    expect(first.body.goal_suggestions.map((s: { status: string }) => s.status)).toEqual(["accepted", "rejected"]);
    const { listGuardianSessionNotes } = await import("@/lib/scribe/queries");
    expect(await listGuardianSessionNotes(childA)).toEqual([]);

    // Clinician edits and finalizes without sharing (default off).
    const edited = "# Therapy session note\n\n## Child's response\n\n- Four two-word requests [00:24](#seg-s4)\n";
    expect((await patchNote(therapyRec, { content_md: edited })).status).toBe(200);
    const final = await patchNote(therapyRec, { status: "final" });
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body).toMatchObject({ published_version: 1, visible_to_guardian: false });
    expect(await listGuardianSessionNotes(childA)).toEqual([]);
    expect((await patchNote(therapyRec, { content_md: "changed" })).status).toBe(409);

    // Re-run: the final note stays exactly as finalized.
    const rerun = await runScribeRoute(therapyRec);
    expect(rerun.status).toBe(200);
    expect(rerun.body.session_note_status).toBe("final");
    const [note] = await sql<{ content_md: string; status: string }[]>`
      select content_md, status from reports where recording_id = ${therapyRec} and kind = 'session_note'`;
    expect(note).toEqual({ content_md: edited.trim(), status: "final" });

    // Copy rule before sharing, then share: the guardian reads the published text without audio links.
    const shared = await patchNote(therapyRec, { visible_to_guardian: true });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const notes = await listGuardianSessionNotes(childA);
    expect(notes).toHaveLength(1);
    expect(notes[0].content_md).toContain("Four two-word requests");
    expect(notes[0].content_md).not.toContain("#seg-");
    expect((await patchNote(therapyRec, { visible_to_guardian: true })).status).toBe(409);
    expect((await patchNote(therapyRec, { visible_to_guardian: false })).status).toBe(200);
    expect(await listGuardianSessionNotes(childA)).toEqual([]);
  });

  it("NFR-3: a note with a condition label cannot be shared with the family", async () => {
    const rec = await newScribeSession(providerA, "therapy_session_note");
    expect((await runScribeRoute(rec)).status).toBe(200);
    const res = await patchNote(rec, { content_md: `Working ${["diag", "nosis"].join("")}: X`, status: "final", visible_to_guardian: true });
    expect(res.status).toBe(422);
    const [note] = await sql<{ status: string }[]>`select status from reports where recording_id = ${rec} and kind = 'session_note'`;
    expect(note.status).toBe("draft");
  });

  it("E-2: medical consult by a verified prescriber -> rx_draft (039 item shape); the non-prescriber's same audio -> none", async () => {
    const rxRec = await newScribeSession(providerRx, "medical_consult_note");
    const [rec] = await sql<{ kind: string }[]>`select kind from recordings where id = ${rxRec}`;
    expect(rec.kind).toBe("consult");
    const res = await runScribeRoute(rxRec);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(gemini.tasks).toEqual(["scribe-medical", "scribe-rx"]);
    expect(res.body.rx_draft_id).toEqual(expect.any(String));
    const [rx] = await sql<{ kind: string; status: string; content: { items: { drug: string; form: string; duration_days: number }[] } }[]>`
      select kind, status, content from reports where id = ${res.body.rx_draft_id}`;
    expect(rx).toMatchObject({ kind: "rx_draft", status: "draft" });
    expect(rx.content.items[0]).toMatchObject({ drug: "Melatonin", form: "tablet", duration_days: 30 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from published_versions where entity_id = ${res.body.rx_draft_id}`;
    expect(n).toBe(0);

    // Only prescribers see the Rx draft through the API.
    as(providerRx);
    expect((await getScribe(rxRec)).body.rx_draft).toMatchObject({ id: res.body.rx_draft_id });
    as(providerA);
    expect((await getScribe(rxRec)).body.rx_draft).toBeNull();

    gemini.tasks.length = 0;
    const slpRec = await newScribeSession(providerA, "medical_consult_note");
    const slp = await runScribeRoute(slpRec);
    expect(slp.status).toBe(200);
    expect(slp.body.rx_draft_id).toBeUndefined();
    expect(gemini.tasks).toEqual(["scribe-medical"]);
    const [{ m }] = await sql<{ m: number }[]>`select count(*)::int as m from reports where recording_id = ${slpRec} and kind = 'rx_draft'`;
    expect(m).toBe(0);

    // A prescriber who loses verification: the re-run removes the draft Rx.
    await sql`update provider_profiles set verification_status = 'suspended' where user_id = ${providerRx.id}`;
    as(providerRx);
    const again = await runScribeRoute(rxRec);
    expect(again.body.rx_draft_id).toBeUndefined();
    const [{ k }] = await sql<{ k: number }[]>`select count(*)::int as k from reports where recording_id = ${rxRec} and kind = 'rx_draft'`;
    expect(k).toBe(0);
    await sql`update provider_profiles set verification_status = 'verified' where user_id = ${providerRx.id}`;
  });

  it("E-3: a video appointment is refused with 422 (upload and scribe); another org's appointment is 404", async () => {
    as(providerA);
    const video = randomUUID();
    const clinic = randomUUID();
    const foreign = randomUUID();
    // 030's real table: distinct half-open slots so the exclusion constraint is satisfied.
    await sql`insert into public.appointments (id, provider_profile_id, org_id, case_id, child_id, status, service_snapshot, slot) values
      (${video}, ${appointmentProfileId}, ${orgA}, ${caseA}, ${childA}, 'confirmed', ${sql.json({ mode: "video" })}, tstzrange(now() - interval '3 hours', now() - interval '150 minutes', '[)')),
      (${clinic}, ${appointmentProfileId}, ${orgA}, null, ${childA}, 'confirmed', ${sql.json({ mode: "in_clinic" })}, tstzrange(now() - interval '2 hours', now() - interval '90 minutes', '[)')),
      (${foreign}, ${appointmentProfileId}, ${orgB}, null, ${childA}, 'confirmed', ${sql.json({ mode: "in_clinic" })}, tstzrange(now() - interval '1 hour', now() - interval '30 minutes', '[)'))`;
    const refused = await upload(caseA, { template: "therapy_session_note", appointment_id: video });
    expect(refused).toEqual({ status: 422, body: { error: IN_CLINIC_ONLY } });
    expect((await upload(caseA, { template: "therapy_session_note", appointment_id: foreign })).status).toBe(404);

    const ok = await upload(caseA, { template: "therapy_session_note", appointment_id: clinic });
    expect(ok.status).toBe(201);
    const [rec] = await sql<{ appointment_id: string }[]>`select appointment_id from recordings where id = ${ok.body.recording_id}`;
    expect(rec.appointment_id).toBe(clinic);
    expect((await transcribe(ok.body.recording_id)).status).toBe(200);
    // The appointment became a video consult after the upload: the scribe re-checks and refuses before Gemini.
    await sql`update public.appointments set service_snapshot = ${sql.json({ mode: "video" })} where id = ${clinic}`;
    const res = await runScribeRoute(ok.body.recording_id);
    expect(res).toEqual({ status: 422, body: { error: IN_CLINIC_ONLY } });
    expect(gemini.tasks).toEqual([]);
    const [after] = await sql<{ status: string }[]>`select status from recordings where id = ${ok.body.recording_id}`;
    expect(after.status).toBe("transcribed");
  });

  it("E-3: without ai_extraction consent -> 422 before Gemini; withdrawn between transcription and scribe -> consent_withdrawn", async () => {
    const rec = await newScribeSession(providerA, "therapy_session_note");
    await world.withdraw(childA, guardian, linkId, ["ai_extraction"]);
    try {
      as(providerA);
      const blocked = await runScribeRoute(rec);
      expect(blocked.status).toBe(422);
      expect(blocked.body).toMatchObject({ error: "Guardian consent required", details: { feature: "ai_extraction" } });
      expect((await upload(caseA, { template: "therapy_session_note" })).status).toBe(422);
      // The queued step itself (route gate passed earlier, consent withdrawn since): abort, nothing sent to Gemini.
      const { runScribe } = await import("@/lib/scribe/run");
      const outcome = await runScribe(rec);
      expect(outcome).toMatchObject({ ok: false, status: 422, details: { reason: "consent_withdrawn", stage: "before_gemini_scribe_note" } });
      const [row] = await sql<{ status: string; error: string }[]>`select status, error from recordings where id = ${rec}`;
      expect(row).toEqual({ status: "failed", error: "consent_withdrawn" });
      const audits = await sql`
        select 1 from audit_events where entity_id = ${rec} and action = 'consent.blocked_processing'
          and details->>'stage' = 'before_gemini_scribe_note'`;
      expect(audits).toHaveLength(1);
      expect(gemini.tasks).toEqual([]);
    } finally {
      await world.grant(childA, guardian, linkId, ["ai_extraction"]);
    }
  });

  it("route by template: ISAA sessions keep the extraction (scribe 409); scribe sessions cannot run the ISAA extraction", async () => {
    as(providerA);
    expect((await runScribeRoute(isaaRecording)).status).toBe(409);
    expect((await call(await (await routes()).extract.POST(post("http://x"), ctx({ id: therapyRec })))).status).toBe(409);
  });

  it("E-4: other org, unassigned member and guardians get 404/403; suggestions of another org's case are 404", async () => {
    const [anySuggestion] = await sql<{ id: string }[]>`select id from goal_progress_suggestions where case_id = ${caseA} limit 1`;
    for (const user of [providerB, memberA]) {
      as(user);
      expect((await runScribeRoute(therapyRec)).status).toBe(404);
      expect((await getScribe(therapyRec)).status).toBe(404);
      expect((await patchNote(therapyRec, { visible_to_guardian: true })).status).toBe(404);
      expect((await decide(anySuggestion.id, { status: "accepted" })).status).toBe(404);
    }
    as(providerB);
    expect((await decide(randomUUID(), { status: "rejected" })).status).toBe(404);
    expect((await decide("not-a-uuid", { status: "rejected" })).status).toBe(404);
    as(guardian);
    expect((await runScribeRoute(therapyRec)).status).toBe(403);
    expect((await decide(anySuggestion.id, { status: "accepted" })).status).toBe(403);
  });

  it("a suggestion must target a goal of the recording's case (database trigger)", async () => {
    const other = await world.kase(orgB);
    await expect(
      sql`insert into goal_progress_suggestions (recording_id, case_id, goal_id, suggested_value) values (${other.recordingId}, ${other.caseId}, ${goal1}, 1)`,
    ).rejects.toThrow(/goal does not belong/);
  });

  it("041 registry: all_ai_processing removes open/rejected suggestions and strips evidence from accepted ones", async () => {
    const { REGISTRY } = await import("@/lib/privacy/registry");
    const entry = REGISTRY.find((c) => c.key === "ai_scribe")!;
    expect(entry.erase?.scopes).toEqual(["all_ai_processing", "everything"]);
    await expect(
      sql.begin(async (tx) => {
        await entry.erase!.rows!(tx, { childId: childA, requestId: randomUUID(), scope: "all_ai_processing", requestedBy: guardian.id, caseIds: [caseA] });
        const rows = await tx<{ status: string; evidence: unknown[]; rationale: string }[]>`
          select status, evidence, rationale from goal_progress_suggestions where case_id = ${caseA}`;
        expect(rows.every((r) => r.status === "accepted" && r.evidence.length === 0 && r.rationale === "")).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
  });
});
