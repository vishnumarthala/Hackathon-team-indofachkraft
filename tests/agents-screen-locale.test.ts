// Ticket 049: Telugu and Hindi for the check-in voice agent (screen, 033/048). Pure: the per-language prompts and first
// messages are the catalogue text (FR-2, safety and "not a diagnosis" identical to messages/{hi,te}.json), the token
// request carries the call language (FR-1), a language the agent does not have shows the FR-4 choice instead of an
// English call, and the scripted te/hi conversations make the same tool calls as English (FR-3/FR-6). Database: the
// real route in DEMO_MODE (E-1: Telugu first message and 108/112) and with ELEVENLABS_SCREEN_LANGUAGES=en (409, no
// ElevenLabs call, no voice reservation). Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoVoiceCheckin } from "@/components/screen/DemoVoiceCheckin";
import { ScreenFlow } from "@/components/screen/ScreenFlow";
import { AGENT_PROMPTS } from "@/lib/agents/prompts-all";
import { LANGUAGE_UNAVAILABLE, parseVoiceLanguages, planVoiceLanguage, toAgentTemplate, voiceOverrides } from "@/lib/agents/languages";
import { screenDemoScript } from "@/lib/agents/screen/demo";
import { screenDemoTurn, type ScreenToolCall } from "@/lib/agents/screen/demo-script";
import { RED_FLAG_CODES } from "@/lib/clinical/checkin";
import type { Locale } from "@/lib/i18n/config";
import { screenClientTools, startScreen } from "@/lib/screen/client";
import { screenQuestions, SPOKEN_AGE_BAND, URGENT_MESSAGE, type QuestionAgeBand } from "@/lib/screen/questions";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { withI18n } from "./helpers/i18n";
import { nextIp, screenReq } from "./helpers/screen";
import { closeOpenVoiceCalls, stubGenerousVoiceLimits } from "./helpers/voice";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
const agent = vi.hoisted(() => ({ startAgentSession: vi.fn() }));
vi.mock("@/lib/elevenlabs/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/elevenlabs/agent")>();
  return { ...actual, startAgentSession: agent.startAgentSession };
});
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn(), getId: () => "" }),
}));

const CATALOGUES = { en, hi, te } as const;
const LANGS = ["en", "hi", "te"] as const satisfies readonly Locale[];
const SCRIPT = /[\u0c00-\u0c7f]/; // Telugu
const DEVANAGARI = /[\u0900-\u097f]/;
const FIXTURE = JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures/voice-agents/screen.json"), "utf8")) as {
  band: QuestionAgeBand;
  expected: string[];
  complete: Record<Locale, string[]>;
  redFlagAnswer: Record<Locale, string[]>;
  redFlagSpoken: Record<Locale, string>;
};

describe("FR-2: prompts and first messages per language (screen agent)", () => {
  it.each(LANGS)("%s: first message and safety message are the catalogue text, word for word", (lang) => {
    const p = AGENT_PROMPTS.screen[lang];
    const m = CATALOGUES[lang];
    expect(p.language).toBe(lang);
    expect(p.firstMessage).toBe(toAgentTemplate(m.voiceAgents.screen.firstMessage));
    expect(p.firstMessage).toContain("{{age_band}}");
    expect(p.safetyMessage).toBe(m.screen.urgent);
    // The agent says the page's 108/112 message exactly, and the page's "not a diagnosis" sentence in the greeting.
    expect(p.systemPrompt).toContain(`say exactly: "${m.screen.urgent}"`);
    expect(p.firstMessage).toContain(m.screen.result.notDiagnosis);
  });

  it("the hi/te texts are in their script; English is the 033 safety constant", () => {
    expect(AGENT_PROMPTS.screen.en.safetyMessage).toBe(URGENT_MESSAGE);
    expect(AGENT_PROMPTS.screen.te.firstMessage).toMatch(SCRIPT);
    expect(AGENT_PROMPTS.screen.te.safetyMessage).toMatch(SCRIPT);
    expect(AGENT_PROMPTS.screen.hi.firstMessage).toMatch(DEVANAGARI);
    expect(AGENT_PROMPTS.screen.hi.safetyMessage).toMatch(DEVANAGARI);
    for (const lang of ["hi", "te"] as const) expect(AGENT_PROMPTS.screen[lang].safetyMessage).toMatch(/108.*112/);
  });

  it("the English prompt and first message are the dashboard text in docs/elevenlabs-screen-agent.md", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs/elevenlabs-screen-agent.md"), "utf8");
    expect(doc).toContain(AGENT_PROMPTS.screen.en.firstMessage);
    expect(doc).toContain(AGENT_PROMPTS.screen.en.systemPrompt);
    expect(AGENT_PROMPTS.screen.en.systemPrompt).toContain("You speak English only.");
  });

  it.each(["hi", "te"] as const)("%s: same item ids, tools, codes and variables as English; answers map to English codes", (lang) => {
    const p = AGENT_PROMPTS.screen[lang].systemPrompt;
    for (const token of ["{{questions}}", "{{age_band}}", "{{language}}", "record_answer", "record_red_flag", ...RED_FLAG_CODES]) expect(p).toContain(token);
    expect(p).toContain("never, sometimes, often, always, yes, no");
    for (const word of CATALOGUES[lang].voiceAgents.lexicon.answers.never.split(",")) expect(p).toContain(`"${word.trim()}"`);
  });

  it.each(LANGS)("%s: the spoken age bands are the catalogue's (the agent hears the band in the call language)", (lang) => {
    const bands = CATALOGUES[lang].voiceAgents.screen.ageBands;
    expect(SPOKEN_AGE_BAND[lang]).toEqual({ "18-30m": bands.m18to30, "31-71m": bands.m31to71, "6-8y": bands.y6to8 });
  });
});

describe("FR-1 / FR-4: call language", () => {
  it("languages env: English always included, unknown codes ignored, unset -> fallback", () => {
    expect(parseVoiceLanguages("te, HI ,xx", ["en"])).toEqual(["en", "hi", "te"]);
    expect(parseVoiceLanguages("en", ["en", "hi", "te"])).toEqual(["en"]);
    expect(parseVoiceLanguages(undefined, ["en"])).toEqual(["en"]);
    expect(parseVoiceLanguages("", ["en", "hi", "te"])).toEqual(["en", "hi", "te"]);
    expect(planVoiceLanguage("te", ["en", "hi", "te"])).toEqual({ kind: "native", language: "te" });
    expect(planVoiceLanguage("te", ["en"])).toEqual({ kind: "fallback", language: "en", locale: "te" });
  });

  it("the language override is sent for Hindi and Telugu only (English uses the agent's base configuration)", () => {
    expect(voiceOverrides("te")).toEqual({ overrides: { agent: { language: "te" } } });
    expect(voiceOverrides("hi")).toEqual({ overrides: { agent: { language: "hi" } } });
    expect(voiceOverrides("en")).toEqual({});
  });

  it("the token request carries the locale; a 409 language_unavailable never turns into an English call", async () => {
    const bodies: Record<string, unknown>[] = [];
    const reply = (status: number, body: unknown) =>
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
    const mic = vi.fn(async () => ({ getTracks: () => [] }));

    const ok = await startScreen(
      "31-71m",
      "voice",
      {
        fetchFn: reply(201, { session_id: "s1", questions: [], conversation_token: "tok", language: "te", dynamic_variables: { language: "te" } }),
        getMicrophone: mic,
      },
      [],
      "te",
    );
    expect(bodies[0]).toMatchObject({ age_band: "31-71m", mode: "voice", language: "te" });
    expect(ok).toMatchObject({ kind: "voice", language: "te", target: { conversationToken: "tok" } });

    const refused = await startScreen(
      "31-71m",
      "voice",
      { fetchFn: reply(409, { error: LANGUAGE_UNAVAILABLE, details: { language: "te", enabled: ["en"] } }), getMicrophone: mic },
      [],
      "te",
    );
    expect(refused).toEqual({ kind: "error", error: "languageUnavailable" });
    expect(mic).toHaveBeenCalledTimes(1);
    // Tapping never sends a language.
    await startScreen("31-71m", "form", { fetchFn: reply(201, { session_id: "s2", questions: [] }) }, [], "te");
    expect(bodies.at(-1)).not.toHaveProperty("language");
  });

  it("FR-4 (rendered): Telugu page, agent only in English -> 'Voice in English' or 'Tap in Telugu', no plain voice start", () => {
    const viewer = { kind: "guardian" as const, children: [], consentDocument: null };
    const html = renderToStaticMarkup(
      withI18n(createElement(ScreenFlow, { viewer, localities: [], voiceAvailable: true, voiceLanguages: ["en"] }), "te"),
    );
    expect(html).toContain(te.voiceAgents.fallback.tapMessage.replace("{language}", te.voiceAgents.languages.te));
    expect(html).toContain(te.voiceAgents.fallback.voiceInEnglish);
    expect(html).toContain(te.voiceAgents.fallback.tapIn.replace("{language}", te.voiceAgents.languages.te));
    expect(html).not.toContain(te.screen.startVoice);

    const native = renderToStaticMarkup(
      withI18n(createElement(ScreenFlow, { viewer, localities: [], voiceAvailable: true, voiceLanguages: ["en", "hi", "te"] }), "te"),
    );
    expect(native).toContain(te.screen.startVoice);
    expect(native).toContain(te.voiceAgents.callLanguage.replace("{language}", te.voiceAgents.languages.te));
    expect(native).not.toContain(te.voiceAgents.fallback.voiceInEnglish);
  });
});

describe("FR-3 / FR-6: scripted te/hi conversations make the same tool calls as English", () => {
  const questions = screenQuestions(FIXTURE.band);
  const callsFor = (lang: Locale, utterances: string[]): (ScreenToolCall | null)[] => {
    const script = screenDemoScript(lang, FIXTURE.band);
    return utterances.map((u, i) => screenDemoTurn(script, questions[i], u));
  };

  it("the fixture covers every question of the band", () => {
    for (const lang of LANGS) expect(FIXTURE.complete[lang]).toHaveLength(questions.length);
  });

  it.each(LANGS)("%s: a complete check-in -> record_answer with the expected English codes", (lang) => {
    const calls = callsFor(lang, FIXTURE.complete[lang]);
    expect(calls).toEqual(questions.map((q, i) => ({ tool: "record_answer", params: { item_id: q.id, answer: FIXTURE.expected[i] } })));
  });

  it("te and hi produce exactly the English calls (complete, red-flag answer, spoken red flag)", () => {
    const spoken = (lang: Locale) => screenDemoTurn(screenDemoScript(lang, FIXTURE.band), questions[6], FIXTURE.redFlagSpoken[lang]);
    for (const lang of ["hi", "te"] as const) {
      expect(callsFor(lang, FIXTURE.complete[lang])).toEqual(callsFor("en", FIXTURE.complete.en));
      expect(callsFor(lang, FIXTURE.redFlagAnswer[lang])).toEqual(callsFor("en", FIXTURE.redFlagAnswer.en));
      expect(spoken(lang)).toEqual(spoken("en"));
    }
    expect(callsFor("te", FIXTURE.redFlagAnswer.te).at(-1)).toEqual({ tool: "record_answer", params: { item_id: "rf_seizure", answer: "yes" } });
    expect(spoken("te")).toEqual({ tool: "record_red_flag", params: { code: "seizure" } });
  });

  it("through the page's client tools the te script sends the same requests as English", async () => {
    const requests = async (lang: Locale) => {
      const sent: { url: string; body: unknown }[] = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ missing: ["x"], stop: false }), { status: 200 });
      }) as typeof fetch;
      const tools = screenClientTools("sess-1", { fetchFn }, { onStop: () => {}, onComplete: () => {} });
      for (const call of callsFor(lang, [...FIXTURE.redFlagAnswer[lang].slice(0, 2)])) if (call?.tool === "record_answer") await tools.record_answer(call.params);
      const spoken = screenDemoTurn(screenDemoScript(lang, FIXTURE.band), questions[6], FIXTURE.redFlagSpoken[lang]);
      if (spoken?.tool === "record_red_flag") await tools.record_red_flag(spoken.params);
      return sent;
    };
    expect(await requests("te")).toEqual(await requests("en"));
    expect(await requests("hi")).toEqual(await requests("en"));
  });
});

describe("E-1 (rendered): the DEMO_MODE voice check-in speaks Telugu", () => {
  it("first message in Telugu with the Telugu age band; the reply buttons are Telugu answer words", () => {
    const script = screenDemoScript("te", "31-71m");
    expect(script.first_message).toBe(te.voiceAgents.screen.firstMessage.replace("{age_band}", te.voiceAgents.screen.ageBands.m31to71));
    expect(script.safety_message).toBe(te.screen.urgent);
    const questions = screenQuestions("31-71m");
    const html = renderToStaticMarkup(
      withI18n(
        createElement(DemoVoiceCheckin, {
          session: { session_id: "s", expires_at: "", questions },
          script,
          onStopped: () => {},
          onFinished: () => {},
          onContinueByTapping: () => {},
        }),
        "te",
      ),
    );
    expect(html).toContain(script.first_message);
    expect(html).toContain(te.voiceAgents.screen.demo);
    expect(html).toContain("లేదు"); // red-flag question first: yes/no in Telugu
    expect(html).toContain("అవును");
    expect(html).toContain('lang="te-IN"');
  });
});

describe.skipIf(!enabled)("screen session route in the call language (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let parent: TestUser;
  const sessions: string[] = [];

  const start = async (body: Record<string, unknown>) => {
    await closeOpenVoiceCalls(sql, parent.id);
    const { POST } = await import("@/app/api/screen/sessions/route");
    const res = await POST(screenReq("/api/screen/sessions", { age_band: "31-71m", mode: "voice", ...body }, nextIp()));
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.session_id === "string") sessions.push(json.session_id);
    return { status: res.status, body: json };
  };
  const reservations = async () => (await sql<{ n: number }[]>`select count(*)::int as n from voice_usage where user_id = ${parent.id}`)[0].n;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t049s");
    parent = await world.user("parent", "guardian");
    session.user = { id: parent.id, email: parent.email };
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    stubGenerousVoiceLimits();
    agent.startAgentSession.mockReset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sessions.length) await sql`delete from screen_sessions where id in ${sql(sessions)}`;
    await sql`delete from voice_usage where user_id = ${parent.id}`;
    await world.cleanup();
    await sql.end();
  });

  it("E-1: DEMO_MODE, Telugu -> the scripted check-in in Telugu (first message, age band, 108/112); no ElevenLabs call", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const { status, body } = await start({ language: "te" });
    expect(status).toBe(201);
    expect(body).toMatchObject({ demo: true, language: "te" });
    const script = body.demo_script as ReturnType<typeof screenDemoScript>;
    expect(script.first_message).toBe(te.voiceAgents.screen.firstMessage.replace("{age_band}", "రెండున్నర నుండి 5 సంవత్సరాల"));
    expect(script.safety_message).toBe(te.screen.urgent);
    expect(agent.startAgentSession).not.toHaveBeenCalled();

    // A red flag in the demo goes through the real red-flag route and stops the session.
    const { screenFetch } = await import("./helpers/screen");
    let stopped = false;
    const tools = screenClientTools(String(body.session_id), { fetchFn: screenFetch() }, { onStop: () => (stopped = true), onComplete: () => {} });
    const call = screenDemoTurn(script, screenQuestions("31-71m")[6], FIXTURE.redFlagSpoken.te);
    expect(call).toEqual({ tool: "record_red_flag", params: { code: "seizure" } });
    await tools.record_red_flag((call as { params: { code: "seizure" } }).params);
    expect(stopped).toBe(true);
    const [row] = await sql<{ red_flag_codes: string[]; result_band: string | null }[]>`
      select red_flag_codes, result_band from screen_sessions where id = ${String(body.session_id)}`;
    expect(row).toEqual({ red_flag_codes: ["seizure"], result_band: null });
  });

  it("live: the token is asked for the call language and the agent hears the age band in Telugu", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "agent_screen_049");
    vi.stubEnv("ELEVENLABS_SCREEN_LANGUAGES", "en,hi,te");
    agent.startAgentSession.mockResolvedValue({ agent_id: "agent_screen_049", conversation_token: "tok", language: "te" });
    const { status, body } = await start({ language: "te" });
    expect(status).toBe(201);
    expect(agent.startAgentSession).toHaveBeenCalledWith("agent_screen_049", { language: "te" });
    expect(body.language).toBe("te");
    expect(body.dynamic_variables).toMatchObject({ language: "te", age_band: SPOKEN_AGE_BAND.te["31-71m"] });
  });

  it("FR-4: language not enabled -> 409 language_unavailable before the gate: no English call, no reservation", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "agent_screen_049");
    vi.stubEnv("ELEVENLABS_SCREEN_LANGUAGES", "en");
    const before = await reservations();
    const { status, body } = await start({ language: "te" });
    expect(status).toBe(409);
    expect(body).toEqual({ error: LANGUAGE_UNAVAILABLE, details: { language: "te", enabled: ["en"] } });
    expect(agent.startAgentSession).not.toHaveBeenCalled();
    expect(await reservations()).toBe(before);

    // Unset outside DEMO_MODE: English only (the human enables hi/te after the dashboard steps).
    vi.stubEnv("ELEVENLABS_SCREEN_LANGUAGES", "");
    expect((await start({ language: "hi" })).status).toBe(409);
    // "Voice in English" is an explicit choice: it starts.
    agent.startAgentSession.mockResolvedValue({ agent_id: "agent_screen_049", conversation_token: "tok", language: "en" });
    const english = await start({ language: "en" });
    expect(english.status).toBe(201);
    expect(agent.startAgentSession).toHaveBeenCalledWith("agent_screen_049", { language: "en" });
  });
});
