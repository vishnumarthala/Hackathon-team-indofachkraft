// Ticket 033 FR-7 / E-2: red flags. Every red-flag code (agent tool or form `yes`) stops the check-in at once: the
// code is stored, no more answers are taken, `finish` answers `red_flag: true` with no band and no domains, and the
// page shows only the 108/112 message (no result, no providers, no `Book`). Local Supabase; synthetic data only.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKIN, RED_FLAG_CODES } from "@/lib/clinical/checkin";
import { screenClientTools, TOOL_REPLIES } from "@/lib/screen/client";
import { redFlagResult, URGENT_MESSAGE } from "@/lib/screen/questions";
import { withI18n } from "./helpers/i18n";
import { ALL_NO_RED_FLAGS, answerSet, nextIp, screenFetch, toList } from "./helpers/screen";
import { closeOpenVoiceCalls, stubGenerousVoiceLimits } from "./helpers/voice";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// 051: voice check-ins need a signed-in user (tapping stays anonymous).
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn() }),
}));

describe("red-flag view (FR-7, E-2)", () => {
  it("the urgent notice is the FR-7 message only", async () => {
    const { UrgentNotice } = await import("@/components/screen/UrgentNotice");
    const html = renderToStaticMarkup(withI18n(createElement(UrgentNotice)));
    expect(html).toContain('role="alert"');
    expect(html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'")).toBe(URGENT_MESSAGE);
    for (const word of ["Book", "specialist", "Find", "Save", "Some areas", "No strong signs"]) expect(html).not.toContain(word);
  });

  it("a red-flag result never renders a band, providers or booking", async () => {
    const { ResultView } = await import("@/components/screen/ResultView");
    const html = renderToStaticMarkup(
      withI18n(
        createElement(ResultView, {
          sessionId: "s",
          result: redFlagResult(),
          localities: [{ name: "Banjara Hills", lat: 17.41, lng: 78.44 }],
          viewer: { kind: "anonymous" },
          onSaved: () => {},
          onRestart: () => {},
        }),
      ),
    );
    expect(html).toBe("");
  });

  it("the urgent message is translated (hi/te keep 108 and 112)", async () => {
    const { UrgentNotice } = await import("@/components/screen/UrgentNotice");
    for (const locale of ["hi", "te"] as const) {
      const html = renderToStaticMarkup(withI18n(createElement(UrgentNotice), locale));
      expect(html).toContain("108");
      expect(html).toContain("112");
    }
  });

  it("a normal result shows the band headline, the not-a-diagnosis line and the recommended provider types, but no Book button", async () => {
    const { ResultView } = await import("@/components/screen/ResultView");
    const html = renderToStaticMarkup(
      withI18n(
        createElement(ResultView, {
          sessionId: "s",
          result: {
            result_band: "discuss_with_professional",
            domains: [{ domain: "speech", level: "some_signs" }],
            red_flag: false,
            message: "x",
            instrument: "ISAA_PARENT_CHECKIN",
            mchat: null,
            recommendation: {
              types: ["speech_language_pathologist", "developmental_pediatrician", "child_psychologist", "occupational_therapist"],
              reason: { kind: "concern", concern: "speech" },
            },
          },
          localities: [{ name: "Banjara Hills", lat: 17.41, lng: 78.44 }],
          viewer: { kind: "anonymous" },
          onSaved: () => {},
          onRestart: () => {},
        }),
      ),
    );
    expect(html).toContain("Some areas are worth discussing with a professional");
    expect(html).toContain("This is a developmental check-in, not a diagnosis.");
    // 048 FR-10: the bookable providers below the recommendation (slots load in the browser).
    expect(html).toContain("Book a visit near you");
    for (const type of ["developmental_pediatrician", "child_psychologist", "speech_language_pathologist", "occupational_therapist"]) {
      expect(html).toContain(`data-type="${type}"`);
    }
    expect(html).toContain("Sign in to save");
    expect(html).not.toMatch(/>Book</);
  });
});

describe.skipIf(!enabled)("red flags stop the check-in (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let voiceUser: TestUser;
  const sessions: string[] = [];
  const fetchFn = screenFetch();
  const post = (url: string, body?: unknown) =>
    fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  async function start(mode: "form" | "voice" = "form") {
    if (mode === "voice") {
      await closeOpenVoiceCalls(sql, voiceUser.id);
      session.user = voiceUser;
    }
    const res = await fetchFn("/api/screen/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ age_band: "31-71m", mode }),
    });
    session.user = null;
    const body = await res.json();
    sessions.push(body.session_id);
    return body.session_id as string;
  }

  async function expectStopped(id: string, codes: string[]) {
    const finish = await post(`/api/screen/sessions/${id}/finish`);
    expect(finish.status).toBe(200);
    const result = await finish.json();
    // 048 FR-8: a red flag still overrides everything: no band, no recommendation, no providers.
    expect(result).toEqual({
      result_band: null,
      domains: [],
      red_flag: true,
      message: URGENT_MESSAGE,
      instrument: "ISAA_PARENT_CHECKIN",
      mchat: null,
      recommendation: null,
    });
    expect((await fetchFn(`/api/screen/sessions/${id}/providers`)).status).toBe(409);
    const [row] = await sql<{ result_band: string | null; red_flag_codes: string[] }[]>`
      select result_band, red_flag_codes from screen_sessions where id = ${id}`;
    expect(row.result_band).toBeNull();
    expect(row.red_flag_codes).toEqual([...codes].sort());
    // Stopped: no more answers.
    const more = await post(`/api/screen/sessions/${id}/answers`, { answers: [{ item_id: "q1", answer: "never" }] });
    expect(more.status).toBe(409);
    expect(await more.json()).toEqual({ error: "This check-in was stopped" });
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    world = createWorld(sql, (await import("@/lib/db")).supabaseAdmin(), "t033rf");
    voiceUser = await world.user("voice", "guardian");
  });
  beforeEach(async () => {
    (await import("@/lib/screen/rate-limit")).screenSessionLimiter.reset();
    stubGenerousVoiceLimits();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!sql) return;
    if (sessions.length) await sql`delete from screen_sessions where id in ${sql(sessions)}`;
    await world.cleanup();
    await sql.end();
  });

  it.each(RED_FLAG_CODES)("agent red flag %s -> { stop: true }, stored, finish has no band", async (code) => {
    const id = await start("voice");
    await post(`/api/screen/sessions/${id}/answers`, { answers: [{ item_id: "q1", answer: "often" }] });
    const res = await post(`/api/screen/sessions/${id}/red-flag`, { code });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stop: true });
    // Reporting it twice is harmless.
    expect((await post(`/api/screen/sessions/${id}/red-flag`, { code })).status).toBe(200);
    await expectStopped(id, [code]);
  });

  it.each(CHECKIN.red_flags.map((r) => [r.id, r.code] as const))("form: %s answered yes -> stop, even with every other answer given", async (itemId, code) => {
    const id = await start();
    const answers = { ...answerSet("no_concerns"), [itemId]: "yes" };
    const res = await post(`/api/screen/sessions/${id}/answers`, { answers: toList(answers) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stop: true });
    await expectStopped(id, [code]);
  });

  it("E-2: the regression question answered yes first (red flags are asked first) -> only the 108/112 message", async () => {
    const id = await start();
    const res = await post(`/api/screen/sessions/${id}/answers`, { answers: [{ item_id: "rf_skill_regression", answer: "yes" }] });
    expect(await res.json()).toMatchObject({ stop: true });
    await expectStopped(id, ["skill_regression"]);
    // Resume shows the stopped state (the page renders UrgentNotice only).
    const view = await (await fetchFn(`/api/screen/sessions/${id}`)).json();
    expect(view).toMatchObject({ status: "stopped", result: { red_flag: true, result_band: null } });
  });

  it("several red flags are all stored", async () => {
    const id = await start("voice");
    await post(`/api/screen/sessions/${id}/red-flag`, { code: "seizure" });
    await post(`/api/screen/sessions/${id}/red-flag`, { code: "breathing" });
    await expectStopped(id, ["breathing", "seizure"]);
  });

  it("voice client tool record_red_flag stops the page before the network answers; unknown codes become safety_concern", async () => {
    const id = await start("voice");
    const events = { onStop: vi.fn(), onComplete: vi.fn() };
    const tools = screenClientTools(id, { fetchFn }, events);
    expect(await tools.record_red_flag({ code: "Self_Injury" })).toBe(TOOL_REPLIES.stop);
    expect(events.onStop).toHaveBeenCalledTimes(1);
    const id2 = await start("voice");
    const tools2 = screenClientTools(id2, { fetchFn }, events);
    expect(await tools2.record_red_flag({ code: "head banging" })).toBe(TOOL_REPLIES.stop);
    await expectStopped(id, ["self_injury"]);
    await expectStopped(id2, ["safety_concern"]);
    // A red-flag `yes` through record_answer stops too; later tool calls are told to end the call.
    const id3 = await start("voice");
    const tools3 = screenClientTools(id3, { fetchFn }, events);
    expect(await tools3.record_answer({ item_id: "rf_seizure", answer: "yes" })).toBe(TOOL_REPLIES.stop);
    expect(await tools3.record_answer({ item_id: "q1", answer: "never" })).toBe(TOOL_REPLIES.stop);
    await expectStopped(id3, ["seizure"]);
  });

  it("all red-flag questions answered no -> the check-in continues", async () => {
    const id = await start();
    const res = await post(`/api/screen/sessions/${id}/answers`, { answers: toList(ALL_NO_RED_FLAGS) });
    expect(await res.json()).toMatchObject({ stop: false, missing: CHECKIN.questions.map((q) => q.id) });
  });

  it("a red flag after the result -> 409 (the result stands; the page already shows it)", async () => {
    const id = await start();
    await post(`/api/screen/sessions/${id}/answers`, { answers: toList(answerSet("no_concerns")) });
    expect((await post(`/api/screen/sessions/${id}/finish`)).status).toBe(200);
    expect((await post(`/api/screen/sessions/${id}/red-flag`, { code: "seizure" })).status).toBe(409);
    expect((await post(`/api/screen/sessions/${id}/red-flag`, { code: "not_a_code" })).status).toBe(400);
  });
});
