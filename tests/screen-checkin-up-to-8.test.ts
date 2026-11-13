// Ticket 048: parent check-in for children up to 8. Age bands (`under-18m` milestones, `9y+` "up to 8"), the
// MCHAT_LICENSED switch between the ISAA-derived toddler items and M-CHAT-R/F (published scoring, optional Follow-Up),
// the "what worries you most?" codes, the concern -> provider-type mapping (table), the free options card, red flags
// still first, old `10y+` sessions still rendering, and the bookable providers below a result (FR-10). DB suites use
// the local Supabase stack; synthetic data only, removed afterwards.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKIN } from "@/lib/clinical/checkin";
import { getInstrument, INSTRUMENT_SOURCES, score } from "@/lib/clinical/instruments";
import { MCHAT, scoreMchat } from "@/lib/clinical/mchat";
import { findHref, HYDERABAD_CENTRE } from "@/lib/geo/constants";
import type { DirectoryResult } from "@/lib/geo/search";
import type { ProviderType } from "@/lib/providers/constants";
import { FREE_SERVICES, FREE_SERVICES_LAST_CHECKED } from "@/lib/screen/free-services";
import { bookHref, orderMatches, rankCandidates } from "@/lib/screen/matches";
import { MILESTONES } from "@/lib/screen/milestones";
import {
  agentQuestionList,
  CreateSessionSchema,
  instrumentFor,
  isQuestionAgeBand,
  LEGACY_AGE_BANDS,
  mchatBand,
  QUESTION_AGE_BANDS,
  SCREEN_AGE_BANDS,
  screenQuestions,
  type ScreenConcern,
  type ScreenResult,
  type StoredAgeBand,
} from "@/lib/screen/questions";
import { recommend } from "@/lib/screen/recommend";
import { bookingWorld, type TestProvider } from "./helpers/booking";
import { withI18n } from "./helpers/i18n";
import { ALL_NO_RED_FLAGS, answerSet, nextIp, screenFetch, toList } from "./helpers/screen";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const ROOT = process.cwd();
const RISK_ITEMS = MCHAT.items.filter((i) => i.risk_answer === "yes").map((i) => i.number);

/** A complete M-CHAT-R answer set where exactly the first `risky` items carry their risk answer; red flags `no`. */
function mchatAnswers(risky: number): Record<string, string> {
  const answers: Record<string, string> = { ...ALL_NO_RED_FLAGS };
  MCHAT.items.forEach((item, i) => {
    const flip = item.risk_answer === "yes" ? "no" : "yes";
    answers[item.id] = i < risky ? item.risk_answer : flip;
  });
  return answers;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");

// ---------- pure ----------

describe("age bands (FR-1, FR-2, FR-4)", () => {
  it("offers under-18m, 18-30m, 31-71m, 6-8y and 9y+; only the middle three have questions", () => {
    expect([...SCREEN_AGE_BANDS]).toEqual(["under-18m", "18-30m", "31-71m", "6-8y", "9y+"]);
    expect([...QUESTION_AGE_BANDS]).toEqual(["18-30m", "31-71m", "6-8y"]);
    expect(screenQuestions("under-18m")).toEqual([]);
    expect(screenQuestions("9y+")).toEqual([]);
    expect(screenQuestions("under-18m", "MCHAT_RF")).toEqual([]);
    expect(isQuestionAgeBand("9y+")).toBe(false);
    expect(isQuestionAgeBand("10y+")).toBe(false);
    for (const band of QUESTION_AGE_BANDS) expect(screenQuestions(band)).toHaveLength(CHECKIN.red_flags.length + 15);
  });

  it("validates the start body: question bands only, concerns as known codes (deduplicated, fixed order)", () => {
    for (const age_band of ["under-18m", "9y+", "10y+", "6-9y", "3-5y", "18-36m", "5y"]) {
      expect(CreateSessionSchema.safeParse({ age_band, mode: "form" }).success, age_band).toBe(false);
    }
    expect(CreateSessionSchema.parse({ age_band: "31-71m", mode: "form" }).concerns).toEqual([]);
    expect(CreateSessionSchema.parse({ age_band: "6-8y", mode: "voice", concerns: ["learning", "speech", "speech"] }).concerns).toEqual([
      "speech",
      "learning",
    ]);
    expect(CreateSessionSchema.safeParse({ age_band: "31-71m", mode: "form", concerns: ["Ravi cannot talk"] }).success).toBe(false);
  });

  it("FR-4: 31-71m and 6-8y keep the ISAA-derived items; the copy still says 'not a diagnosis'", () => {
    for (const band of ["31-71m", "6-8y"] as const) {
      expect(instrumentFor(band, true)).toBe("ISAA_PARENT_CHECKIN");
      expect(screenQuestions(band).slice(6).map((q) => q.id)).toEqual(CHECKIN.questions.map((q) => q.id));
    }
    for (const copy of Object.values(CHECKIN.result_copy)) expect(copy).toContain("This is a developmental check-in, not a diagnosis.");
  });
});

describe("M-CHAT-R/F behind MCHAT_LICENSED (FR-3)", () => {
  it("MCHAT_LICENSED=false -> 18-30m uses the ISAA-derived 18-35 month items; true -> the 20 M-CHAT-R items (red flags first)", () => {
    expect(instrumentFor("18-30m", false)).toBe("ISAA_PARENT_CHECKIN");
    const isaa = screenQuestions("18-30m", instrumentFor("18-30m", false));
    expect(isaa.slice(6).map((q) => q.id)).toEqual(CHECKIN.questions.filter((q) => q.age_bands.includes("18-35m")).map((q) => q.id));

    expect(instrumentFor("18-30m", true)).toBe("MCHAT_RF");
    const mchat = screenQuestions("18-30m", "MCHAT_RF");
    expect(mchat).toHaveLength(26);
    expect(mchat.slice(0, 6).every((q) => q.kind === "red_flag")).toBe(true);
    expect(mchat.slice(6).map((q) => q.id)).toEqual(Array.from({ length: 20 }, (_, i) => `mchat_${i + 1}`));
    expect(mchat.slice(6).every((q) => q.answers.join("/") === "yes/no")).toBe(true);
    expect(agentQuestionList(mchat).split("\n")[6]).toMatch(/^7\. \[mchat_1\] \(yes\/no\) /);
  });

  it("is in the 024 registry with the Follow-Up, licence status and clearly marked placeholder wording", () => {
    const def = getInstrument("MCHAT_RF");
    expect(def).toMatchObject({ key: "MCHAT_RF", kind: "guardian_questionnaire", version: "1" });
    expect(def.items).toHaveLength(20);
    expect(INSTRUMENT_SOURCES.MCHAT_RF).toBe(MCHAT);
    expect(MCHAT.follow_up).toMatchObject({ optional: true, administered_for: "moderate", positive_min: 2 });
    expect(MCHAT.follow_up.items).toHaveLength(20);
    expect(MCHAT.licence).toMatchObject({ status: "unverified", reference: null, contact: "https://mchatscreen.com" });
    // Licence unverified: no instrument wording is shipped, every item says so.
    expect(MCHAT.status).toBe("placeholder_text_pending_licence");
    for (const item of [...MCHAT.items, ...MCHAT.follow_up.items]) expect(item.text_en).toMatch(/^\[Placeholder\]/);
  });

  it("published scoring: 'yes' is the risk answer for items 2, 5 and 12, 'no' for the rest", () => {
    expect(RISK_ITEMS).toEqual([2, 5, 12]);
    const allTypical = mchatAnswers(0);
    expect(scoreMchat(allTypical)).toMatchObject({ total: 0, risk: "low", at_risk_items: [] });
    // Item 2 answered yes scores; item 1 answered no scores.
    expect(scoreMchat({ ...allTypical, mchat_2: "yes" }).at_risk_items).toEqual(["mchat_2"]);
    expect(scoreMchat({ ...allTypical, mchat_1: "no" }).at_risk_items).toEqual(["mchat_1"]);
    expect(scoreMchat({ mchat_1: "no" })).toMatchObject({ complete: false, risk: null, result_text: null });
  });

  it.each([
    [0, "low", false, "no_strong_signs"],
    [2, "low", false, "no_strong_signs"],
    [3, "moderate", true, "discuss_with_professional"],
    [7, "moderate", true, "discuss_with_professional"],
    [8, "high", false, "see_professional_soon"],
    [20, "high", false, "see_professional_soon"],
  ] as const)("total %i -> %s (follow-up offered: %s) -> band %s", (risky, risk, followUp, band) => {
    const s = score("MCHAT_RF", mchatAnswers(risky)).result;
    expect(s).toMatchObject({ total: risky, risk, follow_up: { offered: followUp, result: null } });
    expect(mchatBand(s.risk!, null)).toBe(band);
    expect(s.result_text).toContain("This is a developmental check-in, not a diagnosis.");
  });

  it("Follow-Up: only the items that scored are re-asked; 2+ still failing -> positive, 0-1 -> negative", () => {
    const answers = mchatAnswers(4);
    const s = scoreMchat(answers);
    expect(s.at_risk_items).toEqual(["mchat_1", "mchat_2", "mchat_3", "mchat_4"]);
    const fu = (fails: number) =>
      Object.fromEntries(s.at_risk_items.map((id, i) => [id.replace("mchat_", "mchatfu_"), i < fails ? "fail" : "pass"]));
    expect(scoreMchat({ ...answers, ...fu(1) }).follow_up).toEqual({ offered: true, answered: 4, failed: 1, result: "negative" });
    expect(scoreMchat({ ...answers, ...fu(2) }).follow_up).toEqual({ offered: true, answered: 4, failed: 2, result: "positive" });
    expect(scoreMchat({ ...answers, mchatfu_1: "fail" }).follow_up.result).toBeNull();
    expect(mchatBand("moderate", "negative")).toBe("no_strong_signs");
    expect(mchatBand("moderate", "positive")).toBe("see_professional_soon");
    expect(scoreMchat({ ...answers, ...fu(2) }).result_text).toBe(MCHAT.result_copy.follow_up_positive);
  });
});

describe("concern -> provider type mapping (FR-6)", () => {
  type Row = [string, StoredAgeBand, ScreenConcern[], ScreenResult["result_band"], ProviderType[], string];
  const SLP = "speech_language_pathologist";
  const OT = "occupational_therapist";
  const DEVPED = "developmental_pediatrician";
  const PSY = "child_psychologist";
  const rows: Row[] = [
    ["speech", "31-71m", ["speech"], "no_strong_signs", [SLP], "concern:speech"],
    ["E-1: speech + closer look", "31-71m", ["speech"], "discuss_with_professional", [SLP, DEVPED, PSY], "concern:speech"],
    ["speech + soon", "18-30m", ["speech"], "see_professional_soon", [SLP, DEVPED, PSY], "concern:speech"],
    ["movement (physio for movement only)", "31-71m", ["movement"], "no_strong_signs", [OT, "physiotherapist"], "concern:movement"],
    ["senses", "31-71m", ["senses"], "no_strong_signs", [OT], "concern:senses"],
    ["movement + senses", "6-8y", ["senses", "movement"], "no_strong_signs", [OT, "physiotherapist"], "concern:movement"],
    ["playing/social: evaluation first", "31-71m", ["speech", "social"], "no_strong_signs", [DEVPED, PSY, SLP], "concern:social"],
    ["behaviour", "6-8y", ["behaviour"], "no_strong_signs", [PSY, "aba_therapist"], "concern:behaviour"],
    ["learning, 6-8", "6-8y", ["learning"], "no_strong_signs", ["special_educator", PSY], "concern:learning"],
    ["learning, under 6", "31-71m", ["learning"], "no_strong_signs", [DEVPED, "special_educator"], "concern:learning"],
    ["closer look, no worries picked", "31-71m", [], "discuss_with_professional", [DEVPED, PSY], "closer_look"],
    ["nothing to go on", "31-71m", [], "no_strong_signs", ["pediatrician", DEVPED], "no_signs"],
    ["old 10y+ session", "10y+", ["learning"], "no_strong_signs", ["special_educator", PSY], "concern:learning"],
    ["many worries: capped at 4", "6-8y", ["speech", "movement", "senses", "behaviour"], "discuss_with_professional", [SLP, DEVPED, OT, "physiotherapist"], "concern:speech"],
  ];
  it.each(rows)("%s", (_name, ageBand, concerns, resultBand, types, reason) => {
    const r = recommend({ ageBand, concerns, resultBand });
    expect(r.types).toEqual(types);
    expect(r.reason.kind === "concern" ? `concern:${r.reason.concern}` : r.reason.kind).toBe(reason);
  });
});

describe("result page (E-1, FR-6, FR-7, FR-10)", () => {
  const result = (over: Partial<ScreenResult> = {}): ScreenResult => ({
    result_band: "discuss_with_professional",
    domains: [{ domain: "speech", level: "more_signs" }],
    red_flag: false,
    message: CHECKIN.result_copy.discuss_with_professional,
    instrument: "ISAA_PARENT_CHECKIN",
    mchat: null,
    recommendation: recommend({ ageBand: "31-71m", concerns: ["speech"], resultBand: "discuss_with_professional" }),
    ...over,
  });
  const render = async (r: ScreenResult, locale: "en" | "hi" | "te" = "en") => {
    const { ResultView } = await import("@/components/screen/ResultView");
    return renderToStaticMarkup(
      withI18n(
        createElement(ResultView, {
          sessionId: "s",
          result: r,
          localities: [{ name: "Banjara Hills", lat: 17.41, lng: 78.44 }],
          viewer: { kind: "anonymous" },
          onSaved: () => {},
          onRestart: () => {},
          onUpdated: () => {},
        }),
        locale,
      ),
    );
  };

  it("E-1: speech worry + closer look -> speech therapist first with a one-line reason, developmental paediatrician second, free options", async () => {
    const html = await render(result());
    const types = [...html.matchAll(/<li data-type="([a-z_]+)"/g)].map((m) => m[1]);
    expect(types.slice(0, 2)).toEqual(["speech_language_pathologist", "developmental_pediatrician"]);
    expect(strip(html)).toContain("Good first step Speech-language pathologist Because you mentioned speech, a speech therapist is a good first step.");
    // FR-6: /find prefiltered in that order.
    expect(html).toContain(`href="${findHref({ ...HYDERABAD_CENTRE, type: "speech_language_pathologist", radius_km: 25 }).replaceAll("&", "&amp;")}"`);
    // FR-7: free options with "check timings".
    expect(html).toContain('data-testid="screen-free"');
    expect(strip(html)).toContain("District Early Intervention Centre (DEIC)");
    expect(strip(html)).toContain("At your district hospital. Free for children up to 6.");
    expect(strip(html)).toContain("NIEPID");
    expect(strip(html)).toContain("Manovikas Nagar, Bowenpally, Secunderabad");
    expect(strip(html)).toContain("Check timings before you go.");
    expect(strip(html)).toContain("Details last checked on 13 November 2026.");
    // FR-10: the bookable providers section (loaded in the browser) sits below the recommendation.
    expect(html.indexOf("screen-recommend")).toBeLessThan(html.indexOf("screen-directory"));
    expect(html).not.toMatch(/>Book</);
  });

  it("every non-urgent band shows the free options; translated in hi and te", async () => {
    for (const band of ["no_strong_signs", "see_professional_soon"] as const) {
      expect(await render(result({ result_band: band }))).toContain('data-testid="screen-free"');
    }
    expect(await render(result(), "hi")).toContain("मुफ़्त सरकारी विकल्प");
    expect(await render(result(), "te")).toContain("ఉచిత ప్రభుత్వ సేవలు");
  });

  it("M-CHAT-R/F moderate result offers the optional Follow-Up; low result says to repeat after the second birthday", async () => {
    const answers = mchatAnswers(3);
    const { followUpQuestions } = await import("@/lib/screen/questions");
    const moderate = await render(
      result({
        instrument: "MCHAT_RF",
        domains: [],
        mchat: { risk: "moderate", follow_up: { offered: true, result: null, questions: followUpQuestions("MCHAT_RF", answers) } },
      }),
    );
    expect(moderate).toContain('data-testid="screen-followup"');
    expect(moderate).toContain("A few follow-up questions (optional)");
    const low = await render(
      result({ instrument: "MCHAT_RF", result_band: "no_strong_signs", domains: [], mchat: { risk: "low", follow_up: { offered: false, result: null, questions: [] } } }),
    );
    expect(low).not.toContain('data-testid="screen-followup"');
    expect(low).toContain("do this check-in again after their second birthday");
  });

  it("free services content is static with a last_checked date", () => {
    expect(FREE_SERVICES_LAST_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FREE_SERVICES.map((s) => s.key)).toEqual(["deic", "niepid"]);
    expect(FREE_SERVICES[1]).toMatchObject({ phone: { tel: "+914027751741" }, tollFree: { tel: "18005726422" } });
  });
});

describe("under 18 months and over 8 (E-2, E-3)", () => {
  it("E-2: milestone guidance and the paediatrician advice, /find filtered for paediatricians, no questions", async () => {
    const { Under18Guidance } = await import("@/components/screen/AgeGuidance");
    const html = renderToStaticMarkup(withI18n(createElement(Under18Guidance)));
    const text = strip(html);
    expect(text).toContain("Milestones to watch for");
    expect(MILESTONES.map((m) => m.key)).toEqual(["smiles", "babbles", "name", "points", "words"]);
    expect(text).toContain("Turn when you call their name (by about 9 months)");
    expect(text).toContain("Point at things or wave bye-bye (by about 12-15 months)");
    expect(text).toContain("talk to your paediatrician");
    expect(html).toContain(`type=pediatrician`);
    expect(html).toContain(`type=developmental_pediatrician`);
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain('type="radio"');
  });

  it("E-3: 9y+ shows the 'up to 8' page with a link to /find", async () => {
    const { Over8Notice } = await import("@/components/screen/AgeGuidance");
    const html = renderToStaticMarkup(withI18n(createElement(Over8Notice)));
    expect(strip(html)).toContain("This check-in is for children up to 8. Please talk to your child's doctor or a child psychologist.");
    expect(html).toContain('href="/find"');
    expect(renderToStaticMarkup(withI18n(createElement(Over8Notice), "te"))).toContain("8 సంవత్సరాల వరకు");
  });

  it("the start page lists the new bands and offers the worries only after a band with questions", async () => {
    const { ScreenFlow } = await import("@/components/screen/ScreenFlow");
    const html = renderToStaticMarkup(withI18n(createElement(ScreenFlow, { viewer: { kind: "anonymous" }, localities: [], voiceAvailable: true })));
    for (const band of SCREEN_AGE_BANDS) expect(html).toContain(`value="${band}"`);
    for (const band of LEGACY_AGE_BANDS) expect(html).not.toContain(`value="${band}"`);
    // No band chosen yet: no worries step, no milestone page.
    expect(html).not.toContain('data-testid="screen-concerns"');
    expect(html).not.toContain('data-testid="screen-under18m"');
  });
});

describe("bookable providers ranking (FR-10)", () => {
  const row = (id: string, type: ProviderType, km: number | null): DirectoryResult =>
    ({ profile_id: id, provider_type: type, distance_km: km }) as DirectoryResult;

  it("nearest of each recommended type first, then the rest; displayed by type then distance", () => {
    const groups = [
      { type: "speech_language_pathologist" as const, results: [row("s1", "speech_language_pathologist", 1), row("s2", "speech_language_pathologist", 2), row("s3", "speech_language_pathologist", 3)] },
      { type: "developmental_pediatrician" as const, results: [row("d1", "developmental_pediatrician", 9)] },
      { type: "child_psychologist" as const, results: [row("p1", "child_psychologist", 0.5), row("s1", "speech_language_pathologist", 1)] },
    ];
    expect(rankCandidates(groups).map((r) => r.profile_id)).toEqual(["s1", "d1", "p1", "s2", "s3"]);
    const types: ProviderType[] = ["speech_language_pathologist", "developmental_pediatrician", "child_psychologist"];
    expect(orderMatches([row("p1", "child_psychologist", 0.5), row("d1", "developmental_pediatrician", 9), row("s2", "speech_language_pathologist", 2), row("s1", "speech_language_pathologist", 1)], types).map((r) => r.profile_id)).toEqual([
      "s1",
      "s2",
      "d1",
      "p1",
    ]);
    expect(bookHref("p", "svc", "2026-11-20T04:30:00.000Z")).toBe("/book/p?service=svc&start=2026-11-20T04%3A30%3A00.000Z");
  });

  it("the booking page opens with the chip's slot selected (Continue enabled)", async () => {
    const { BookingFlow } = await import("@/components/booking/BookingFlow");
    const props = {
      profile: { id: "p", name: "Dr Test (synthetic)", slug: "dr-test" },
      services: [
        { id: "svc", name: "Speech assessment", mode: "in_clinic" as const, duration_min: 30, fee_inr: 0, payment_mode: "free" as const, location_name: null, location_address: null, time_zone: "Asia/Kolkata" },
      ],
      viewer: { signedIn: false, isGuardian: false, hasGoogle: false, children: [] },
      initialHold: null,
    };
    const continueButton = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].find((b) => b[1] === "Continue")?.[0] ?? "";
    const plain = renderToStaticMarkup(withI18n(createElement(BookingFlow, props)));
    expect(continueButton(plain)).toMatch(/\sdisabled=""/);
    const chosen = renderToStaticMarkup(
      withI18n(createElement(BookingFlow, { ...props, initialSlot: { serviceId: "svc", start: "2026-11-20T04:30:00.000Z", end: "2026-11-20T05:00:00.000Z" } })),
    );
    expect(continueButton(chosen)).not.toMatch(/\sdisabled=""/);
  });
});

describe("docs (FR-9, NFR-2)", () => {
  it("the screen agent guide uses the new bands; the mapping and milestones are marked for clinical review", () => {
    const agent = readFileSync(path.join(ROOT, "docs/elevenlabs-screen-agent.md"), "utf8");
    for (const text of ["18 to 30 months", "2 and a half to 5 years", "6 to 8 years", "mchat_", "MCHAT_LICENSED"]) expect(agent).toContain(text);
    const review = readFileSync(path.join(ROOT, "docs/screen-recommendations.md"), "utf8");
    expect(review).toMatch(/clinical review/i);
    for (const text of ["lib/screen/recommend.ts", "lib/screen/milestones.ts", "lib/screen/free-services.ts", "MCHAT_LICENSED"]) expect(review).toContain(text);
  });
});

// ---------- database ----------

describe.skipIf(!enabled)("check-in up to 8 (database)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let slp: TestProvider;
  let devped: TestProvider;
  const sessions: string[] = [];
  const fetchFn = screenFetch();
  // A spot no other suite uses, more than 25 km from the booking suites' clinics (17.41, 78.44).
  const SPOT = { lat: 17.2031, lng: 78.6017 };

  async function start(age_band: string, concerns?: string[]) {
    const res = await fetchFn("/api/screen/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ age_band, mode: "form", ...(concerns ? { concerns } : {}) }),
    });
    const body = await res.json();
    if (res.status === 201) sessions.push(body.session_id);
    return { status: res.status, body };
  }
  const post = (url: string, body?: unknown) =>
    fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const answer = (id: string, answers: Record<string, string>) => post(`/api/screen/sessions/${id}/answers`, { answers: toList(answers) });
  const finish = async (id: string) => post(`/api/screen/sessions/${id}/finish`);
  const providers = (id: string, qs = "") => fetchFn(`/api/screen/sessions/${id}/providers${qs}`, { headers: { "x-forwarded-for": nextIp() } });

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t048");
    slp = await world.provider("slp");
    devped = await world.provider("devped");
    // A type change sends the profile back to verification (028): verify and list it again.
    await sql`update provider_profiles set provider_type = 'developmental_pediatrician' where id = ${devped.profileId}`;
    await sql`update provider_profiles set verification_status = 'verified', verified_at = now(), listed = true where id = ${devped.profileId}`;
    for (const p of [slp, devped]) {
      await sql`update practice_locations set lat = ${SPOT.lat}, lng = ${SPOT.lng} where id = ${p.locationId}`;
      await world.service(p, { name: "First visit (synthetic)" });
    }
  });

  beforeEach(async () => {
    (await import("@/lib/screen/rate-limit")).screenSessionLimiter.reset();
    (await import("@/lib/screen/rate-limit")).screenMatchesLimiter.reset();
  });
  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (!sql) return;
    if (sessions.length) await sql`delete from screen_sessions where id in ${sql(sessions)}`;
    await world.cleanup();
    await sql.end();
  });

  it("FR-5: the worries are stored with the session as codes; 18-30m without the licence uses the ISAA-derived items", async () => {
    const { status, body } = await start("18-30m", ["social", "speech"]);
    expect(status).toBe(201);
    expect(body.questions).toHaveLength(21);
    const [row] = await sql`select age_band, instrument, concerns from screen_sessions where id = ${body.session_id}`;
    expect(row).toEqual({ age_band: "18-30m", instrument: "ISAA_PARENT_CHECKIN", concerns: ["speech", "social"] });
    // The column refuses anything but the six codes, and M-CHAT-R/F outside 18-30m.
    await expect(sql`update screen_sessions set concerns = '{"my son Ravi"}' where id = ${body.session_id}`).rejects.toThrow(/screen_sessions_concerns_check/);
    await expect(sql`insert into screen_sessions (age_band, mode, instrument) values ('6-8y', 'form', 'MCHAT_RF')`).rejects.toThrow(/screen_sessions_mchat_band/);
    await expect(sql`insert into screen_sessions (age_band, mode) values ('9y+', 'form')`).rejects.toThrow(/screen_sessions_age_band_check/);
    expect((await start("under-18m")).status).toBe(400);
    expect((await start("9y+")).status).toBe(400);
  });

  it("E-1 (API): speech worry, 2½-5 years, tapped answers, closer look -> speech therapist first, developmental paediatrician second", async () => {
    const { body } = await start("31-71m", ["speech"]);
    expect((await answer(body.session_id, answerSet("some_concerns"))).status).toBe(200);
    const result = await (await finish(body.session_id)).json();
    expect(result).toMatchObject({
      result_band: "discuss_with_professional",
      red_flag: false,
      instrument: "ISAA_PARENT_CHECKIN",
      mchat: null,
      recommendation: { types: ["speech_language_pathologist", "developmental_pediatrician", "child_psychologist"], reason: { kind: "concern", concern: "speech" } },
    });
    // Resume returns the same result, with the worries.
    const view = await (await fetchFn(`/api/screen/sessions/${body.session_id}`)).json();
    expect(view).toMatchObject({ concerns: ["speech"], instrument: "ISAA_PARENT_CHECKIN", result });
  });

  it("FR-10: up to 3 providers by recommended type then distance, each with its next 2 free slots linking to /book", async () => {
    const { body } = await start("31-71m", ["speech"]);
    await answer(body.session_id, answerSet("some_concerns"));
    await finish(body.session_id);
    const res = await providers(body.session_id, `?lat=${SPOT.lat}&lng=${SPOT.lng}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.origin).toEqual({ lat: 17.203, lng: 78.602 });
    expect(data.types[0]).toBe("speech_language_pathologist");
    expect(data.providers.length).toBeLessThanOrEqual(3);
    const ids = data.providers.map((p: { profile_id: string }) => p.profile_id);
    // The nearest of each recommended type is picked (other suites may add providers nearby at the same time).
    expect(ids[0]).toBe(slp.profileId);
    expect(ids).toContain(devped.profileId);
    const rank = data.providers.map((p: { provider_type: string }) => data.types.indexOf(p.provider_type));
    expect(rank).toEqual([...rank].sort((a: number, b: number) => a - b));
    const ours = data.providers.filter((p: { profile_id: string }) => [slp.profileId, devped.profileId].includes(p.profile_id));
    expect(ours.map((p: { provider_type: string }) => p.provider_type)).toEqual(["speech_language_pathologist", "developmental_pediatrician"]);
    for (const p of ours) {
      expect(p.slots).toHaveLength(2);
      for (const s of p.slots) {
        expect(Date.parse(s.start)).toBeGreaterThan(Date.now());
        expect(s.book_href).toBe(`/book/${p.profile_id}?service=${p.service.id}&start=${encodeURIComponent(s.start)}`);
      }
    }
    expect(data.see_more).toBe(findHref({ lat: 17.203, lng: 78.602, type: "speech_language_pathologist", radius_km: 25 }));
    // The first chip is a free slot: the hold the booking page makes from it succeeds (one tap from check-in to booking).
    const first = data.providers[0].slots[0];
    const { holdSlot } = await import("@/lib/booking/store");
    const hold = await holdSlot(
      { service_id: data.providers[0].service.id, start: first.start, idempotency_key: `k-048-${Date.now()}` },
      { sessionHash: "0".repeat(63) + "8" },
    );
    expect(hold.status).toBe("held");
    // Default origin: central Hyderabad (our spot is ~23 km away, inside the 25 km radius).
    const central = await (await providers(body.session_id)).json();
    expect(central.origin).toEqual({ lat: HYDERABAD_CENTRE.lat, lng: HYDERABAD_CENTRE.lng });
    // Validation: lat without lng, outside India.
    expect((await providers(body.session_id, "?lat=17.4")).status).toBe(400);
    expect((await providers(body.session_id, "?lat=51.5&lng=-0.12")).status).toBe(422);
  });

  it("FR-10 / FR-8: no providers for an open, a stopped or an unknown check-in", async () => {
    const open = (await start("6-8y")).body.session_id;
    expect((await providers(open)).status).toBe(409);
    const stopped = (await start("6-8y", ["behaviour"])).body.session_id;
    await answer(stopped, { ...answerSet("no_concerns"), rf_seizure: "yes" });
    expect((await providers(stopped)).status).toBe(409);
    expect((await providers("00000000-0000-4000-8000-000000000048")).status).toBe(404);
  });

  it("MCHAT_LICENSED=true: 18-30m gets the 20 M-CHAT-R items; moderate -> optional Follow-Up -> updated result", async () => {
    vi.stubEnv("MCHAT_LICENSED", "true");
    const { body } = await start("18-30m", ["speech"]);
    expect(body.questions).toHaveLength(26);
    expect((await sql`select instrument from screen_sessions where id = ${body.session_id}`)[0].instrument).toBe("MCHAT_RF");
    // 31-71m keeps the ISAA-derived items even with the flag on.
    expect((await start("31-71m")).body.questions).toHaveLength(21);

    // ISAA answers are refused on an M-CHAT session (and vice versa).
    expect((await answer(body.session_id, { q1: "never" })).status).toBe(400);
    expect((await answer(body.session_id, { mchat_1: "often" })).status).toBe(400);
    expect((await answer(body.session_id, mchatAnswers(4))).status).toBe(200);
    const result = await (await finish(body.session_id)).json();
    expect(result).toMatchObject({ result_band: "discuss_with_professional", instrument: "MCHAT_RF", domains: [], mchat: { risk: "moderate", follow_up: { offered: true, result: null } } });
    expect(result.mchat.follow_up.questions.map((q: { id: string }) => q.id)).toEqual(["mchatfu_1", "mchatfu_2", "mchatfu_3", "mchatfu_4"]);
    expect(result.recommendation.types.slice(0, 2)).toEqual(["speech_language_pathologist", "developmental_pediatrician"]);

    const followUp = (answers: Record<string, string>) => post(`/api/screen/sessions/${body.session_id}/follow-up`, { answers: toList(answers) });
    expect((await followUp({ mchatfu_1: "fail" })).status).toBe(422);
    expect((await followUp({ mchatfu_9: "fail" })).status).toBe(400);
    expect((await followUp({ mchatfu_1: "maybe" })).status).toBe(400);
    const updated = await followUp({ mchatfu_1: "fail", mchatfu_2: "fail", mchatfu_3: "pass", mchatfu_4: "pass" });
    expect(updated.status).toBe(200);
    const after = await updated.json();
    expect(after).toMatchObject({ result_band: "see_professional_soon", mchat: { risk: "moderate", follow_up: { offered: true, result: "positive", questions: [] } } });
    expect((await sql`select result_band from screen_sessions where id = ${body.session_id}`)[0].result_band).toBe("see_professional_soon");
    // Finish and resume return the updated result; a second Follow-Up changes nothing.
    expect(await (await finish(body.session_id)).json()).toEqual(after);
    expect(await (await followUp({ mchatfu_1: "pass", mchatfu_2: "pass", mchatfu_3: "pass", mchatfu_4: "pass" })).json()).toEqual(after);
  });

  it("MCHAT_LICENSED=true: low and high results have no Follow-Up; ISAA check-ins answer 409", async () => {
    vi.stubEnv("MCHAT_LICENSED", "true");
    const low = (await start("18-30m")).body.session_id;
    await answer(low, mchatAnswers(2));
    expect(await (await finish(low)).json()).toMatchObject({ result_band: "no_strong_signs", mchat: { risk: "low", follow_up: { offered: false } } });
    expect((await post(`/api/screen/sessions/${low}/follow-up`, { answers: [{ item_id: "mchatfu_1", answer: "fail" }] })).status).toBe(409);
    const high = (await start("18-30m")).body.session_id;
    await answer(high, mchatAnswers(9));
    expect(await (await finish(high)).json()).toMatchObject({ result_band: "see_professional_soon", mchat: { risk: "high", follow_up: { offered: false } } });
    const isaa = (await start("6-8y")).body.session_id;
    await answer(isaa, answerSet("many_concerns"));
    await finish(isaa);
    expect((await post(`/api/screen/sessions/${isaa}/follow-up`, { answers: [{ item_id: "mchatfu_1", answer: "fail" }] })).status).toBe(409);
  });

  it("FR-8: a red flag still overrides everything on an M-CHAT-R/F check-in (no result, no recommendation, no providers)", async () => {
    vi.stubEnv("MCHAT_LICENSED", "true");
    const id = (await start("18-30m", ["speech"])).body.session_id;
    const res = await answer(id, { ...mchatAnswers(9), rf_breathing: "yes" });
    expect(await res.json()).toMatchObject({ stop: true });
    expect(await (await finish(id)).json()).toEqual({
      result_band: null,
      domains: [],
      red_flag: true,
      message: "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.",
      instrument: "MCHAT_RF",
      mchat: null,
      recommendation: null,
    });
    expect((await providers(id)).status).toBe(409);
  });

  it("FR-1: an old session with 10y+ (and 3-5y) still resumes, finishes and renders", async () => {
    const answers = answerSet("some_concerns");
    const [old] = await sql<{ id: string }[]>`
      insert into screen_sessions (age_band, mode, answers) values ('10y+', 'form', ${sql.json(answers)}) returning id`;
    sessions.push(old.id);
    const view = await (await fetchFn(`/api/screen/sessions/${old.id}`)).json();
    expect(view).toMatchObject({ age_band: "10y+", status: "open", instrument: "ISAA_PARENT_CHECKIN", concerns: [] });
    expect(view.questions).toHaveLength(21);
    const result = await (await finish(old.id)).json();
    expect(result).toMatchObject({ result_band: "discuss_with_professional", recommendation: { types: ["developmental_pediatrician", "child_psychologist"] } });
    const { ResultView } = await import("@/components/screen/ResultView");
    const html = renderToStaticMarkup(
      withI18n(createElement(ResultView, { sessionId: old.id, result, localities: [], viewer: { kind: "anonymous" }, onSaved: () => {}, onRestart: () => {} })),
    );
    expect(html).toContain("Some areas are worth discussing with a professional");
    const [finished] = await sql<{ id: string }[]>`
      insert into screen_sessions (age_band, mode, answers, result_band) values ('3-5y', 'form', ${sql.json(answerSet("no_concerns"))}, 'no_strong_signs') returning id`;
    sessions.push(finished.id);
    expect(await (await fetchFn(`/api/screen/sessions/${finished.id}`)).json()).toMatchObject({ status: "finished", result: { result_band: "no_strong_signs" } });
  });

  it("024 registry row: MCHAT_RF mirrors schemas/mchat-rf.json; no licence reference recorded yet", async () => {
    const [row] = await sql`select version, kind, definition, licence_ref from clinical_instruments where key = 'MCHAT_RF'`;
    expect(row).toMatchObject({ version: "1", kind: "guardian_questionnaire", licence_ref: null });
    expect(row.definition).toEqual(MCHAT);
  });
});
