// Ticket 020 FR-7/FR-8/FR-10: every gated route refuses work without the guardian's consent (table-driven),
// nothing reaches an external processor, and links expire / are revoked. Runs against the local Supabase
// stack (DATABASE_URL); skipped without it or with SKIP_DB_TESTS=1. Synthetic data only.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
const ext = vi.hoisted(() => ({
  generateJson: vi.fn(),
  transcribeAudio: vi.fn(),
  synthesize: vi.fn(),
  startAgentSession: vi.fn(),
  getConversation: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  generateJson: ext.generateJson,
}));
vi.mock("@/lib/elevenlabs/stt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/elevenlabs/stt")>()),
  transcribeAudio: ext.transcribeAudio,
}));
vi.mock("@/lib/elevenlabs/tts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/elevenlabs/tts")>()),
  synthesize: ext.synthesize,
}));
vi.mock("@/lib/elevenlabs/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/elevenlabs/agent")>()),
  startAgentSession: ext.startAgentSession,
  getConversation: ext.getConversation,
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: ext.sendEmail,
}));

const CONSENT_REQUIRED = "Guardian consent required";

describe("pure helpers", () => {
  it("intake links: none / active / expired / revoked, fail closed without a lifetime, grace only when asked", async () => {
    const { intakeLinkState } = await import("@/lib/intake/link");
    const now = Date.parse("2026-11-13T00:00:00Z");
    const row = (exp: string | null, rev: string | null = null, token: string | null = "t") => ({
      intake_token: token,
      intake_token_expires_at: exp,
      intake_token_revoked_at: rev,
    });
    expect(intakeLinkState(row(null, null, null), now)).toBe("none");
    expect(intakeLinkState(row("2026-11-14T00:00:00Z"), now)).toBe("active");
    expect(intakeLinkState(row("2026-11-12T23:00:00Z"), now)).toBe("expired");
    expect(intakeLinkState(row("2026-11-12T23:00:00Z"), now, 2 * 3600_000)).toBe("active");
    expect(intakeLinkState(row("2026-11-14T00:00:00Z", "2026-11-12T00:00:00Z"), now, 2 * 3600_000)).toBe("revoked");
    expect(intakeLinkState(row(null), now)).toBe("expired");
  });

  it("FR-14 hint is appended only to the FR-8 error", async () => {
    const { withConsentHint } = await import("@/lib/consent/features");
    expect(withConsentHint(CONSENT_REQUIRED)).toBe(
      "Guardian consent required. Ask the parent to allow this in their DoctorNearMe app.",
    );
    expect(withConsentHint("Transcription failed")).toBe("Transcription failed");
  });

  it("paper scans are recognised by their bytes, not the declared type", async () => {
    const { sniffScanType } = await import("@/lib/consent/paper");
    expect(sniffScanType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffScanType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffScanType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffScanType(new TextEncoder().encode("<html>"))).toBeNull();
  });
});
const externalCalls = () => Object.values(ext).reduce((n, fn) => n + fn.mock.calls.length, 0);

describe.skipIf(!enabled)("consent gates on every listed processing step (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let provider: TestUser, guardian: TestUser;
  let orgA: string;
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t020g");
    provider = await world.user("provider", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    orgA = await world.org(provider, "Centre A");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_test");
    vi.stubEnv("ELEVENLABS_VOICE_ID_EN", "voice_test");
    for (const fn of Object.values(ext)) fn.mockReset();
    as(provider);
  });

  async function routes() {
    return {
      intakeLink: await import("@/app/api/cases/[id]/intake-link/route"),
      start: await import("@/app/api/intake/[token]/start/route"),
      complete: await import("@/app/api/intake/[token]/complete/route"),
      simulate: await import("@/app/api/dev/simulate-intake/[token]/route"),
      sessions: await import("@/app/api/cases/[id]/sessions/route"),
      transcribe: await import("@/app/api/sessions/[id]/transcribe/route"),
      extract: await import("@/app/api/sessions/[id]/extract/route"),
      report: await import("@/app/api/sessions/[id]/report/route"),
      voiceNote: await import("@/app/api/reports/[id]/parent-voice-note/route"),
      refer: await import("@/app/api/cases/[id]/refer/route"),
      ask: await import("@/app/api/cases/[id]/ask/route"),
    };
  }

  it("FR-7/FR-8: each gated route returns 422 with the FR-8 body and calls no external processor", async () => {
    const r = await routes();
    const c = await world.kase(orgA);
    const u = "http://localhost";
    const table: [string, string, () => Promise<Response>, boolean?][] = [
      ["POST /api/cases/:id/intake-link", "ai_intake_call", () => r.intakeLink.POST(post(`${u}/x`, {}), ctx({ id: c.caseId }))],
      ["POST /api/intake/:token/start", "ai_intake_call", () => r.start.POST(post(`${u}/x`, { language: "en" }), ctx({ token: c.token }))],
      [
        "POST /api/intake/:token/complete",
        "ai_intake_call",
        () => r.complete.POST(post(`${u}/x`, { conversation_id: "conv_t020" }), ctx({ token: c.token })),
      ],
      ["POST /api/dev/simulate-intake/:token", "ai_intake_call", () => r.simulate.POST(post(`${u}/x`), ctx({ token: c.token })), true],
      [
        "POST /api/cases/:id/sessions",
        "session_recording",
        () => r.sessions.POST(post(`${u}/x`, { file_name: "a.wav", mime_type: "audio/wav", size_bytes: 10 }), ctx({ id: c.caseId })),
      ],
      ["POST /api/sessions/:id/transcribe", "ai_transcription", () => r.transcribe.POST(post(`${u}/x`), ctx({ id: c.recordingId }))],
      ["POST /api/sessions/:id/extract", "ai_extraction", () => r.extract.POST(post(`${u}/x`), ctx({ id: c.recordingId }))],
      ["POST /api/sessions/:id/report", "ai_extraction", () => r.report.POST(post(`${u}/x`), ctx({ id: c.recordingId }))],
      ["POST /api/reports/:id/parent-voice-note", "ai_voice_note", () => r.voiceNote.POST(post(`${u}/x`), ctx({ id: c.reportId }))],
      [
        "POST /api/cases/:id/refer",
        "referral_share",
        () =>
          r.refer.POST(
            post(`${u}/x`, { specialist_name: "Dr S", specialist_email: "s@example.test", reason: "Red flags", parent_consent: true }),
            ctx({ id: c.caseId }),
          ),
      ],
    ];
    const rows: string[] = [];
    for (const [name, feature, call, demo] of table) {
      vi.stubEnv("DEMO_MODE", demo ? "true" : "false");
      const res = await call();
      const body = await res.json();
      rows.push(`${name.padEnd(42)} ${feature.padEnd(18)} -> ${res.status} ${JSON.stringify(body)}`);
      expect(res.status, name).toBe(422);
      expect(body, name).toEqual({ error: CONSENT_REQUIRED, details: { feature, child_id: c.childId } });
    }
    console.info(`gated-route table:\n${rows.join("\n")}`);
    expect(externalCalls()).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from recordings where case_id = ${c.caseId}`;
    expect(n).toBe(1); // no new session row, no intake recording
    const [{ token_after }] = await sql<{ token_after: string }[]>`select intake_token as token_after from cases where id = ${c.caseId}`;
    expect(token_after).toBe(c.token);
  });

  it("FR-7: share-link re-checks (specialist page and ask) refuse without referral_share", async () => {
    const r = await routes();
    const c = await world.kase(orgA);
    const share = `t020share${c.caseId.replace(/-/g, "")}`;
    await sql`
      insert into referrals (case_id, share_token, specialist_name, specialist_email, reason, packet, parent_consent)
      values (${c.caseId}, ${share}, 'Dr S', 's@example.test', 'r', '{}'::jsonb, true)`;
    as(null);
    const res = await r.ask.POST(post("http://localhost/x", { share_token: share, question: "Any self-injury?" }), ctx({ id: c.caseId }));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "This link has expired" });
    const { getSharedReferral } = await import("@/lib/queries/referrals");
    expect((await getSharedReferral(share)).state).toBe("unavailable");
    const Page = (await import("@/app/specialist/[token]/page")).default;
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: share }) }));
    expect(html).toContain("This shared case is no longer available.");
    expect(ext.generateJson).not.toHaveBeenCalled();
  });

  it("with consent the same gates let the work through (no 422)", async () => {
    const r = await routes();
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId);
    const link = await r.intakeLink.POST(post("http://localhost/x", {}), ctx({ id: c.caseId }));
    expect(link.status).toBe(200);
    vi.stubEnv("DEMO_MODE", "true");
    as(null);
    const start = await r.start.POST(post("http://localhost/x", { language: "en" }), ctx({ token: c.token }));
    expect(start.status).toBe(200);
    as(provider);
    const upload = await r.sessions.POST(
      post("http://localhost/x", { file_name: "a.wav", mime_type: "audio/wav", size_bytes: 10 }),
      ctx({ id: c.caseId }),
    );
    expect(upload.status).toBe(201);
  });

  it("FR-9/FR-10: withdrawing ai_intake_call revokes the link (410); expired links give 410 and the page message", async () => {
    const r = await routes();
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["ai_intake_call"]);
    as(null);
    vi.stubEnv("DEMO_MODE", "true");
    expect((await r.start.POST(post("http://localhost/x", { language: "en" }), ctx({ token: c.token }))).status).toBe(200);

    await world.withdraw(c.childId, guardian, linkId, ["ai_intake_call"]);
    const [row] = await sql<{ intake_token_revoked_at: Date | null }[]>`select intake_token_revoked_at from cases where id = ${c.caseId}`;
    expect(row.intake_token_revoked_at).not.toBeNull();
    for (const call of [
      () => r.start.POST(post("http://localhost/x", { language: "en" }), ctx({ token: c.token })),
      () => r.complete.POST(post("http://localhost/x", { conversation_id: "conv_x" }), ctx({ token: c.token })),
      () => r.simulate.POST(post("http://localhost/x"), ctx({ token: c.token })),
    ]) {
      const res = await call();
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "This link has expired" });
    }

    // E-4.4: a link older than 7 days (consent granted again, token re-issued, then backdated).
    await world.grant(c.childId, guardian, linkId, ["ai_intake_call"]);
    as(provider);
    const relink = await r.intakeLink.POST(post("http://localhost/x", {}), ctx({ id: c.caseId }));
    expect(relink.status).toBe(200);
    const fresh = ((await relink.json()) as { url: string }).url.split("/").pop() as string;
    expect(fresh).not.toBe(c.token);
    await sql`update cases set intake_token_expires_at = now() - interval '1 minute' where id = ${c.caseId}`;
    as(null);
    const expired = await r.start.POST(post("http://localhost/x", { language: "en" }), ctx({ token: fresh }));
    expect(expired.status).toBe(410);

    // FR-10: DELETE revokes, re-creating issues a new token.
    await sql`update cases set intake_token_expires_at = now() + interval '7 days' where id = ${c.caseId}`;
    as(provider);
    const del = await r.intakeLink.DELETE(post("http://localhost/x", undefined, "DELETE"), ctx({ id: c.caseId }));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: true });
    const [audit] = await sql`select 1 from audit_events where case_id = ${c.caseId} and action = 'intake.link_revoked'`;
    expect(audit).toBeDefined();
    as(null);
    expect((await r.start.POST(post("http://localhost/x", { language: "en" }), ctx({ token: fresh }))).status).toBe(410);
    expect(ext.startAgentSession).not.toHaveBeenCalled();
  });

  it("FR-9: withdrawing referral_share revokes the child's referrals; the share link then gives 410", async () => {
    const r = await routes();
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["referral_share"]);
    const share = `t020share${c.caseId.replace(/-/g, "")}`;
    await sql`
      insert into referrals (case_id, share_token, specialist_name, specialist_email, reason, packet, parent_consent)
      values (${c.caseId}, ${share}, 'Dr S', 's@example.test', 'r', '{}'::jsonb, true)`;
    await world.withdraw(c.childId, guardian, linkId, ["referral_share"]);
    const [ref] = await sql<{ status: string }[]>`select status from referrals where share_token = ${share}`;
    expect(ref.status).toBe("revoked");
    as(null);
    const res = await r.ask.POST(post("http://localhost/x", { share_token: share, question: "Any self-injury?" }), ctx({ id: c.caseId }));
    expect(res.status).toBe(410);
    expect(ext.generateJson).not.toHaveBeenCalled();
  });
});
