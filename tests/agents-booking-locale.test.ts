// Ticket 049: Telugu and Hindi for the voice booking agent on /find (034). Pure: prompts and first messages per
// language (FR-2), tool parameters stay codes and English place names (FR-3), the DEMO_MODE scripted conversation in
// te/hi makes exactly the English tool calls (FR-6), and E-2: with ELEVENLABS_BOOKING_LANGUAGES=en a Telugu page offers
// "Voice in English" or "Tap in Telugu". Database: the session route asks for the call language and refuses a language
// the agent does not have (409, no ElevenLabs call, no reservation). Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingWidget } from "@/components/voice/BookingWidget";
import { bookingDemoScript } from "@/lib/agents/booking/demo";
import { DEMO_LINES, EN_BOOKING_DEMO, runDemoScript, type ToolCaller } from "@/lib/agents/booking/demo-script";
import { LANGUAGE_UNAVAILABLE, toAgentTemplate } from "@/lib/agents/languages";
import { AGENT_PROMPTS } from "@/lib/agents/prompts-all";
import type { Locale } from "@/lib/i18n/config";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { withI18n } from "./helpers/i18n";
import { nextIp } from "./helpers/screen";
import { closeOpenVoiceCalls, stubGenerousVoiceLimits } from "./helpers/voice";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string }, cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
const agent = vi.hoisted(() => ({ startAgentSession: vi.fn() }));
vi.mock("@/lib/elevenlabs/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/elevenlabs/agent")>();
  return { ...actual, startAgentSession: agent.startAgentSession };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    getAll: () => [...session.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => session.cookies.has(name),
    set: () => {},
  }),
  headers: async () => ({ get: () => null }),
}));

const CATALOGUES = { en, hi, te } as const;
const LANGS = ["en", "hi", "te"] as const satisfies readonly Locale[];

describe("FR-2: prompts and first messages per language (booking agent)", () => {
  it.each(LANGS)("%s: first message, safety message and the on-screen button label come from the catalogue", (lang) => {
    const p = AGENT_PROMPTS.booking[lang];
    const m = CATALOGUES[lang];
    expect(p.firstMessage).toBe(toAgentTemplate(m.voiceAgents.booking.firstMessage));
    expect(p.safetyMessage).toBe(m.screen.urgent);
    expect(p.systemPrompt).toContain(`say exactly: "${m.screen.urgent}"`);
    expect(p.systemPrompt).toContain(`tap "${m.voiceBooking.confirm}" on your screen`);
  });

  it("the English prompt and first message are the dashboard text in docs/elevenlabs-booking-agent.md", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs/elevenlabs-booking-agent.md"), "utf8");
    expect(doc).toContain(AGENT_PROMPTS.booking.en.firstMessage);
    expect(doc).toContain(AGENT_PROMPTS.booking.en.systemPrompt);
  });

  it.each(["hi", "te"] as const)("%s: same tools and codes; place names and parameters stay English (FR-3)", (lang) => {
    const p = AGENT_PROMPTS.booking[lang].systemPrompt;
    for (const token of ["search_providers", "get_slots", "hold_slot", "record_red_flag", "{{booking_session}}", "{{today}}", "{{language}}", "demo_acknowledged", "speech_language_pathologist", "in_clinic"]) {
      expect(p).toContain(token);
    }
    expect(p).toContain(`Banjara Hills = "${CATALOGUES[lang].voiceAgents.lexicon.localities.banjaraHills.split(",")[0]}"`);
    expect(p).toContain(`read exactly "${CATALOGUES[lang].voiceAgents.booking.demo.demoNotice}"`);
  });

  it("the browser's English demo script is the en catalogue (no catalogue bundled into /find)", () => {
    const { types, modes, partsOfDay, choices, localities, answers } = en.voiceAgents.lexicon;
    expect(EN_BOOKING_DEMO).toEqual({ ...bookingDemoScript("en") });
    expect(EN_BOOKING_DEMO.lexicon).toEqual({ answers, types, modes, partsOfDay, choices, localities });
    expect(DEMO_LINES.greeting).toBe(en.voiceAgents.booking.firstMessage);
  });
});

describe("FR-3 / FR-6: the scripted te/hi booking conversations make the same tool calls as English", () => {
  const SLOT_START = "2026-11-16T04:30:00.000Z";
  const fakeTools = () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    let held = 0;
    const callTool: ToolCaller = async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "search_providers") {
        return {
          status: 200,
          json: {
            results: [
              { profile_id: "p-1", name: "Speech Centre (Demo)", locality: "Banjara Hills", distance_km: 1.2, modes: ["in_clinic", "video"] },
              { profile_id: "p-2", name: "Dr Rao (synthetic)", locality: "Ameerpet", distance_km: 3.4, modes: ["in_clinic"] },
            ],
          },
        };
      }
      if (tool === "get_slots") {
        return { status: 200, json: { slots: [{ service_id: "svc-1", start: SLOT_START, local_time: "Mon 16 Nov, 10:00" }, { service_id: "svc-1", start: "2026-11-16T05:30:00.000Z", local_time: "Mon 16 Nov, 11:00" }] } };
      }
      held += 1;
      return held === 1
        ? { status: 200, json: { held: false, reason: "demo_ack_required" } }
        : { status: 200, json: { held: true, appointment_id: "appt-1", payment_mode: "online", fee_inr: 600 } };
    };
    return { calls, callTool };
  };
  const run = async (lang: Locale) => {
    const { calls, callTool } = fakeTools();
    const said: { role: string; text: string }[] = [];
    const outcome = await runDemoScript({
      bookingSession: "s".repeat(43),
      today: "Friday 2026-11-13",
      callTool,
      script: bookingDemoScript(lang),
      say: (role, text) => void said.push({ role, text }),
    });
    return { outcome, calls, said };
  };

  it("English: the expected codes (034's demo calls)", async () => {
    const { outcome, calls } = await run("en");
    expect(outcome).toEqual({ kind: "held", appointment_id: "appt-1", profile_id: "p-1" });
    const booking_session = "s".repeat(43);
    expect(calls).toEqual([
      { tool: "search_providers", args: { booking_session, locality_text: "Banjara Hills", type: "speech_language_pathologist", mode: "in_clinic" } },
      { tool: "get_slots", args: { booking_session, profile_id: "p-1", service_mode: "in_clinic", date_from: "2026-11-13", part_of_day: "morning" } },
      { tool: "hold_slot", args: { booking_session, profile_id: "p-1", service_id: "svc-1", start: SLOT_START } },
      { tool: "hold_slot", args: { booking_session, profile_id: "p-1", service_id: "svc-1", start: SLOT_START, demo_acknowledged: true } },
    ]);
  });

  it.each(["hi", "te"] as const)("%s: identical tool calls; the agent's lines are in the call language", async (lang) => {
    const english = await run("en");
    const local = await run(lang);
    expect(local.calls).toEqual(english.calls);
    expect(local.outcome).toEqual(english.outcome);
    const m = CATALOGUES[lang].voiceAgents.booking;
    expect(local.said[0]).toEqual({ role: "agent", text: m.firstMessage });
    expect(local.said[1].text).toBe(m.demo.parentAsk.replace("{area}", CATALOGUES[lang].voiceAgents.lexicon.localities.banjaraHills.split(",")[0]));
    expect(local.said.map((l) => l.text)).toContain(m.demo.demoNotice);
    expect(local.said.at(-1)?.text).toBe(
      m.demo.heldOnline.replace("{time}", "Mon 16 Nov, 10:00").replace("{name}", "Speech Centre (Demo)").replace("{fee}", "600"),
    );
  });
});

describe("E-2 (rendered): ELEVENLABS_BOOKING_LANGUAGES=en and the UI in Telugu", () => {
  it("the voice booking widget offers 'Voice in English' or 'Tap in Telugu', not a plain Telugu voice start", () => {
    const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    const html = renderToStaticMarkup(withI18n(createElement(BookingWidget, { signedIn: true, voiceLanguages: ["en"] }), "te"));
    expect(html).toContain(te.voiceAgents.fallback.tapMessage.replace("{language}", "తెలుగు"));
    expect(buttons(html)).toEqual([te.voiceAgents.fallback.voiceInEnglish, te.voiceAgents.fallback.tapIn.replace("{language}", "తెలుగు")]);
    // In English the wording of the rd: "Voice is available in English. You can also answer by tapping in Telugu."
    expect(en.voiceAgents.fallback.tapMessage.replace("{language}", en.voiceAgents.languages.te)).toBe(
      "Voice is available in English. You can also answer by tapping in Telugu.",
    );
    const native = renderToStaticMarkup(withI18n(createElement(BookingWidget, { signedIn: true, voiceLanguages: ["en", "hi", "te"] }), "te"));
    expect(buttons(native)).toEqual([te.voiceBooking.button]);
    expect(native).not.toContain(te.voiceAgents.fallback.voiceInEnglish);
  });
});

describe.skipIf(!enabled)("booking session route in the call language (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let parent: TestUser;

  const start = async (body?: Record<string, unknown>) => {
    await closeOpenVoiceCalls(sql, parent.id);
    const { POST } = await import("@/app/api/agents/booking/session/route");
    const res = await POST(
      new Request("http://localhost/api/agents/booking/session", {
        method: "POST",
        headers: { "x-forwarded-for": nextIp(), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const reservations = async () => (await sql<{ n: number }[]>`select count(*)::int as n from voice_usage where user_id = ${parent.id}`)[0].n;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t049b");
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
    await sql`delete from voice_usage where user_id = ${parent.id}`;
    await world.cleanup();
    await sql.end();
  });

  it("DEMO_MODE, Telugu: the scripted conversation in Telugu; English is still the default without a body", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const telugu = await start({ language: "te" });
    expect(telugu.status).toBe(201);
    expect(telugu.body).toMatchObject({ demo: true, language: "te", dynamic_variables: { language: "te" } });
    expect(telugu.body.demo_script).toEqual(bookingDemoScript("te"));
    const plain = await start();
    expect(plain.status).toBe(201);
    expect(plain.body.language).toBe("en");
    expect(agent.startAgentSession).not.toHaveBeenCalled();
  });

  it("E-2 / FR-4: ELEVENLABS_BOOKING_LANGUAGES=en + Telugu -> 409 before ElevenLabs and the quota; English starts", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_BOOKING_AGENT_ID", "agent_booking_049");
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", "t049-secret");
    vi.stubEnv("ELEVENLABS_BOOKING_LANGUAGES", "en");
    const before = await reservations();
    const refused = await start({ language: "te" });
    expect(refused).toEqual({ status: 409, body: { error: LANGUAGE_UNAVAILABLE, details: { language: "te", enabled: ["en"] } } });
    expect(agent.startAgentSession).not.toHaveBeenCalled();
    expect(await reservations()).toBe(before);

    agent.startAgentSession.mockResolvedValue({ agent_id: "agent_booking_049", conversation_token: "tok", language: "en" });
    const english = await start({ language: "en" });
    expect(english.status).toBe(201);
    expect(agent.startAgentSession).toHaveBeenCalledWith("agent_booking_049", { language: "en" });

    vi.stubEnv("ELEVENLABS_BOOKING_LANGUAGES", "en,te");
    agent.startAgentSession.mockResolvedValue({ agent_id: "agent_booking_049", conversation_token: "tok", language: "te" });
    const telugu = await start({ language: "te" });
    expect(telugu.status).toBe(201);
    expect(agent.startAgentSession).toHaveBeenLastCalledWith("agent_booking_049", { language: "te" });
    expect(telugu.body).toMatchObject({ language: "te", dynamic_variables: { language: "te" } });
  });
});
