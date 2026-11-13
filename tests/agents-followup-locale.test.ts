// Ticket 049: Telugu and Hindi for the follow-up agent (040). Pure: prompts and first messages per language (FR-2),
// the fixed answers are the catalogue's reviewed translations and the 040 English constants, the tool's answer is
// localized for a hi/te session (fixed answers word for word, model answers in English with `translate: true` after
// every safety check), and the scripted te/hi questions make the same `answer_question` calls as English (FR-3/FR-6).
// Database: a Telugu voice session through the real routes in DEMO_MODE (108/112 and the medicine answer in Telugu),
// and ELEVENLABS_FOLLOWUP_LANGUAGES=en refuses Telugu (409, no session, no reservation). Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { followupDemoScript } from "@/lib/agents/followup/demo";
import { followupQuestionFor, INTENT_QUESTIONS } from "@/lib/agents/followup/demo-script";
import { fixedAnswers, localizeToolAnswer } from "@/lib/agents/followup/localize";
import { LANGUAGE_UNAVAILABLE, toAgentTemplate } from "@/lib/agents/languages";
import { AGENT_PROMPTS } from "@/lib/agents/prompts-all";
import { classifyRedFlagText } from "@/lib/clinical/red-flags";
import { DIAGNOSIS_ANSWER, isMedicineChangeQuestion, MEDICINE_ANSWER, NOT_FOUND_ANSWER, RED_FLAG_ANSWER, SUGGESTED_QUESTIONS } from "@/lib/followup/constants";
import type { Locale } from "@/lib/i18n/config";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { closeOpenVoiceCalls, stubGenerousVoiceLimits } from "./helpers/voice";
import { createWorld, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("@/lib/i18n/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/server")>();
  return { ...actual, getTimeZone: vi.fn(async () => "Asia/Kolkata") };
});
const agent = vi.hoisted(() => ({ startAgentSession: vi.fn() }));
vi.mock("@/lib/elevenlabs/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/elevenlabs/agent")>();
  return { ...actual, startAgentSession: agent.startAgentSession };
});

const CATALOGUES = { en, hi, te } as const;
const LANGS = ["en", "hi", "te"] as const satisfies readonly Locale[];
const SCRIPTS = JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures/voice-agents/followup.json"), "utf8")) as Record<Locale, string[]> & {
  expected: string[];
};

describe("FR-2: prompts, first messages and fixed answers per language (follow-up agent)", () => {
  it.each(LANGS)("%s: first message, safety message and the tool-error sentence are the catalogue text", (lang) => {
    const p = AGENT_PROMPTS.followup[lang];
    const m = CATALOGUES[lang];
    expect(p.firstMessage).toBe(toAgentTemplate(m.voiceAgents.followup.firstMessage));
    expect(p.safetyMessage).toBe(m.screen.urgent);
    expect(p.systemPrompt).toContain(`say exactly: "${m.screen.urgent}"`);
    expect(p.systemPrompt).toContain(`say: "${m.voiceAgents.followup.answers.toolFailed}"`);
  });

  it("English is the dashboard text in docs/elevenlabs-followup-agent.md; the fixed answers are the 040 constants", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs/elevenlabs-followup-agent.md"), "utf8");
    expect(doc).toContain(AGENT_PROMPTS.followup.en.firstMessage);
    expect(doc).toContain(AGENT_PROMPTS.followup.en.systemPrompt);
    expect(fixedAnswers("en")).toEqual({ red_flag: RED_FLAG_ANSWER, medicine: MEDICINE_ANSWER, condition: DIAGNOSIS_ANSWER, not_found: NOT_FOUND_ANSWER });
  });

  it.each(["hi", "te"] as const)("%s: the tool keeps English questions; translated answers only from the catalogue", (lang) => {
    const p = AGENT_PROMPTS.followup[lang].systemPrompt;
    for (const token of ["answer_question", "{{followup_session}}", "{{language}}", '"translate": true', '"safety": "red_flag"']) expect(p).toContain(token);
    expect(p).toContain("question = the parent's question translated into English");
    expect(fixedAnswers(lang)).toEqual({
      red_flag: CATALOGUES[lang].screen.urgent,
      medicine: CATALOGUES[lang].voiceAgents.followup.answers.medicine,
      condition: CATALOGUES[lang].voiceAgents.followup.answers.condition,
      not_found: CATALOGUES[lang].voiceAgents.followup.answers.notFound,
    });
  });

  it("localizeToolAnswer: fixed answers word for word in Telugu, model answers English + translate; English unchanged", () => {
    const rf = { found: false, answer: RED_FLAG_ANSWER, citations: [], safety: "red_flag" };
    expect(localizeToolAnswer(rf, "te")).toEqual({ ...rf, answer: te.screen.urgent, language: "te", translate: false });
    expect(localizeToolAnswer({ found: false, answer: MEDICINE_ANSWER, citations: [], safety: "medical_advice" }, "hi")).toMatchObject({
      answer: hi.voiceAgents.followup.answers.medicine,
      translate: false,
    });
    const model = { id: "q", found: true, answer: "Practise two-word requests at snack time.", citations: [{ label: "Home program" }] };
    expect(localizeToolAnswer(model, "te")).toEqual({ ...model, language: "te", translate: true, answer_language: "en" });
    expect(localizeToolAnswer(model, "en")).toBe(model);
    expect(localizeToolAnswer({ error: "Invalid or expired follow-up session" }, "te")).toEqual({ error: "Invalid or expired follow-up session" });
  });
});

describe("FR-3 / FR-6: scripted te/hi questions make the same answer_question calls as English", () => {
  it("the English questions sent for intents are the 040 suggestions (plus a medicine change)", () => {
    expect(SUGGESTED_QUESTIONS).toEqual([INTENT_QUESTIONS.practice, INTENT_QUESTIONS.nextReview, INTENT_QUESTIONS.medicineHow]);
  });

  it.each(LANGS)("%s: questions -> the expected English questions", (lang) => {
    const script = followupDemoScript(lang);
    expect(SCRIPTS[lang].map((u) => followupQuestionFor(script, u))).toEqual(SCRIPTS.expected);
  });

  it("the English questions trigger the same server safety rules (medicine change, 108/112)", () => {
    expect(isMedicineChangeQuestion(SCRIPTS.expected[1])).toBe(true);
    expect(classifyRedFlagText(SCRIPTS.expected[3])).toBe("breathing");
  });
});

describe.skipIf(!enabled)("follow-up voice in Telugu through the routes (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let guardian: TestUser;
  let childId: string;

  const routes = async () => ({
    session: await import("@/app/api/agents/followup/session/route"),
    tool: await import("@/app/api/agents/followup/tools/answer_question/route"),
    demo: await import("@/app/api/agents/followup/demo/answer_question/route"),
  });
  const json = async (res: Response) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> });
  const startVoice = async (language?: Locale) => {
    await closeOpenVoiceCalls(sql, guardian.id);
    return json(await (await routes()).session.POST(post("http://x/api/agents/followup/session", { child_id: childId, ...(language ? { language } : {}) })));
  };
  const reservations = async () => (await sql<{ n: number }[]>`select count(*)::int as n from voice_usage where user_id = ${guardian.id}`)[0].n;

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", "t049-secret");
    stubGenerousVoiceLimits();
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t049f");
    const owner = await world.user("provider", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    const org = await world.org(owner, "Org");
    const kase = await world.kase(org);
    childId = kase.childId;
    const link = await world.link(childId, guardian);
    await world.grant(childId, guardian, link);
    session.user = { id: guardian.id, email: guardian.email };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`delete from followup_agent_sessions where guardian_user_id = ${guardian.id}`;
    await sql`delete from followup_questions where guardian_user_id = ${guardian.id}`;
    await sql`delete from voice_usage where user_id = ${guardian.id}`;
    await world.cleanup();
    await sql.end();
  });

  it("a Telugu session remembers te; the tool answers 108/112 and the medicine rule in Telugu, word for word", async () => {
    const started = await startVoice("te");
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ demo: true, language: "te", dynamic_variables: { language: "te" } });
    expect(started.body.demo_script).toEqual(followupDemoScript("te"));
    const token = String(started.body.followup_session);
    const [row] = await sql<{ language: string }[]>`select language from followup_agent_sessions where guardian_user_id = ${guardian.id} order by created_at desc limit 1`;
    expect(row.language).toBe("te");

    const script = followupDemoScript("te");
    const ask = async (utterance: string) => json(await (await routes()).demo.POST(post("http://x", { followup_session: token, question: followupQuestionFor(script, utterance) })));
    const medicine = await ask(SCRIPTS.te[1]);
    expect(medicine).toMatchObject({ status: 200, body: { answer: te.voiceAgents.followup.answers.medicine, safety: "medical_advice", language: "te", translate: false } });
    // No shared documents for this synthetic child: the not-found answer, in Telugu.
    const review = await ask(SCRIPTS.te[2]);
    expect(review).toMatchObject({ status: 200, body: { answer: te.voiceAgents.followup.answers.notFound, translate: false } });
    const redFlag = await ask(SCRIPTS.te[3]);
    expect(redFlag).toMatchObject({ status: 200, body: { answer: te.screen.urgent, safety: "red_flag", translate: false } });
    // FR-3 (040): after a red flag the session is over.
    expect((await ask(SCRIPTS.te[0])).status).toBe(401);

    // The stored history stays English (the text chat's language); only the spoken answer is translated.
    const stored = await sql<{ answer: string }[]>`select answer from followup_questions where guardian_user_id = ${guardian.id}`;
    expect(stored.map((r) => r.answer).sort()).toEqual([MEDICINE_ANSWER, NOT_FOUND_ANSWER].sort());
  });

  it("an English session answers exactly as before (no language fields)", async () => {
    const started = await startVoice();
    expect(started.body.language).toBe("en");
    const res = await json(await (await routes()).demo.POST(post("http://x", { followup_session: String(started.body.followup_session), question: SCRIPTS.en[1] })));
    expect(res.body).toEqual({ id: expect.any(String), found: false, answer: MEDICINE_ANSWER, citations: [], safety: "medical_advice" });
  });

  it("FR-4: ELEVENLABS_FOLLOWUP_LANGUAGES=en -> Telugu refused with 409 (no session, no reservation, no ElevenLabs)", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_FOLLOWUP_AGENT_ID", "agent_followup_049");
    vi.stubEnv("ELEVENLABS_FOLLOWUP_LANGUAGES", "en");
    const sessionsBefore = (await sql<{ n: number }[]>`select count(*)::int as n from followup_agent_sessions where guardian_user_id = ${guardian.id}`)[0].n;
    const before = await reservations();
    const refused = await startVoice("te");
    expect(refused).toEqual({ status: 409, body: { error: LANGUAGE_UNAVAILABLE, details: { language: "te", enabled: ["en"] } } });
    expect(agent.startAgentSession).not.toHaveBeenCalled();
    expect(await reservations()).toBe(before);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from followup_agent_sessions where guardian_user_id = ${guardian.id}`)[0].n).toBe(sessionsBefore);

    agent.startAgentSession.mockResolvedValue({ agent_id: "agent_followup_049", conversation_token: "tok", language: "en" });
    expect((await startVoice("en")).status).toBe(201);
    expect(agent.startAgentSession).toHaveBeenCalledWith("agent_followup_049", { language: "en" });
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ELEVENLABS_FOLLOWUP_LANGUAGES", "");
  });
});
