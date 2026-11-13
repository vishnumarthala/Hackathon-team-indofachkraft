// Ticket 033: public developmental check-in. Question list per age band, band computation for synthetic answer sets
// per age band (server-side 024 scorer), session expiry, the 5-per-hour rate limit, `screen_sessions` columns (no
// free text, no IP), voice start (DEMO_MODE / token / no agent), the voice client tools against the real routes
// (E-3: same result as the form), saving to a child (401 / 404 / 422 consent / strict audit), the 30-day retention
// rule, the privacy registry and the /screen CSP. DB suites need the local Supabase stack. Synthetic data only.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKIN } from "@/lib/clinical/checkin";
import { familyCsp, needsFamilyCsp } from "@/lib/csp";
import { isPublicApiPath, postSignInPath } from "@/lib/auth-access";
import { REGISTRY } from "@/lib/privacy/registry";
import { BANNED_SCRIPT_HOSTS, scriptAllowed } from "@/lib/privacy/third-party-allowlist";
import { screenClientTools, startScreen, TOOL_REPLIES } from "@/lib/screen/client";
import {
  agentQuestionList,
  domainLevel,
  LEGACY_AGE_BANDS,
  missingScreenItems,
  QUESTION_AGE_BANDS,
  screenQuestions,
  URGENT_MESSAGE,
} from "@/lib/screen/questions";
import { withI18n } from "./helpers/i18n";
import { purgeTestAudit } from "./helpers/audit";
import { answerSet, nextIp, screenFetch, screenReq, toList } from "./helpers/screen";
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

const ROOT = process.cwd();

// ---------- pure ----------

describe("question set per age band (FR-1, FR-3)", () => {
  // 048: the question bands, plus 033's old bands (stored check-ins keep them and still render).
  it.each([...QUESTION_AGE_BANDS, ...LEGACY_AGE_BANDS])("%s: red-flag questions first, then the 024 questions for the band", (band) => {
    const qs = screenQuestions(band);
    expect(qs.slice(0, CHECKIN.red_flags.length).every((q) => q.kind === "red_flag")).toBe(true);
    expect(qs.slice(CHECKIN.red_flags.length).map((q) => q.id)).toEqual(CHECKIN.questions.map((q) => q.id));
    expect(qs[0]).toMatchObject({ id: "rf_skill_regression", code: "skill_regression", answers: ["no", "yes"] });
    expect(missingScreenItems(qs, {})).toHaveLength(qs.length);
  });

  it("the agent's {{questions}} list is numbered, carries the item ids and puts the red flags first", () => {
    const list = agentQuestionList(screenQuestions("31-71m")).split("\n");
    expect(list).toHaveLength(21);
    expect(list[0]).toBe(`1. [rf_skill_regression] (red flag, yes/no) ${CHECKIN.red_flags[0].text_en}`);
    expect(list[6]).toMatch(/^7\. \[q1\] \(never\/sometimes\/often\/always\) /);
  });

  it("domain levels (draft thresholds at the band proportions 10/45 and 20/45)", () => {
    expect(domainLevel({ points: 0, max: 9 })).toBe("few_signs");
    expect(domainLevel({ points: 1, max: 9 })).toBe("few_signs");
    expect(domainLevel({ points: 2, max: 9 })).toBe("some_signs");
    expect(domainLevel({ points: 3, max: 9 })).toBe("some_signs");
    expect(domainLevel({ points: 4, max: 9 })).toBe("more_signs");
    expect(domainLevel({ points: 1, max: 6 })).toBe("few_signs");
    expect(domainLevel({ points: 2, max: 6 })).toBe("some_signs");
    expect(domainLevel({ points: 3, max: 6 })).toBe("more_signs");
    expect(domainLevel({ points: 0, max: 0 })).toBe("few_signs");
  });

  it("FR-7 copy and routing helpers", () => {
    expect(URGENT_MESSAGE).toBe(
      "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.",
    );
    expect(isPublicApiPath("/api/screen/sessions")).toBe(true);
    expect(isPublicApiPath("/api/screen/sessions/x/finish")).toBe(true);
    expect(isPublicApiPath("/api/family/screen-results")).toBe(false);
    expect(postSignInPath("guardian", "/screen")).toBe("/screen");
    expect(postSignInPath("provider", "/screen")).toBe("/screen");
  });
});

describe("/screen page chrome (FR-2, NFR-1)", () => {
  it("renders the copy; the tap start is disabled until an age is chosen and the box is ticked (051: voice needs sign-in)", async () => {
    const { ScreenFlow } = await import("@/components/screen/ScreenFlow");
    const html = renderToStaticMarkup(
      withI18n(createElement(ScreenFlow, { viewer: { kind: "anonymous" }, localities: [], voiceAvailable: true })),
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Developmental check-in");
    expect(html).toContain(
      "About 5 minutes, for children up to 8 years. This is a developmental check-in, not a diagnosis. Only a qualified professional can assess your child.",
    );
    expect(html).toContain(
      // 049: the call language is shown next to the voice button (en/hi/te), not in the disclosure.
      "You will talk to an AI assistant. Your voice is processed by ElevenLabs (USA) and is not stored by DoctorNearMe.",
    );
    expect(html).toContain("I understand this is not a diagnosis and agree to talk to an AI assistant.");
    for (const label of ["Under 18 months", "18-30 months", "2½-5 years", "6-8 years", "9 years or older", "Child&#x27;s age"]) expect(html).toContain(label);
    for (const old of ["18-36 months", "10+ years"]) expect(html).not.toContain(old);
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];
    const form = buttons.find((b) => b[1] === "Start free check-in");
    expect(form?.[0]).toContain("disabled");
    // 051 FR-1: anonymous visitors get no voice button, only the free sign-in link back to the voice step.
    expect(buttons.find((b) => b[1] === "Start voice check-in")).toBeUndefined();
    expect(html).toContain("Prefer to talk? Sign in to use voice (free)");
    expect(html).toContain('href="/family/login?next=%2Fscreen%3Fvoice%3D1"');
    const signedIn = renderToStaticMarkup(
      withI18n(createElement(ScreenFlow, { viewer: { kind: "other" }, localities: [], voiceAvailable: true, voiceIntent: true })),
    );
    const voice = [...signedIn.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].find((b) => b[1] === "Start voice check-in");
    expect(voice?.[0]).toContain("disabled");
    expect(signedIn).toContain("You are signed in. Choose your child&#x27;s age, tick the box and start the voice check-in.");
    expect(signedIn).not.toContain("Sign in to use voice");
    // No booking anywhere before a result exists.
    expect(html).not.toMatch(/>Book</);
  });

  it("the Hindi chrome is translated (questions stay English)", async () => {
    const { ScreenFlow } = await import("@/components/screen/ScreenFlow");
    const html = renderToStaticMarkup(
      withI18n(createElement(ScreenFlow, { viewer: { kind: "anonymous" }, localities: [], voiceAvailable: true }), "hi"),
    );
    expect(html).toContain("विकास जाँच");
    expect(html).toContain("निदान नहीं");
  });

  it("CSP: /screen gets the strict nonce policy with only the ElevenLabs endpoints added", () => {
    expect(needsFamilyCsp("/screen")).toBe(true);
    expect(needsFamilyCsp("/find")).toBe(false);
    const csp = familyCsp({ pathname: "/screen", nonce: "n", supabaseUrl: "http://127.0.0.1:54321", isDev: false });
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src "))!;
    expect(connect).toContain("wss://livekit.rtc.elevenlabs.io");
    expect(connect).toContain("https://api.elevenlabs.io");
    expect(csp).toContain("script-src 'self' 'nonce-n' 'strict-dynamic'");
    const family = familyCsp({ pathname: "/family/children", nonce: "n", isDev: false });
    expect(family).not.toContain("elevenlabs");
    expect(scriptAllowed("https://elevenlabs.io/sdk.js", "/screen", "http://localhost:3000")).toBe(true);
    expect(scriptAllowed("https://www.googletagmanager.com/gtm.js", "/screen", "http://localhost:3000")).toBe(false);
  });

  it("NFR-1: no external <script>, next/script or tracker code in the /screen module graph", () => {
    const seen = new Set<string>();
    const queue = [path.join(ROOT, "app/screen/page.tsx")];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:import|export)\s[^'"]*?from\s+["'](@\/[^"']+|\.[^"']+)["']/g)) {
        const base = m[1].startsWith("@/") ? path.join(ROOT, m[1].slice(2)) : path.resolve(path.dirname(file), m[1]);
        const hit = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((c) => existsSync(c) && statSync(c).isFile());
        if (hit) queue.push(hit);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const file of seen) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(ROOT, file);
      if (rel === "lib/privacy/third-party-allowlist.ts") continue;
      // 051: the one approved loader for the allowlisted Cloudflare Turnstile script (lib/csp.ts, allowlist).
      if (rel === "components/security/Turnstile.tsx") continue;
      if (/from\s+["']next\/script["']/.test(source)) problems.push(`${rel}: next/script`);
      if (/<script[^>]*\bsrc\s*=/i.test(source)) problems.push(`${rel}: <script src>`);
      if (/createElement\(\s*["']script["']\s*\)/.test(source)) problems.push(`${rel}: injected script`);
      if (/^\s*["']use client["']/m.test(source)) for (const host of BANNED_SCRIPT_HOSTS) if (source.includes(host)) problems.push(`${rel}: ${host}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("agent setup guide (E-5)", () => {
  it("docs/elevenlabs-screen-agent.md has the no-PII rules, red flags first, the fixed safety message, tools and env var", () => {
    const doc = readFileSync(path.join(ROOT, "docs/elevenlabs-screen-agent.md"), "utf8");
    expect(doc).toContain("DoctorNearMe Developmental Check-in");
    expect(doc).toMatch(/Never ask for the child's or (the )?parent's name, date of birth, phone number, address or school/);
    expect(doc).toContain("do not repeat them");
    expect(doc).toContain("The red-flag (safety) questions come first.");
    // The fixed safety message in the prompt is exactly the page's FR-7 message.
    expect(doc.split(URGENT_MESSAGE).length - 1).toBeGreaterThanOrEqual(2);
    expect(doc).toContain("Never say whether the child has autism");
    for (const name of ["record_answer", "record_red_flag", "item_id", "{{screen_session_id}}", "{{age_band}}", "{{questions}}", "ELEVENLABS_SCREEN_AGENT_ID", "360"]) {
      expect(doc).toContain(name);
    }
    for (const code of ["skill_regression", "self_injury", "seizure", "breathing", "not_eating_drinking", "safety_concern"]) expect(doc).toContain(code);
  });
});

describe("voice start without a database (FR-4)", () => {
  beforeEach(async () => {
    (await import("@/lib/screen/rate-limit")).screenSessionLimiter.reset();
    agent.startAgentSession.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("voice outside DEMO_MODE without ELEVENLABS_SCREEN_AGENT_ID -> 503 before anything is stored", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "");
    const { POST } = await import("@/app/api/screen/sessions/route");
    const res = await POST(screenReq("/api/screen/sessions", { age_band: "31-71m", mode: "voice" }));
    expect(res.status).toBe(503);
    expect(agent.startAgentSession).not.toHaveBeenCalled();
  });

  it("051 FR-1: anonymous voice -> 401 sign_in_required before ElevenLabs; tapping stays anonymous", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "agent_screen_test");
    session.user = null;
    const { POST } = await import("@/app/api/screen/sessions/route");
    const res = await POST(screenReq("/api/screen/sessions", { age_band: "31-71m", mode: "voice" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign_in_required" });
    expect(agent.startAgentSession).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const { POST } = await import("@/app/api/screen/sessions/route");
    expect((await POST(screenReq("/api/screen/sessions", { age_band: "2y", mode: "form" }))).status).toBe(400);
    expect((await POST(screenReq("/api/screen/sessions", { age_band: "31-71m", mode: "phone" }))).status).toBe(400);
    // 048 FR-1: bands without questions and 033's old bands start no session.
    for (const age_band of ["under-18m", "9y+", "10y+", "3-5y"]) {
      expect((await POST(screenReq("/api/screen/sessions", { age_band, mode: "form" }))).status, age_band).toBe(400);
    }
    expect((await POST(screenReq("/api/screen/sessions", { age_band: "31-71m", mode: "form", concerns: ["my son Ravi"] }))).status).toBe(400);
  });

  it("startScreen maps answers: demo -> no microphone, no SDK; mic refused -> continue by tapping", async () => {
    const getMicrophone = vi.fn(async () => ({}));
    const json = (body: unknown, status = 201) => async () => new Response(JSON.stringify(body), { status });
    const session = { session_id: "s", expires_at: "x", questions: [] };
    expect(await startScreen("31-71m", "voice", { fetchFn: json({ ...session, demo: true }) as unknown as typeof fetch, getMicrophone })).toMatchObject({ kind: "demo" });
    expect(getMicrophone).not.toHaveBeenCalled();
    const denied = await startScreen("31-71m", "voice", {
      fetchFn: json({ ...session, conversation_token: "tok" }) as unknown as typeof fetch,
      getMicrophone: async () => {
        throw new Error("NotAllowedError");
      },
    });
    expect(denied.kind).toBe("micDenied");
    const voice = await startScreen("31-71m", "voice", {
      fetchFn: json({ ...session, conversation_token: "tok", dynamic_variables: { age_band: "31-71m" } }) as unknown as typeof fetch,
      getMicrophone,
    });
    expect(voice).toMatchObject({ kind: "voice", target: { conversationToken: "tok" }, dynamicVariables: { age_band: "31-71m" } });
    expect(await startScreen("31-71m", "form", { fetchFn: json({ error: "x" }, 429) as unknown as typeof fetch })).toEqual({ kind: "error", error: "busy" });
    expect(await startScreen("31-71m", "voice", { fetchFn: json({ error: "x" }, 503) as unknown as typeof fetch })).toEqual({ kind: "error", error: "voiceUnavailable" });
  });
});

// ---------- database ----------

describe.skipIf(!enabled)("check-in sessions (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let guardianA: TestUser;
  let guardianB: TestUser;
  let guardianC: TestUser;
  let provider: TestUser;
  let childA: string;
  let childB: string;
  let childC: string;
  let linkA: string;
  const sessions: string[] = [];
  const fetchFn = screenFetch();

  async function start(age_band: string, mode: "form" | "voice" = "form", ip = nextIp()) {
    // 051: voice needs a signed-in user (one open call at a time); tapping stays anonymous.
    if (mode === "voice") {
      await closeOpenVoiceCalls(sql, provider.id);
      session.user = { id: provider.id, email: provider.email };
    }
    const res = await fetchFn("/api/screen/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ age_band, mode }),
    });
    const body = await res.json();
    session.user = null;
    if (res.status === 201) sessions.push(body.session_id);
    return { status: res.status, body };
  }
  const post = (url: string, body?: unknown) =>
    fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const answer = (id: string, answers: Record<string, string>) => post(`/api/screen/sessions/${id}/answers`, { answers: toList(answers) });
  const finish = (id: string) => post(`/api/screen/sessions/${id}/finish`);

  async function finishedSession(pattern: Parameters<typeof answerSet>[0] = "some_concerns", band = "31-71m") {
    const { body } = await start(band);
    expect((await answer(body.session_id, answerSet(pattern))).status).toBe(200);
    expect((await finish(body.session_id)).status).toBe(200);
    return body.session_id as string;
  }

  async function saveAs(user: TestUser | null, body: unknown) {
    session.user = user ? { id: user.id, email: user.email } : null;
    const { POST } = await import("@/app/api/family/screen-results/route");
    return POST(new Request("http://localhost/api/family/screen-results", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t033");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    guardianC = await world.user("guardian-c", "guardian", { phoneVerified: true });
    provider = await world.user("provider", "provider");
    const child = async (u: TestUser, name: string) => {
      const [row] = await sql<{ id: string }[]>`
        select public.create_guardian_child(${u.id}::uuid, ${`${name} (synthetic)`}, '2022-03-01'::date, null, 'mother') as id`;
      world.trackChild(row.id);
      return row.id;
    };
    childA = await child(guardianA, "t033 Child A");
    childB = await child(guardianB, "t033 Child B");
    childC = await child(guardianC, "t033 Child C");
    [{ id: linkA }] = await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childA} and user_id = ${guardianA.id}`;
  });

  beforeEach(async () => {
    (await import("@/lib/screen/rate-limit")).screenSessionLimiter.reset();
    agent.startAgentSession.mockReset();
    session.user = null;
    stubGenerousVoiceLimits();
  });
  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (!sql) return;
    const ids = [...sessions];
    await sql`delete from screen_sessions where id in ${sql(ids.length ? ids : ["00000000-0000-4000-8000-000000000000"])} or saved_child_id in ${sql([childA, childB, childC])}`;
    await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action = 'screen.result_saved' and child_id in ${tx([childA, childB, childC])}`);
    await purgeTestAudit(sql, (tx) => tx`delete from audit_events where child_id in ${tx([childA, childB, childC])}`);
    await world.cleanup();
    await sql.end();
  });

  it("E-4.1 / FR-5: screen_sessions has exactly the FR-5 columns (no IP, no names, no free text)", async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'screen_sessions'
      order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "id",
      "created_at",
      "expires_at",
      "age_band",
      "mode",
      "answers",
      "result_band",
      "red_flag_codes",
      "conversation_id",
      "saved_child_id",
      "saved_by",
      // 048: the instrument used and the parent's worries (codes only).
      "instrument",
      "concerns",
    ]);
    // Free text cannot get in: answers only hold item ids -> scale values; the other text columns are enums/ids.
    const insert = (answers: unknown) => sql`insert into screen_sessions (age_band, mode, answers) values ('31-71m', 'form', ${sql.json(answers as never)}) returning id`;
    await expect(insert({ q1: "My son Ravi, 12 Main Road" })).rejects.toThrow(/screen_answers_valid|check constraint/);
    await expect(insert({ name: "never" })).rejects.toThrow(/check constraint/);
    await expect(insert({ q1: 3 })).rejects.toThrow(/check constraint/);
    await expect(sql`insert into screen_sessions (age_band, mode, conversation_id) values ('31-71m', 'voice', 'Ravi Kumar 98765')`).rejects.toThrow(/check constraint/);
    await expect(sql`insert into screen_sessions (age_band, mode) values ('3 years old', 'form')`).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into screen_sessions (age_band, mode, result_band, red_flag_codes) values ('31-71m', 'form', 'no_strong_signs', '{seizure}')`,
    ).rejects.toThrow(/screen_sessions_red_flag_no_band/);
    // RLS: browsers (anon/authenticated) have no access at all.
    const [grants] = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
      where table_name = 'screen_sessions' and grantee in ('anon', 'authenticated')`;
    expect(grants.n).toBe(0);
  });

  it("FR-4: a form session stores only the age band and mode; 2-hour expiry", async () => {
    const { status, body } = await start("18-30m");
    expect(status).toBe(201);
    expect(body.questions).toHaveLength(21);
    expect(body).not.toHaveProperty("conversation_token");
    expect(body).not.toHaveProperty("demo");
    const [row] = await sql`select *, extract(epoch from expires_at - created_at)::int as ttl from screen_sessions where id = ${body.session_id}`;
    expect(row).toMatchObject({
      age_band: "18-30m",
      mode: "form",
      answers: {},
      result_band: null,
      red_flag_codes: [],
      saved_child_id: null,
      ttl: 7200,
      // 048: MCHAT_LICENSED is off by default -> the ISAA-derived items; no worries chosen.
      instrument: "ISAA_PARENT_CHECKIN",
      concerns: [],
    });
  });

  it.each([
    ["18-30m", "no_concerns", "no_strong_signs"],
    ["31-71m", "some_concerns", "discuss_with_professional"],
    ["6-8y", "many_concerns", "see_professional_soon"],
    ["6-8y", "some_concerns", "discuss_with_professional"],
    ["31-71m", "no_concerns", "no_strong_signs"],
  ] as const)("band per age band: %s with %s -> %s (server-side 024 scorer)", async (band, pattern, expected) => {
    const { body } = await start(band);
    const res = await answer(body.session_id, answerSet(pattern));
    expect(await res.json()).toEqual({ missing: [], stop: false });
    const done = await finish(body.session_id);
    expect(done.status).toBe(200);
    const result = await done.json();
    expect(result.result_band).toBe(expected);
    expect(result.red_flag).toBe(false);
    expect(result.message).toBe(CHECKIN.result_copy[expected]);
    expect(result.message).toContain("This is a developmental check-in, not a diagnosis.");
    expect(result.domains.map((d: { domain: string }) => d.domain)).toEqual(CHECKIN.domains.map((d) => d.id));
    const [row] = await sql`select result_band from screen_sessions where id = ${body.session_id}`;
    expect(row.result_band).toBe(expected);
    // Finishing again is idempotent; answering a finished check-in is not allowed.
    expect(await (await finish(body.session_id)).json()).toEqual(result);
    expect((await answer(body.session_id, { q1: "never" })).status).toBe(409);
  });

  it("finish before every question is answered -> 422 with the missing ids; unknown items -> 400", async () => {
    const { body } = await start("31-71m");
    await answer(body.session_id, { q1: "never", rf_seizure: "no" });
    const res = await finish(body.session_id);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.details.missing).toContain("q2");
    expect(json.details.missing).not.toContain("q1");
    expect((await answer(body.session_id, { q99: "never" })).status).toBe(400);
    expect((await answer(body.session_id, { q1: "yes" })).status).toBe(400);
    expect((await answer(body.session_id, { rf_seizure: "often" })).status).toBe(400);
    expect((await post(`/api/screen/sessions/${body.session_id}/answers`, { answers: [{ item_id: "q1", answer: "my child is 3" }] })).status).toBe(400);
    expect((await finish("not-a-uuid")).status).toBe(404);
    expect((await finish("00000000-0000-4000-8000-000000000033")).status).toBe(404);
  });

  it("FR-4: sessions expire after 2 h (answers, red flag, finish, resume -> 410)", async () => {
    const { body } = await start("31-71m");
    await sql`update screen_sessions set expires_at = now() - interval '1 second' where id = ${body.session_id}`;
    expect((await answer(body.session_id, { q1: "never" })).status).toBe(410);
    expect((await post(`/api/screen/sessions/${body.session_id}/red-flag`, { code: "seizure" })).status).toBe(410);
    expect((await finish(body.session_id)).status).toBe(410);
    expect((await fetchFn(`/api/screen/sessions/${body.session_id}`)).status).toBe(410);
  });

  it("FR-4: 5 new sessions per IP per hour (hashed key, nothing stored)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) expect((await start("31-71m", "form", ip)).status).toBe(201);
    const blocked = await start("31-71m", "form", ip);
    expect(blocked.status).toBe(429);
    expect((await start("31-71m", "form", nextIp())).status).toBe(201);
    const { screenSessionLimiter, rateKey } = await import("@/lib/screen/rate-limit");
    const key = rateKey(screenReq("/x", undefined, ip));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(ip);
    expect(screenSessionLimiter.allow(key, Date.now() + 61 * 60_000)).toBe(true);
  });

  it("E-3: DEMO_MODE voice -> { demo: true }, no ElevenLabs call", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const { status, body } = await start("31-71m", "voice");
    expect(status).toBe(201);
    expect(body.demo).toBe(true);
    expect(body).not.toHaveProperty("conversation_token");
    expect(agent.startAgentSession).not.toHaveBeenCalled();
  });

  it("FR-3/FR-4: live voice -> token for ELEVENLABS_SCREEN_AGENT_ID and only non-identifying dynamic variables", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "agent_screen_test");
    agent.startAgentSession.mockResolvedValue({ agent_id: "agent_screen_test", conversation_token: "tok_test" });
    const { status, body } = await start("6-8y", "voice");
    expect(status).toBe(201);
    expect(agent.startAgentSession).toHaveBeenCalledWith("agent_screen_test", { language: "en" });
    expect(body.conversation_token).toBe("tok_test");
    expect(Object.keys(body.dynamic_variables).sort()).toEqual(["age_band", "language", "questions", "screen_session_id"]);
    // 048 FR-9: the new bands, as the agent says them.
    expect(body.dynamic_variables).toMatchObject({ screen_session_id: body.session_id, age_band: "6 to 8 years" });
    expect(body.dynamic_variables.questions).toBe(agentQuestionList(screenQuestions("6-8y")));
  });

  it("provider failure -> 502, and the voice reservation is released", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_SCREEN_AGENT_ID", "agent_screen_test");
    agent.startAgentSession.mockRejectedValue(new Error("boom"));
    const before = await sql`select count(*)::int as n from voice_usage where user_id = ${provider.id}`;
    expect((await start("31-71m", "voice")).status).toBe(502);
    const after = await sql`select count(*)::int as n from voice_usage where user_id = ${provider.id}`;
    expect(after[0].n).toBe(before[0].n);
  });

  it("E-3: mocked SDK client tools record_answer x N then finish -> the same result as the form", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const answers = answerSet("some_concerns");
    // Form path.
    const formId = await finishedSession("some_concerns", "31-71m");
    const formResult = await (await finish(formId)).json();
    // Voice path: the agent calls the client tools one answer at a time (red flags first).
    const { body } = await start("31-71m", "voice");
    const events = { onAnswer: vi.fn(), onStop: vi.fn(), onComplete: vi.fn() };
    const tools = screenClientTools(body.session_id, { fetchFn, conversationId: () => "conv_test123" }, events);
    const order = screenQuestions("31-71m").map((q) => q.id);
    const replies: string[] = [];
    for (const id of order) replies.push(await tools.record_answer({ item_id: id, answer: ` ${answers[id].toUpperCase()} ` }));
    expect(replies.at(-1)).toBe(TOOL_REPLIES.complete);
    expect(replies[0]).toBe(TOOL_REPLIES.saved(20));
    expect(events.onAnswer).toHaveBeenCalledTimes(order.length);
    expect(events.onComplete).toHaveBeenCalledTimes(1);
    expect(events.onStop).not.toHaveBeenCalled();
    expect(await tools.record_answer({ item_id: "q1", answer: "sort of" })).toBe(TOOL_REPLIES.invalid);
    const voiceResult = await (await post(`/api/screen/sessions/${body.session_id}/finish`, { conversation_id: "conv_test123" })).json();
    expect(voiceResult).toEqual(formResult);
    const [row] = await sql`select mode, conversation_id from screen_sessions where id = ${body.session_id}`;
    expect(row).toEqual({ mode: "voice", conversation_id: "conv_test123" });
    // Closed check-in: the agent is told to end the call.
    expect(await tools.record_answer({ item_id: "q1", answer: "never" })).toBe(TOOL_REPLIES.closed);
  });

  it("resume (GET): open sessions return their answers; finished ones their result", async () => {
    const { body } = await start("31-71m");
    await answer(body.session_id, { rf_seizure: "no" });
    const open = await (await fetchFn(`/api/screen/sessions/${body.session_id}`)).json();
    expect(open).toMatchObject({ status: "open", answers: { rf_seizure: "no" }, result: null, age_band: "31-71m" });
    const id = await finishedSession("no_concerns");
    const done = await (await fetchFn(`/api/screen/sessions/${id}`)).json();
    expect(done).toMatchObject({ status: "finished", result: { result_band: "no_strong_signs", red_flag: false } });
  });

  it("E-4.2 / FR-8: anonymous 401, provider 403, other family's child 404, no consent 422, allow -> saved; strict audit", async () => {
    const id = await finishedSession("some_concerns");
    expect((await saveAs(null, { session_id: id, child_id: childA })).status).toBe(401);
    expect((await saveAs(provider, { session_id: id, child_id: childA })).status).toBe(403);
    expect((await saveAs(guardianA, { session_id: id, child_id: childB })).status).toBe(404);
    expect((await saveAs(guardianA, { session_id: id, child_id: "00000000-0000-4000-8000-000000000033" })).status).toBe(404);
    const noConsent = await saveAs(guardianA, { session_id: id, child_id: childA });
    expect(noConsent.status).toBe(422);
    expect(await noConsent.json()).toEqual({ error: "Guardian consent required", details: { feature: "screen_result_save", child_id: childA } });
    expect((await sql`select saved_child_id from screen_sessions where id = ${id}`)[0].saved_child_id).toBeNull();

    // The inline `Allow` dialog grants screen_result_save through 020's consent API, then saves again.
    await world.grant(childA, guardianA, linkA, ["screen_result_save"]);
    // Strict audit: a failing audit write saves nothing (503).
    vi.stubEnv("AUDIT_FAIL_ACTIONS", "screen.result_saved");
    expect((await saveAs(guardianA, { session_id: id, child_id: childA })).status).toBe(503);
    expect((await sql`select saved_child_id from screen_sessions where id = ${id}`)[0].saved_child_id).toBeNull();
    vi.unstubAllEnvs();

    const saved = await saveAs(guardianA, { session_id: id, child_id: childA });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({ saved: true, session_id: id, child_id: childA });
    expect((await saveAs(guardianA, { session_id: id, child_id: childA })).status).toBe(200); // idempotent
    const [row] = await sql`select saved_child_id, saved_by from screen_sessions where id = ${id}`;
    expect(row).toEqual({ saved_child_id: childA, saved_by: guardianA.id });
    const [audit] = await sql`
      select actor_user_id, actor_role, child_id, entity_id, details from audit_events
      where action = 'screen.result_saved' and entity_id = ${id}`;
    expect(audit).toMatchObject({ actor_user_id: guardianA.id, actor_role: "guardian", child_id: childA });
    expect(audit.details).toEqual({ age_band: "31-71m", result_band: "discuss_with_professional", mode: "form" });

    // Saved check-ins belong to the child: the anonymous session endpoints no longer reach them.
    expect((await fetchFn(`/api/screen/sessions/${id}`)).status).toBe(404);
    expect((await finish(id)).status).toBe(404);
    // ... and cannot be moved to another child.
    await world.grant(childC, guardianC, (await sql`select id from guardian_links where child_id = ${childC}`)[0].id, ["screen_result_save"]);
    expect((await saveAs(guardianC, { session_id: id, child_id: childC })).status).toBe(409);

    // The child page's `Check-ins` list (020 child page).
    const { listChildCheckins } = await import("@/lib/screen/store");
    const list = await listChildCheckins(childA);
    expect(list.map((c) => c.id)).toContain(id);
    expect(list.find((c) => c.id === id)).toMatchObject({ age_band: "31-71m", result_band: "discuss_with_professional" });
    expect(await listChildCheckins(childB)).toEqual([]);
  });

  it("FR-8: unfinished, red-flag and expired check-ins cannot be saved", async () => {
    await world.grant(childB, guardianB, (await sql`select id from guardian_links where child_id = ${childB}`)[0].id, ["screen_result_save"]);
    const open = (await start("31-71m")).body.session_id;
    expect((await saveAs(guardianB, { session_id: open, child_id: childB })).status).toBe(409);
    const stopped = (await start("31-71m")).body.session_id;
    await post(`/api/screen/sessions/${stopped}/red-flag`, { code: "breathing" });
    expect((await saveAs(guardianB, { session_id: stopped, child_id: childB })).status).toBe(409);
    const old = await finishedSession("no_concerns");
    await sql`update screen_sessions set expires_at = now() - interval '1 minute' where id = ${old}`;
    expect((await saveAs(guardianB, { session_id: old, child_id: childB })).status).toBe(410);
    expect((await saveAs(guardianB, { session_id: "00000000-0000-4000-8000-000000000033", child_id: childB })).status).toBe(404);
  });

  it("FR-5: unsaved check-ins are deleted after 30 days by the retention job; saved ones stay", async () => {
    const unsaved = (await start("31-71m")).body.session_id;
    const [savedRow] = await sql<{ id: string }[]>`
      select id from screen_sessions where saved_child_id = ${childA} limit 1`;
    const recent = (await start("31-71m")).body.session_id;
    const { purgeUnsavedScreenSessions } = await import("@/lib/privacy/retention");
    // Aged and purged in one transaction, so 041's concurrent retention suite never sees these rows as due.
    await sql.begin(async (tx) => {
      await tx`update screen_sessions set created_at = now() - interval '31 days' where id in ${tx([unsaved, savedRow.id])}`;
      expect(await purgeUnsavedScreenSessions(tx, new Date())).toBeGreaterThanOrEqual(1);
    });
    const left = await sql<{ id: string }[]>`select id from screen_sessions where id in ${sql([unsaved, savedRow.id, recent])}`;
    expect(left.map((r) => r.id).sort()).toEqual([savedRow.id, recent].sort());
    // runRetention runs this step (count key `unsaved_screen_sessions`).
    expect(readFileSync(path.join(ROOT, "lib/privacy/retention.ts"), "utf8")).toMatch(
      /counts\.unsaved_screen_sessions = await purgeUnsavedScreenSessions\(sql, now\)/,
    );
  });

  it("041 registry: screen_results exports the portal view and is erased with the child", async () => {
    const category = REGISTRY.find((c) => c.key === "screen_results")!;
    expect(category).toMatchObject({ owner: "child", tables: ["screen_sessions"], processors: ["supabase", "elevenlabs"] });
    const exported = await category.export!({ sql, childId: childA, guardianUserId: guardianA.id });
    const rows = exported!.data as { age_band: string; result_band: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["age_band", "concerns", "created_at", "id", "instrument", "mode", "result_band"]);
    await sql`update screen_sessions set conversation_id = 'conv_erase_test' where saved_child_id = ${childA}`;
    const ctx = { childId: childA, requestId: "r", scope: "everything" as const, requestedBy: guardianA.id, caseIds: [] };
    expect(await category.erase!.externalRefs!(sql, ctx)).toContainEqual({ processor: "elevenlabs", ref: "conv_erase_test" });
    await sql.begin(async (tx) => {
      expect(await category.erase!.rows!(tx, { ...ctx, scope: "all_ai_processing" })).toBeGreaterThanOrEqual(1);
      expect((await tx`select count(*)::int as n from screen_sessions where saved_child_id = ${childA} and conversation_id is not null`)[0].n).toBe(0);
      expect(await category.erase!.rows!(tx, ctx)).toBeGreaterThanOrEqual(1);
      expect((await tx`select count(*)::int as n from screen_sessions where saved_child_id = ${childA}`)[0].n).toBe(0);
      throw new Error("rollback");
    }).catch((e) => expect(String(e)).toContain("rollback"));
  });
});
