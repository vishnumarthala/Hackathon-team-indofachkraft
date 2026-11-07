import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Brief, Evidence, ReferralSummary } from "@/lib/types";

vi.mock("@/lib/auth", () => ({ requireApiUser: vi.fn().mockResolvedValue(null) }));

// In-memory stand-in for the Supabase query builder (only what the referral code uses).
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const state: { tables: Tables; nextId: number } = { tables: {}, nextId: 1 };

function from(table: string) {
  const rows = (state.tables[table] ??= []);
  const filters: ((row: Row) => boolean)[] = [];
  let mode: "select" | "insert" | "update" = "select";
  let payload: Row = {};
  let order: { col: string; ascending: boolean } | null = null;
  let limit: number | null = null;

  async function exec(): Promise<{ data: Row[]; error: null }> {
    if (mode === "insert") {
      const row = { id: `00000000-0000-4000-8000-${String(state.nextId++).padStart(12, "0")}`, ...payload };
      rows.push(row);
      return { data: [row], error: null };
    }
    let matched = rows.filter((row) => filters.every((f) => f(row)));
    if (mode === "update") {
      matched.forEach((row) => Object.assign(row, payload));
      return { data: matched, error: null };
    }
    if (order) {
      const { col, ascending } = order;
      matched = [...matched].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1));
    }
    if (limit !== null) matched = matched.slice(0, limit);
    return { data: matched, error: null };
  }

  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => (filters.push((row) => row[col] === value), builder),
    in: (col: string, values: unknown[]) => (filters.push((row) => values.includes(row[col])), builder),
    order: (col: string, opts?: { ascending?: boolean }) => ((order = { col, ascending: opts?.ascending ?? true }), builder),
    limit: (n: number) => ((limit = n), builder),
    insert: (row: Row) => ((mode = "insert"), (payload = row), builder),
    update: (patch: Row) => ((mode = "update"), (payload = patch), builder),
    maybeSingle: async () => ({ data: (await exec()).data[0] ?? null, error: null }),
    single: async () => ({ data: (await exec()).data[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) =>
      exec().then(resolve, reject),
  };
  return builder;
}

vi.mock("@/lib/db", () => ({ supabaseAdmin: () => ({ from }) }));

const packetModule = await import("@/lib/referral/packet");
const {
  buildPacket,
  pickReferralSession,
  assessReferral,
  intakeHighlights,
  KEY_EVIDENCE_LIMIT,
  INTAKE_HIGHLIGHT_LIMIT,
  ReferRequestSchema,
} = packetModule;
const { formatIsaaScore } = await import("@/lib/scoring");
const { getReferralContext } = await import("@/lib/queries/referrals");
const emailModule = await import("@/lib/email");
const { POST } = await import("@/app/api/cases/[id]/refer/route");

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_1 = "22222222-2222-4222-8222-222222222221";
const SESSION_2 = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-11-07T12:00:00.000Z";

const SUMMARY: ReferralSummary = {
  summary: "Synthetic summary of confirmed observations. This summary documents observations; it is not a diagnosis.",
  reason_for_referral: "Specialist review needed.",
  questions_for_specialist: ["Is further assessment recommended?"],
};

const CASE = { child_alias: "Ravi (synthetic)", child_age_months: 40, therapist_name: "Demo Therapist", facp_score: 55 };

function evidence(recordingId: string, startSec: number, verified = true): Evidence {
  return { quote: `quote at ${startSec}`, segment_id: `s${startSec}`, start_sec: startSec, end_sec: startSec + 4, recording_id: recordingId, verified };
}

type FactSpec = { item: number; value: number | null; status: "suggested" | "confirmed" | "edited"; evidence?: Evidence | null };

function fact(spec: FactSpec, recordingId = SESSION_1) {
  return {
    id: `fact-${recordingId.slice(-1)}-${spec.item}`,
    case_id: CASE_ID,
    recording_id: recordingId,
    instrument: "ISAA",
    item_id: String(spec.item),
    value: spec.value,
    ai_value: spec.value,
    status: spec.status,
    evidence: spec.evidence ?? null,
    confirmed_at: spec.status === "suggested" ? null : NOW,
    confidence: 0.9,
    rationale: "synthetic",
  };
}

const BRIEF: Brief = {
  summary: "Parent-reported synthetic brief.",
  red_flags: [{ type: "self_injury", turn_id: "t17", quote: "he hits his own head" }],
  questions_to_verify: ["q1", "q2", "q3"],
  parent_reported: Array.from({ length: 7 }, (_, i) => ({ field_id: `f${i}`, label: `Label ${i}`, value: `Value ${i}` })),
};

describe("buildPacket", () => {
  it("picks verified key evidence from confirmed/edited facts, sorted by rating desc then item id, max 8", () => {
    const facts = [
      ...[3, 1, 2, 10, 4, 5, 6, 7, 8, 9].map((item) => fact({ item, value: item <= 2 ? 5 : 3, status: "confirmed", evidence: evidence(SESSION_1, item * 10) })),
      fact({ item: 11, value: 4, status: "edited", evidence: evidence(SESSION_1, 110) }),
      fact({ item: 12, value: 5, status: "confirmed", evidence: evidence(SESSION_1, 120, false) }),
      fact({ item: 13, value: 5, status: "suggested", evidence: evidence(SESSION_1, 130) }),
      fact({ item: 14, value: 5, status: "confirmed", evidence: null }),
    ];
    const packet = buildPacket({ caseRow: CASE, session: { id: SESSION_1, session_number: 1 }, isaaFacts: facts, brief: null, summary: SUMMARY, generatedAt: NOW });

    expect(packet.key_evidence).toHaveLength(KEY_EVIDENCE_LIMIT);
    expect(packet.key_evidence.map((e) => e.item_id)).toEqual(["1", "2", "11", "3", "4", "5", "6", "7"]);
    expect(packet.key_evidence[0]).toEqual({
      fact_id: "fact-1-1",
      item_id: "1",
      item_text: "Has poor eye contact",
      rating: 5,
      quote: "quote at 10",
      start_sec: 10,
      recording_id: SESSION_1,
      session_number: 1,
    });
    const ids = packet.key_evidence.map((e) => e.item_id);
    expect(ids).not.toContain("12"); // not verified
    expect(ids).not.toContain("13"); // suggested
    expect(ids).not.toContain("14"); // no evidence
  });

  it("lists every confirmed/edited fact as a decision and nothing suggested", () => {
    const facts = [
      fact({ item: 2, value: 3, status: "edited" }),
      fact({ item: 1, value: 4, status: "confirmed" }),
      fact({ item: 3, value: 5, status: "suggested" }),
      fact({ item: 4, value: null, status: "confirmed" }),
    ];
    const packet = buildPacket({ caseRow: CASE, session: { id: SESSION_1, session_number: 1 }, isaaFacts: facts, brief: null, summary: SUMMARY, generatedAt: NOW });
    expect(packet.decisions).toEqual([
      { item_id: "1", rating: 4, status: "confirmed", confirmed_at: NOW },
      { item_id: "2", rating: 3, status: "edited", confirmed_at: NOW },
    ]);
  });

  it("keeps the first 5 parent-reported intake answers as '<label>: <value>' and none without a brief", () => {
    const packet = buildPacket({ caseRow: CASE, session: { id: SESSION_1, session_number: 1 }, isaaFacts: [], brief: BRIEF, summary: SUMMARY, generatedAt: NOW });
    expect(packet.intake_highlights).toHaveLength(INTAKE_HIGHLIGHT_LIMIT);
    expect(packet.intake_highlights[0]).toBe("Label 0: Value 0");
    expect(packet.intake_highlights[4]).toBe("Label 4: Value 4");
    expect(intakeHighlights(null)).toEqual([]);
  });

  it("scores provisionally from confirmed facts only (minimum_total, 'at least', confirmed domain sums)", () => {
    const facts = [
      fact({ item: 1, value: 5, status: "confirmed" }),
      fact({ item: 2, value: 4, status: "edited" }),
      fact({ item: 3, value: 5, status: "suggested" }),
    ];
    const packet = buildPacket({ caseRow: CASE, session: { id: SESSION_1, session_number: 1 }, isaaFacts: facts, brief: null, summary: SUMMARY, generatedAt: NOW });
    expect(packet.isaa.total).toBeNull();
    expect(packet.isaa.band).toBeNull();
    expect(packet.isaa.confirmed).toBe(2);
    expect(packet.isaa.minimum_total).toBe(5 + 4 + 38);
    expect(packet.isaa.by_domain.find((d) => d.domain_id === "social")).toEqual({ domain_id: "social", name: expect.any(String), score: 9, max: 45 });
    expect(packet.recommendation.provisional).toBe(true);
    expect(formatIsaaScore(packetModule.scoreFromPacket(packet.isaa))).toBe("ISAA total: at least 47 (provisional - 2 of 40 confirmed)");
  });

  it("gives a final total and band when all 40 items are confirmed", () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact({ item: i + 1, value: 2, status: "confirmed" }));
    const packet = buildPacket({ caseRow: CASE, session: { id: SESSION_1, session_number: 1 }, isaaFacts: facts, brief: null, summary: SUMMARY, generatedAt: NOW });
    expect(packet.isaa.total).toBe(80);
    expect(packet.isaa.band).toBe("mild");
    expect(packet.recommendation.reasons[0]).toBe("ISAA total 80 is 70 or more");
  });

  it("never serializes suggested ratings or suggested totals", () => {
    const facts = [
      fact({ item: 15, value: 4, status: "suggested", evidence: evidence(SESSION_1, 150) }),
      fact({ item: 29, value: 5, status: "suggested", evidence: evidence(SESSION_1, 290) }),
      fact({ item: 7, value: 5, status: "suggested", evidence: evidence(SESSION_1, 70) }),
      fact({ item: 1, value: 3, status: "confirmed", evidence: evidence(SESSION_1, 10) }),
    ];
    const packet = buildPacket({ caseRow: CASE, session: { id: SESSION_1, session_number: 1 }, isaaFacts: facts, brief: null, summary: SUMMARY, generatedAt: NOW });
    const json = JSON.stringify(packet);
    expect(json).not.toContain("suggested_total");
    expect(json).not.toContain("suggested_band");
    expect(json).not.toContain('"suggested"');
    for (const id of ["fact-1-15", "fact-1-29", "fact-1-7", "quote at 150", "quote at 290", "quote at 70"]) {
      expect(json).not.toContain(id);
    }
    expect(packet.isaa.minimum_total).toBe(3 + 39);
    expect(packet.red_flags).toEqual([]); // suggested items 15/29 do not raise red flags
    expect(packet.decisions).toEqual([{ item_id: "1", rating: 3, status: "confirmed", confirmed_at: NOW }]);
  });

  it("collects red flags from confirmed items and intake (brief first, then case-sheet booleans), not extraction", () => {
    const facts = [fact({ item: 15, value: 3, status: "confirmed" })];
    const { redFlags, recommendation } = assessReferral({
      isaaFacts: facts,
      facpScore: null,
      brief: BRIEF,
      intakeFlags: { lost_speech: true, self_injury: true },
    });
    expect(redFlags).toEqual([
      { type: "lost_speech", source: "isaa_item", item_id: "15" },
      { type: "self_injury", source: "intake", quote: "he hits his own head", turn_id: "t17" },
    ]);
    expect(recommendation.reasons).toEqual(["Red flag: lost speech", "Red flag: self-injury"]);
  });
});

describe("pickReferralSession", () => {
  it("uses the latest extracted session, ignoring later sessions that are not extracted", () => {
    const sessions = [
      { id: "a", session_number: 1, status: "extracted", kind: "session" },
      { id: "b", session_number: 2, status: "extracted", kind: "session" },
      { id: "c", session_number: 3, status: "transcribed", kind: "session" },
      { id: "d", session_number: null, status: "extracted", kind: "intake_call" },
    ];
    expect(pickReferralSession(sessions)?.id).toBe("b");
    expect(pickReferralSession(sessions.filter((s) => s.id === "c"))).toBeNull();
  });
});

describe("ReferRequestSchema", () => {
  it("requires parent consent to be true", () => {
    const base = { specialist_name: "S", specialist_email: "s@example.com", reason: "abc" };
    const result = ReferRequestSchema.safeParse({ ...base, parent_consent: false });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["parent_consent"], message: "Parent consent is required" });
    expect(ReferRequestSchema.safeParse(base).error?.issues[0]?.message).toBe("Parent consent is required");
    expect(ReferRequestSchema.safeParse({ ...base, parent_consent: true }).success).toBe(true);
    expect(ReferRequestSchema.safeParse({ ...base, specialist_email: "nope", parent_consent: true }).success).toBe(false);
  });
});

describe("POST /api/cases/:id/refer", () => {
  function seed(session2Facts: ReturnType<typeof fact>[]) {
    state.nextId = 1;
    state.tables = {
      cases: [{ id: CASE_ID, ...CASE, status: "in_assessment", created_at: NOW }],
      recordings: [
        { id: SESSION_1, case_id: CASE_ID, kind: "session", session_number: 1, status: "extracted", created_at: "2026-11-07T10:00:00Z" },
        { id: SESSION_2, case_id: CASE_ID, kind: "session", session_number: 2, status: "extracted", created_at: "2026-11-07T11:00:00Z" },
      ],
      facts: [
        fact({ item: 1, value: 5, status: "confirmed", evidence: evidence(SESSION_1, 10) }, SESSION_1),
        fact({ item: 15, value: 4, status: "confirmed", evidence: evidence(SESSION_1, 20) }, SESSION_1),
        ...session2Facts,
      ],
      reports: [{ id: "r1", case_id: CASE_ID, kind: "pre_session_brief", content: BRIEF, created_at: NOW }],
      referrals: [],
      audit_events: [],
    };
  }

  function request(body: unknown, caseId = CASE_ID) {
    return POST(
      new Request(`http://localhost/api/cases/${caseId}/refer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: caseId }) },
    );
  }

  const body = { specialist_name: "Dr. Example Specialist", specialist_email: "specialist@example.com", reason: "Red flag: self-injury", parent_consent: true };

  beforeEach(() => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3002");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 422 when the latest extracted session (the one the tab shows) has no confirmed items, even if an older one has", async () => {
    seed([fact({ item: 1, value: 5, status: "suggested", evidence: evidence(SESSION_2, 10) }, SESSION_2)]);
    const context = await getReferralContext(CASE_ID);
    expect(context?.session?.id).toBe(SESSION_2);

    const res = await request(body);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Confirm at least one ISAA item before referring" });
    expect(state.tables.referrals).toHaveLength(0);
  });

  it("returns 404 for an unknown case and 400 without consent", async () => {
    seed([]);
    const missing = await request(body, "00000000-0000-4000-8000-00000000ffff");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Case not found" });

    const noConsent = await request({ ...body, parent_consent: false });
    expect(noConsent.status).toBe(400);
    expect((await noConsent.json()).details).toMatchObject({ parent_consent: "Parent consent is required" });
  });

  it("returns 502 and stores nothing when Gemini fails", async () => {
    seed([fact({ item: 2, value: 4, status: "confirmed", evidence: evidence(SESSION_2, 30) }, SESSION_2)]);
    vi.stubEnv("DEMO_FIXTURES_DIR", ".tmp/no-such-fixtures-dir");
    const res = await request(body);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Referral could not be prepared" });
    expect(state.tables.referrals).toHaveLength(0);
    expect(state.tables.cases[0].status).toBe("in_assessment");
    expect(state.tables.audit_events.filter((e) => e.action === "referral.created")).toHaveLength(0);
  });

  it("creates the referral from the displayed session, marks the case referred and skips email in demo mode", async () => {
    seed([
      fact({ item: 2, value: 4, status: "confirmed", evidence: evidence(SESSION_2, 30) }, SESSION_2),
      fact({ item: 29, value: 5, status: "suggested", evidence: evidence(SESSION_2, 40) }, SESSION_2),
    ]);
    const res = await request(body);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ emailed: false, email_status: "demo" });
    expect(json.url).toMatch(/^http:\/\/localhost:3002\/specialist\/[A-Za-z0-9_-]{43}$/);

    const [referral] = state.tables.referrals;
    expect(referral).toMatchObject({ status: "sent", parent_consent: true, emailed: false, specialist_email: "specialist@example.com" });
    expect(String(referral.share_token)).toHaveLength(43);
    const packet = referral.packet as ReturnType<typeof buildPacket>;
    expect(packet.key_evidence.map((e) => e.recording_id)).toEqual([SESSION_2]);
    expect(packet.decisions).toEqual([{ item_id: "2", rating: 4, status: "confirmed", confirmed_at: NOW }]);
    expect(JSON.stringify(packet)).not.toContain("suggested_total");
    expect(JSON.stringify(packet)).not.toContain('"suggested"');
    expect(state.tables.cases[0].status).toBe("referred");
    const actions = state.tables.audit_events.map((e) => e.action);
    expect(actions).toContain("referral.created");
    expect(actions).toContain("email.demo_skipped");
  });

  it("still returns 201 with emailed false when the email cannot be sent", async () => {
    seed([fact({ item: 2, value: 4, status: "confirmed", evidence: evidence(SESSION_2, 30) }, SESSION_2)]);
    vi.spyOn(emailModule, "sendEmail").mockRejectedValue(new emailModule.EmailError("Email could not be sent: down"));
    const res = await request(body);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ emailed: false, email_status: "failed" });
    expect(state.tables.referrals).toHaveLength(1);
    expect(state.tables.referrals[0].emailed).toBe(false);
  });
});
