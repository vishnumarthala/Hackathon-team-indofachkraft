// Ticket 013 "Ask the case". Pure checks always run; the route/database checks need DATABASE_URL (skipped
// when it is not set or SKIP_DB_TESTS=1). Database checks create their own synthetic case and delete only it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOT_DOCUMENTED,
  factCitation,
  isPlayable,
  resolveAnswer,
  segmentCitation,
  type CitationRecording,
} from "@/lib/ask/citations";
import { buildAskContext, buildAskPrompt, MAX_CONTEXT_CHARS, type AskCase, type AskFact, type AskRecording } from "@/lib/ask/context";
import type { GenerateJsonInput } from "@/lib/gemini";
import { AskAnswerSchema, SegmentSchema, type AskAnswer, type Segment } from "@/lib/types";

const askMock = vi.hoisted(() => ({
  impl: null as null | ((input: { task: string; prompt: string }) => Promise<unknown>),
  prompts: [] as string[],
}));

vi.mock("@/lib/auth", () => ({ requireApiUser: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return {
    ...actual,
    generateJson: <T,>(input: GenerateJsonInput<T>) => {
      if (input.task !== "ask") return actual.generateJson(input);
      askMock.prompts.push(input.prompt);
      return (askMock.impl ? askMock.impl(input) : actual.generateJson(input)) as Promise<T>;
    },
  };
});

const fixture = (rel: string) => JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures", rel), "utf8"));
const roleplay = SegmentSchema.array().parse(fixture("roleplay-segments.json"));
const askFixture = AskAnswerSchema.parse(fixture("gemini/ask.json"));

// ---------------------------------------------------------------------------
// Pure: citations (FR-3) and context (FR-2)
// ---------------------------------------------------------------------------

const SESSION_1: AskRecording = { id: "rec-s1", kind: "session", session_number: 1, segments: [], created_at: "2026-11-01T10:00:00Z" };
const SESSION_2: AskRecording = { id: "rec-s2", kind: "session", session_number: 2, segments: [], created_at: "2026-11-02T10:00:00Z" };
const INTAKE: AskRecording = { id: "rec-in", kind: "intake_call", session_number: null, segments: [], created_at: "2026-10-30T10:00:00Z" };

const seg = (id: string, start: number, text: string, speaker: Segment["speaker"] = "parent"): Segment => ({
  id,
  speaker,
  speaker_label: speaker,
  start_sec: start,
  end_sec: start + 5,
  text,
});

const isaaFact: AskFact = {
  id: "11111111-1111-4111-8111-111111111111",
  instrument: "ISAA",
  item_id: "14",
  recording_id: SESSION_1.id,
  value: 4,
  status: "confirmed",
  evidence: { quote: "Now he says no words at all.", segment_id: "s10", start_sec: 60.84, end_sec: 67.8, recording_id: SESSION_1.id, verified: true },
};
const caseSheetFact: AskFact = {
  id: "22222222-2222-4222-8222-222222222222",
  instrument: "CASE_SHEET",
  item_id: "lost_speech",
  recording_id: INTAKE.id,
  value: true,
  status: "suggested",
  evidence: null,
};
const suggestedFact: AskFact = { ...isaaFact, id: "33333333-3333-4333-8333-333333333333", item_id: "2", status: "suggested" };

function smallCase(): AskCase {
  return {
    recordings: [
      { ...SESSION_1, segments: [seg("s1", 1, "Hello Ravi.", "therapist"), seg("s10", 60.84, "Then slowly he stopped talking.")] },
      { ...INTAKE, segments: [seg("t2", 15, "Yes, I agree."), seg("t3", 130, "He hits his head when upset.")] },
    ],
    facts: [isaaFact, caseSheetFact, suggestedFact],
    briefSummary: "Parent reports loss of words at age 2.",
  };
}

const answer = (citations: AskAnswer["citations"], found = true, text = "He stopped talking after age 2."): AskAnswer => ({
  found,
  answer: text,
  citations,
});

describe("ask citations (FR-3)", () => {
  const context = buildAskContext(smallCase()).citable;

  it("keeps a valid fact id and labels it with its evidence moment", () => {
    const result = resolveAnswer(answer([{ kind: "fact", id: isaaFact.id }]), context);
    expect(result).toEqual({
      found: true,
      answer: "He stopped talking after age 2.",
      citations: [
        { kind: "fact", id: isaaFact.id, recording_id: SESSION_1.id, session_number: 1, start_sec: 60.84, label: "Session 1 · 01:00" },
      ],
    });
  });

  it("accepts a fact id written with its fact: prefix", () => {
    const result = resolveAnswer(answer([{ kind: "fact", id: `fact:${isaaFact.id}` }]), context);
    expect(result.citations.map((c) => c.id)).toEqual([isaaFact.id]);
  });

  it("drops unknown fact ids, facts that were not sent, and ids of the wrong kind", () => {
    const result = resolveAnswer(
      answer([
        { kind: "fact", id: "99999999-9999-4999-8999-999999999999" },
        { kind: "fact", id: suggestedFact.id },
        { kind: "fact", id: "1:s10" },
        { kind: "segment", id: isaaFact.id },
        { kind: "segment", id: "1:s10" },
      ]),
      context,
    );
    expect(result.found).toBe(true);
    expect(result.citations.map((c) => `${c.kind}:${c.id}`)).toEqual(["segment:1:s10"]);
  });

  it("labels session segments `1:s<k>` and intake turns `intake:t<k>`", () => {
    const result = resolveAnswer(
      answer([
        { kind: "segment", id: "1:s10" },
        { kind: "segment", id: "intake:t3" },
        { kind: "segment", id: "1:s10" },
      ]),
      context,
    );
    expect(result.citations).toEqual([
      { kind: "segment", id: "1:s10", recording_id: SESSION_1.id, session_number: 1, start_sec: 60.84, label: "Session 1 · 01:00" },
      { kind: "segment", id: "intake:t3", recording_id: INTAKE.id, session_number: null, start_sec: 130, label: "Intake call · 02:10" },
    ]);
  });

  it("drops segment ids that do not exist or use the wrong recording prefix", () => {
    const result = resolveAnswer(
      answer([{ kind: "segment", id: "s10" }, { kind: "segment", id: "2:s10" }, { kind: "segment", id: "intake:t99" }]),
      context,
    );
    expect(result).toEqual({ found: false, answer: NOT_DOCUMENTED, citations: [] });
  });

  it("labels a CASE_SHEET fact without evidence `Intake answers` at 0 s", () => {
    const result = resolveAnswer(answer([{ kind: "fact", id: caseSheetFact.id }]), context);
    expect(result.citations).toEqual([
      { kind: "fact", id: caseSheetFact.id, recording_id: INTAKE.id, session_number: null, start_sec: 0, label: "Intake answers" },
    ]);
  });

  it("turns found-without-citations into Not documented", () => {
    expect(resolveAnswer(answer([]), context)).toEqual({ found: false, answer: NOT_DOCUMENTED, citations: [] });
    expect(resolveAnswer(answer([{ kind: "fact", id: "nope" }]), context)).toEqual({
      found: false,
      answer: NOT_DOCUMENTED,
      citations: [],
    });
  });

  it("never returns citations for a found:false answer", () => {
    const result = resolveAnswer(answer([{ kind: "segment", id: "1:s10" }], false, "Maybe."), context);
    expect(result).toEqual({ found: false, answer: NOT_DOCUMENTED, citations: [] });
  });

  it("resolves facts and segments of an unknown recording without crashing", () => {
    const orphan = factCitation({ ...isaaFact, evidence: { recording_id: "gone", start_sec: 5 } }, new Map());
    expect(orphan.label).toBe("Session ? · 00:05");
    const recording: CitationRecording = { id: "r", kind: "session", session_number: 3 };
    expect(segmentCitation(recording, { id: "s2", start_sec: 3600 }).label).toBe("Session 3 · 60:00");
  });
});

describe("ask audio playability", () => {
  it("never treats a recording without audio as playable", () => {
    expect(isPlayable({ hasAudio: false, expiresAt: Date.now() + 60_000, now: Date.now() })).toBe(false);
  });

  it("never treats an expired signed URL as playable", () => {
    expect(isPlayable({ hasAudio: true, expiresAt: 1_000, now: 1_000 })).toBe(false);
    expect(isPlayable({ hasAudio: true, expiresAt: 1_000, now: 5_000 })).toBe(false);
    expect(isPlayable({ hasAudio: true, expiresAt: Number.NaN, now: 0 })).toBe(false);
  });

  it("plays audio that exists and has not expired", () => {
    expect(isPlayable({ hasAudio: true, expiresAt: 2_000, now: 1_000 })).toBe(true);
  });
});

describe("ask context (FR-2)", () => {
  it("formats facts, intake answers, the brief and transcript lines", () => {
    const { text } = buildAskContext(smallCase());
    const factLine = text.split("\n").find((l) => l.startsWith(`[fact:${isaaFact.id}]`)) as string;
    expect(factLine).toMatch(new RegExp(`^\\[fact:${isaaFact.id}\\] 14\\. .+: .+ - "Now he says no words at all\\." \\(Session 1 01:00\\)$`));
    expect(text).toContain(`[fact:${caseSheetFact.id}] (parent-reported) `);
    expect(text.split("\n").find((l) => l.startsWith(`[fact:${caseSheetFact.id}]`))).toMatch(/: yes$/);
    expect(text).not.toContain(suggestedFact.id);
    expect(text).toContain("Parent reports loss of words at age 2.");
    expect(text).toContain("[1:s10 | 01:00 | PARENT] Then slowly he stopped talking.");
    expect(text).toContain("[1:s1 | 00:01 | THERAPIST] Hello Ravi.");
    expect(text).toContain("[intake:t3 | 02:10 | PARENT] He hits his head when upset.");
  });

  it("puts the specialist's question after the case record", () => {
    const prompt = buildAskPrompt("When did speech regress?", "CONTEXT");
    expect(prompt.indexOf("CONTEXT")).toBeLessThan(prompt.indexOf("When did speech regress?"));
  });

  function bigCase(): AskCase {
    const lines = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => seg(`${prefix}${i + 1}`, i * 10, `${prefix} line ${i + 1} `.padEnd(200, "x")));
    return {
      recordings: [
        { ...SESSION_2, segments: lines("s", 60) },
        { ...SESSION_1, segments: lines("s", 60) },
        { ...INTAKE, segments: lines("t", 60) },
      ],
      facts: [isaaFact, caseSheetFact],
      briefSummary: "Brief summary.",
    };
  }

  it("cuts to 60,000 characters by default and keeps a small case whole", () => {
    expect(MAX_CONTEXT_CHARS).toBe(60_000);
    const small = buildAskContext(smallCase());
    expect(small.citable.segments.size).toBe(4);
    expect(small.citable.facts.size).toBe(2);
  });

  it("cuts intake segments first, then the oldest session, and never more than needed", () => {
    const full = buildAskContext(bigCase(), 1_000_000);
    const fullLength = full.text.length;

    // Room for everything except ~half the intake call.
    const cutIntake = buildAskContext(bigCase(), fullLength - 30 * 210);
    expect(cutIntake.text.length).toBeLessThanOrEqual(fullLength - 30 * 210);
    const intakeLeft = [...cutIntake.citable.segments.keys()].filter((k) => k.startsWith("intake:"));
    expect(intakeLeft.length).toBeGreaterThan(0);
    expect(intakeLeft.length).toBeLessThan(60);
    expect(cutIntake.citable.segments.has("intake:t1")).toBe(true);
    expect(cutIntake.citable.segments.has("intake:t60")).toBe(false);
    expect([...cutIntake.citable.segments.keys()].filter((k) => k.startsWith("1:"))).toHaveLength(60);
    expect([...cutIntake.citable.segments.keys()].filter((k) => k.startsWith("2:"))).toHaveLength(60);

    // Room for one and a half sessions: intake gone, session 1 (oldest) cut, session 2 whole.
    const cutSessions = buildAskContext(bigCase(), fullLength - 90 * 210);
    const keys = [...cutSessions.citable.segments.keys()];
    expect(cutSessions.text.length).toBeLessThanOrEqual(fullLength - 90 * 210);
    expect(keys.filter((k) => k.startsWith("intake:"))).toHaveLength(0);
    expect(cutSessions.text).not.toContain("Intake call transcript:");
    expect(keys.filter((k) => k.startsWith("2:"))).toHaveLength(60);
    const s1 = keys.filter((k) => k.startsWith("1:"));
    expect(s1.length).toBeGreaterThan(0);
    expect(s1.length).toBeLessThan(60);
    expect(cutSessions.citable.facts.size).toBe(2);
    expect(cutSessions.text).toContain("Brief summary.");
  });

  it("validates citations against the truncated context, not the full case", () => {
    const limit = buildAskContext(bigCase(), 1_000_000).text.length - 90 * 210;
    const cut = buildAskContext(bigCase(), limit);
    const result = resolveAnswer(
      answer([
        { kind: "segment", id: "intake:t1" },
        { kind: "segment", id: "1:s60" },
        { kind: "segment", id: "2:s60" },
      ]),
      cut.citable,
    );
    expect(result.citations.map((c) => c.id)).toEqual(["2:s60"]);

    const none = resolveAnswer(answer([{ kind: "segment", id: "intake:t1" }]), cut.citable);
    expect(none).toEqual({ found: false, answer: NOT_DOCUMENTED, citations: [] });
  });

  it("drops the brief and facts only after every transcript line is gone", () => {
    const cut = buildAskContext(bigCase(), 300);
    expect(cut.text.length).toBeLessThanOrEqual(300);
    expect(cut.citable.segments.size).toBe(0);
    expect(cut.citable.facts.has(isaaFact.id)).toBe(true);
  });

  it("uses the latest intake call and session numbers, skipping recordings without segments", () => {
    const older: AskRecording = { ...INTAKE, id: "rec-in-old", created_at: "2026-10-01T00:00:00Z", segments: [seg("t3", 5, "Old call.")] };
    const empty: AskRecording = { ...SESSION_2, segments: [] };
    const ctx = buildAskContext({ ...smallCase(), recordings: [...smallCase().recordings, older, empty] });
    expect(ctx.citable.segments.get("intake:t3")?.recording_id).toBe(INTAKE.id);
    expect(ctx.text).not.toContain("Session 2 transcript:");
  });
});

describe("ask prompt (FR-5)", () => {
  const prompt = readFileSync(path.join(process.cwd(), "prompts/ask.md"), "utf8");
  it("contains the section 10 rules", () => {
    expect(prompt).toContain("Not documented in this case.");
    expect(prompt).toContain("You document; you never diagnose. Use only the transcript/facts given. Never invent quotes - copy them word for word from one segment. Your output is not a diagnosis.");
    expect(prompt).toContain("120 words");
    expect(prompt).toContain("parent-reported");
    expect(prompt).toMatch(/exactly as given/);
  });
});

// ---------------------------------------------------------------------------
// Route + database: access, storage, audit, Gemini failure and the atomic 50-question limit (FR-1, FR-4)
// ---------------------------------------------------------------------------

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("ask route (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let caseId = "";
  let token = "";
  let referralId = "";
  let askPost: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  let GeminiErrorClass: typeof import("@/lib/gemini").GeminiError;

  const ask = (body: unknown, id = caseId) =>
    askPost(
      new Request(`http://localhost/api/cases/${id}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  const countQuestions = async (refId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from case_questions where referral_id = ${refId}`)[0].n;

  async function newReferral(): Promise<{ id: string; token: string }> {
    const { newToken } = await import("@/lib/tokens");
    const share = newToken();
    const [row] = await sql<{ id: string }[]>`
      insert into referrals (case_id, share_token, specialist_name, specialist_email, reason, packet, parent_consent)
      select case_id, ${share}, specialist_name, specialist_email, reason, packet, true
      from referrals where id = ${referralId}
      returning id`;
    return { id: row.id, token: share };
  }

  async function fillQuestions(refId: string, n: number) {
    await sql`
      insert into case_questions (referral_id, question, answer, found, citations)
      select ${refId}, 'Synthetic filler question ' || g, 'Not documented in this case.', false, '[]'::jsonb
      from generate_series(1, ${n}) g`;
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const seed = await import("../scripts/seed-demo");
    const { CASE_SHEET_FIELDS } = await import("@/lib/caseSheet");
    const fixtures = seed.loadSeedFixtures();
    caseId = randomUUID();
    const sessionId = randomUUID();
    const intakeId = randomUUID();
    const json = (v: unknown) => sql.json(v as postgres.JSONValue);
    await sql`
      insert into cases (id, child_alias, child_age_months, parent_alias, language, therapist_name, status)
      values (${caseId}, ${`t013-ask-${caseId.slice(0, 8)} (synthetic)`}, 40, 'Parent (synthetic)', 'en', 'Demo Therapist', 'in_assessment')`;
    await sql`
      insert into recordings (id, case_id, kind, status, segments)
      values (${intakeId}, ${caseId}, 'intake_call', 'transcribed', ${json(seed.buildIntakeSegments(fixtures.postCall.data.transcript))})`;
    await sql`
      insert into recordings (id, case_id, kind, session_number, status, speaker_map, segments)
      values (${sessionId}, ${caseId}, 'session', 1, 'extracted', ${json({ speaker_0: "therapist", speaker_1: "parent" })},
              ${json(roleplay)})`;
    const facts = [
      ...seed.buildCaseSheetFacts(caseId, intakeId, fixtures.postCall.data.analysis.data_collection_results, CASE_SHEET_FIELDS.map((f) => f.id)),
      ...seed.buildIsaaFacts({
        caseId,
        sessionId,
        extract: fixtures.extract,
        segments: roleplay,
        therapistName: "Demo Therapist",
        confirmed: true,
        now: new Date().toISOString(),
      }),
    ];
    await sql`
      insert into facts (case_id, recording_id, instrument, item_id, value, ai_value, source, evidence, confidence,
                         rationale, status, confirmed_by, confirmed_at)
      select x.case_id, x.recording_id, x.instrument, x.item_id, x.value, x.ai_value, x.source, x.evidence,
             x.confidence, x.rationale, x.status, x.confirmed_by, x.confirmed_at
      from jsonb_to_recordset(${json(facts)}) as x(case_id uuid, recording_id uuid, instrument text,
        item_id text, value jsonb, ai_value jsonb, source text, evidence jsonb, confidence numeric, rationale text,
        status text, confirmed_by text, confirmed_at timestamptz)`;
    await sql`
      insert into reports (case_id, recording_id, kind, content, content_md, status)
      values (${caseId}, ${intakeId}, 'pre_session_brief', ${json(fixtures.brief)}, 'Brief', 'draft')`;

    const refer = await import("@/app/api/cases/[id]/refer/route");
    const res = await refer.POST(
      new Request(`http://localhost/api/cases/${caseId}/refer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specialist_name: "Dr. Example",
          specialist_email: "s@example.com",
          reason: "Red flags",
          parent_consent: true,
        }),
      }),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { referral_id: string; url: string };
    referralId = created.referral_id;
    token = created.url.split("/").pop() as string;

    askPost = (await import("@/app/api/cases/[id]/ask/route")).POST;
    GeminiErrorClass = (await import("@/lib/gemini")).GeminiError;
  });

  beforeEach(() => {
    askMock.impl = null;
    askMock.prompts = [];
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql) {
      if (caseId) await sql`delete from cases where id = ${caseId}`;
      await sql.end({ timeout: 5 });
    }
    const { askDb } = await import("@/lib/ask/questions");
    await askDb().end({ timeout: 5 });
  });

  it("exports maxDuration = 60", async () => {
    expect((await import("@/app/api/cases/[id]/ask/route")).maxDuration).toBe(60);
  });

  it("answers from the fixture, stores the question and audits it (FR-4)", async () => {
    const started = Date.now();
    const res = await ask({ share_token: token, question: "  When did speech regress?  " });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.answer).toBe(askFixture.answer);
    expect(body.citations).toHaveLength(1);
    expect(body.citations[0]).toMatchObject({ kind: "segment", id: "1:s10", session_number: 1, start_sec: 60.84, label: "Session 1 · 01:00" });
    expect(Object.keys(body).sort()).toEqual(["answer", "citations", "found"]);
    expect(Object.keys(body.citations[0]).sort()).toEqual(["id", "kind", "label", "recording_id", "session_number", "start_sec"]);

    const [stored] = await sql`
      select id, question, answer, found, citations from case_questions where referral_id = ${referralId}
      order by created_at desc limit 1`;
    expect(stored).toMatchObject({ question: "When did speech regress?", answer: askFixture.answer, found: true });
    expect(stored.citations).toEqual(body.citations);
    const audits = await sql`
      select actor, entity_id, details from audit_events where case_id = ${caseId} and action = 'case.question_asked'`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "specialist", entity_id: stored.id });

    // FR-2 against real case data: facts, CASE_SHEET answers, brief, session and intake lines.
    const prompt = askMock.prompts[0];
    expect(prompt).toMatch(/\[fact:[0-9a-f-]{36}\] \d+\. .+: .+/);
    expect(prompt).toMatch(/\[fact:[0-9a-f-]{36}\] \(parent-reported\) .+: .+/);
    expect(prompt).toContain("[1:s10 | 01:00 | PARENT] Yes, at age 2 he said a few words");
    expect(prompt).toMatch(/\[intake:t\d+ \| \d\d:\d\d \| (AGENT|PARENT)\] /);
  });

  it("drops a citation the model invents and answers Not documented (NFR-2)", async () => {
    askMock.impl = async () => ({ found: true, answer: "Invented.", citations: [{ kind: "fact", id: randomUUID() }] });
    const res = await ask({ share_token: token, question: "Any self-injury?" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false, answer: NOT_DOCUMENTED, citations: [] });
  });

  it("returns 404 for a wrong token, a token of another case and a malformed case id (FR-1)", async () => {
    const before = await countQuestions(referralId);
    for (const [body, id] of [
      [{ share_token: "wrong", question: "Any self-injury?" }, caseId],
      [{ share_token: token, question: "Any self-injury?" }, randomUUID()],
      [{ share_token: token, question: "Any self-injury?" }, "not-a-uuid"],
    ] as const) {
      const res = await ask(body, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(await countQuestions(referralId)).toBe(before);
  });

  it("returns 400 with a field message for a bad question (FR-1)", async () => {
    for (const question of ["?", "  ab  ", "x".repeat(501), 42]) {
      const res = await ask({ share_token: token, question });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid request");
      expect(typeof body.details.question).toBe("string");
    }
  });

  it("answers 502 on Gemini failure and stores nothing (E-4)", async () => {
    const before = await countQuestions(referralId);
    const auditsBefore = (await sql`select count(*)::int as n from audit_events where case_id = ${caseId} and action = 'case.question_asked'`)[0].n;
    askMock.impl = async () => {
      throw new GeminiErrorClass("Gemini request failed: synthetic");
    };
    const res = await ask({ share_token: token, question: "When did speech regress?" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The question could not be answered" });
    expect(await countQuestions(referralId)).toBe(before);
    const auditsAfter = (await sql`select count(*)::int as n from audit_events where case_id = ${caseId} and action = 'case.question_asked'`)[0].n;
    expect(auditsAfter).toBe(auditsBefore);
  });

  it("never lets concurrent requests exceed 50 questions per referral", async () => {
    const ref = await newReferral();
    await fillQuestions(ref.id, 47);
    askMock.impl = async () => {
      await sleep(300);
      return askFixture;
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => ask({ share_token: ref.token, question: "Any self-injury?" })),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    const limited = await Promise.all(responses.filter((r) => r.status === 429).map((r) => r.json()));
    for (const body of limited) expect(body).toEqual({ error: "Question limit reached for this referral" });
    expect(await countQuestions(ref.id)).toBe(50);

    const after = await ask({ share_token: ref.token, question: "Any self-injury?" });
    expect(after.status).toBe(429);
    expect(await countQuestions(ref.id)).toBe(50);
  });

  it("holds the last slot while generating and releases it when Gemini fails", async () => {
    const ref = await newReferral();
    await fillQuestions(ref.id, 49);
    askMock.impl = async () => {
      await sleep(500);
      throw new GeminiErrorClass("Gemini request failed: synthetic");
    };
    const pair = await Promise.all([
      ask({ share_token: ref.token, question: "Any self-injury?" }),
      sleep(100).then(() => ask({ share_token: ref.token, question: "Any self-injury?" })),
    ]);
    expect(pair.map((r) => r.status).sort()).toEqual([429, 502]);
    expect(await countQuestions(ref.id)).toBe(49);

    askMock.impl = null;
    const retry = await ask({ share_token: ref.token, question: "When did speech regress?" });
    expect(retry.status).toBe(200);
    expect(await countQuestions(ref.id)).toBe(50);
    expect((await ask({ share_token: ref.token, question: "Any self-injury?" })).status).toBe(429);
  });

  it("returns 404 once the referral is revoked (FR-1)", async () => {
    const ref = await newReferral();
    expect((await ask({ share_token: ref.token, question: "Any self-injury?" })).status).toBe(200);
    await sql`update referrals set status = 'revoked' where id = ${ref.id}`;
    const res = await ask({ share_token: ref.token, question: "Any self-injury?" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("lists only answered questions, oldest first, for the specialist page", async () => {
    const { listQuestions, reserveQuestion, releaseQuestion } = await import("@/lib/ask/questions");
    const ref = await newReferral();
    await fillQuestions(ref.id, 1);
    await sql`
      insert into case_questions (referral_id, question, answer, found, created_at)
      values (${ref.id}, 'Earlier question', 'Not documented in this case.', false, now() - interval '1 minute')`;
    const pending = await reserveQuestion(ref.id, "Pending question");
    expect(pending.ok).toBe(true);
    const listed = await listQuestions(ref.id);
    expect(listed.map((q) => q.question)).toEqual(["Earlier question", "Synthetic filler question 1"]);
    if (pending.ok) await releaseQuestion(pending.questionId);
    expect(await countQuestions(ref.id)).toBe(2);
  });
});
