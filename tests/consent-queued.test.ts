// Ticket 020 FR-8: queued/async work re-checks consent right before data leaves for an external processor.
// Pattern for each processor: grant -> work accepted/enqueued -> guardian withdraws -> processor runs ->
// external mock never called, recording `failed` / `consent_withdrawn`, audit `consent.blocked_processing`.
// Local Supabase stack only (DATABASE_URL); synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
const ext = vi.hoisted(() => ({
  generateJson: vi.fn(),
  transcribeAudio: vi.fn(),
  synthesize: vi.fn(),
  sendEmail: vi.fn(),
  beforeClaim: null as null | (() => Promise<void>),
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
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: ext.sendEmail,
}));
// The transcription job is "enqueued" when the recording is claimed; the test withdraws consent right then.
vi.mock("@/lib/queries/recordings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/recordings")>();
  return {
    ...actual,
    claimForTranscription: vi.fn(async (id: string) => {
      const claimed = await actual.claimForTranscription(id);
      if (ext.beforeClaim) await ext.beforeClaim();
      return claimed;
    }),
  };
});

const SECRET = "whsec_t020_synthetic";

describe.skipIf(!enabled)("queued work re-checks consent (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let provider: TestUser, guardian: TestUser;
  let orgA: string;

  async function blockedAudit(caseId: string, stage: string) {
    return sql<{ details: { feature: string; stage: string } }[]>`
      select details from audit_events
      where case_id = ${caseId} and action = 'consent.blocked_processing' and details->>'stage' = ${stage}`;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t020q");
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
    vi.stubEnv("ELEVENLABS_VOICE_ID_EN", "voice_test");
    vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", SECRET);
    for (const fn of [ext.generateJson, ext.transcribeAudio, ext.synthesize, ext.sendEmail]) fn.mockReset();
    ext.beforeClaim = null;
    session.user = provider;
  });

  it("transcription: withdrawn after the job was accepted -> Scribe never called, recording failed, audio deleted", async () => {
    const c = await world.kase(orgA);
    await sql`update recordings set status = 'created' where id = ${c.recordingId}`;
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["session_recording", "ai_transcription"]);
    const audioPath = `${c.caseId}/${c.recordingId}.wav`;
    const audio = readFileSync(path.join(process.cwd(), "demo/audio/sample-short.wav"));
    const up = await db.storage.from("recordings").upload(audioPath, audio, { contentType: "audio/wav", upsert: true });
    expect(up.error).toBeNull();

    ext.beforeClaim = () => world.withdraw(c.childId, guardian, linkId, ["ai_transcription"]);
    const { POST } = await import("@/app/api/sessions/[id]/transcribe/route");
    const res = await POST(post("http://localhost/x"), ctx({ id: c.recordingId }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Guardian consent required",
      details: { feature: "ai_transcription", child_id: c.childId },
    });
    expect(ext.transcribeAudio).not.toHaveBeenCalled();
    const [rec] = await sql<{ status: string; error: string; storage_path: string | null }[]>`
      select status, error, storage_path from recordings where id = ${c.recordingId}`;
    expect(rec).toEqual({ status: "failed", error: "consent_withdrawn", storage_path: null });
    const listed = await db.storage.from("recordings").list(c.caseId);
    expect((listed.data ?? []).map((o) => o.name)).not.toContain(`${c.recordingId}.wav`);
    expect(await blockedAudit(c.caseId, "before_scribe")).toHaveLength(1);
  });

  it("re-transcription of already-processed audio: withdrawn -> Scribe never called, audio kept", async () => {
    const c = await world.kase(orgA); // status 'transcribed': the audio was processed before
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["ai_transcription"]);
    const audioPath = `${c.caseId}/${c.recordingId}.wav`;
    await db.storage.from("recordings").upload(audioPath, readFileSync(path.join(process.cwd(), "demo/audio/sample-short.wav")), {
      contentType: "audio/wav",
      upsert: true,
    });
    ext.beforeClaim = () => world.withdraw(c.childId, guardian, linkId, ["ai_transcription"]);
    const { POST } = await import("@/app/api/sessions/[id]/transcribe/route");
    const res = await POST(post("http://localhost/x"), ctx({ id: c.recordingId }));
    expect(res.status).toBe(422);
    expect(ext.transcribeAudio).not.toHaveBeenCalled();
    const [rec] = await sql<{ status: string; error: string; storage_path: string }[]>`
      select status, error, storage_path from recordings where id = ${c.recordingId}`;
    expect(rec).toEqual({ status: "failed", error: "consent_withdrawn", storage_path: audioPath });
    const listed = await db.storage.from("recordings").list(c.caseId);
    expect((listed.data ?? []).map((o) => o.name)).toContain(`${c.recordingId}.wav`);
    await db.storage.from("recordings").remove([audioPath]);
  });

  it("upload completion: session_recording withdrawn before transcription -> unprocessed audio deleted", async () => {
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["session_recording", "ai_transcription"]);
    const audioPath = `${c.caseId}/${c.recordingId}.wav`;
    await db.storage.from("recordings").upload(audioPath, readFileSync(path.join(process.cwd(), "demo/audio/sample-short.wav")), {
      contentType: "audio/wav",
      upsert: true,
    });
    await sql`update recordings set status = 'created' where id = ${c.recordingId}`; // upload just finished
    await world.withdraw(c.childId, guardian, linkId, ["session_recording"]);
    const { POST } = await import("@/app/api/sessions/[id]/transcribe/route");
    const res = await POST(post("http://localhost/x"), ctx({ id: c.recordingId }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: { feature: string } }).details.feature).toBe("session_recording");
    expect(ext.transcribeAudio).not.toHaveBeenCalled();
    const [rec] = await sql<{ status: string; error: string }[]>`select status, error from recordings where id = ${c.recordingId}`;
    expect(rec).toEqual({ status: "failed", error: "consent_withdrawn" });
    expect(await blockedAudit(c.caseId, "upload_completion")).toHaveLength(1);
  });

  it("extraction: accepted with consent, withdrawn, processor runs -> Gemini never called, recording failed", async () => {
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["ai_extraction"]);
    const { requireCaseConsent } = await import("@/lib/consent");
    expect(await requireCaseConsent(c.caseId, "ai_extraction")).toBeNull(); // accepted

    await world.withdraw(c.childId, guardian, linkId, ["ai_extraction"]);
    const generate = vi.fn();
    const { runExtraction } = await import("@/lib/extraction");
    const outcome = await runExtraction(c.recordingId, { generate });

    expect(outcome).toEqual({
      ok: false,
      status: 422,
      error: "Guardian consent required",
      details: { feature: "ai_extraction", child_id: c.childId },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(ext.generateJson).not.toHaveBeenCalled();
    const [rec] = await sql<{ status: string; error: string }[]>`select status, error from recordings where id = ${c.recordingId}`;
    expect(rec).toEqual({ status: "failed", error: "consent_withdrawn" });
    expect(await blockedAudit(c.caseId, "before_gemini_extraction")).toHaveLength(1);
    const [facts] = await sql<{ n: number }[]>`select count(*)::int as n from facts where recording_id = ${c.recordingId}`;
    expect(facts.n).toBe(0);
  });

  it("voice note: withdrawn while the summary is written -> TTS never called, nothing stored", async () => {
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["ai_voice_note"]);
    ext.generateJson.mockImplementation(async () => {
      await world.withdraw(c.childId, guardian, linkId, ["ai_voice_note"]);
      return { language: "en", text: "Ravi enjoys play with blocks. The therapist will explain the next steps." };
    });
    const { POST } = await import("@/app/api/reports/[id]/parent-voice-note/route");
    const res = await POST(post("http://localhost/x"), ctx({ id: c.reportId }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: { feature: string } }).details.feature).toBe("ai_voice_note");
    expect(ext.synthesize).not.toHaveBeenCalled();
    expect(ext.sendEmail).not.toHaveBeenCalled();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from reports where case_id = ${c.caseId} and kind = 'parent_summary'`;
    expect(n.n).toBe(0);
    expect(await blockedAudit(c.caseId, "before_tts")).toHaveLength(1);
  });

  it("intake webhook: call finished, consent withdrawn before processing -> nothing stored, no Gemini", async () => {
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["ai_intake_call"]);
    await world.withdraw(c.childId, guardian, linkId, ["ai_intake_call"]);

    const { demoPostCallData } = await import("@/lib/intake/process");
    const { signPayload } = await import("@/lib/intake/signature");
    vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
    const body = JSON.stringify({ type: "post_call_transcription", data: demoPostCallData(c.token, `conv_${c.caseId.slice(0, 8)}`) });
    const { POST } = await import("@/app/api/webhooks/elevenlabs/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/elevenlabs", {
        method: "POST",
        headers: { "elevenlabs-signature": signPayload(body, SECRET) },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: "consent_withdrawn" });
    expect(ext.generateJson).not.toHaveBeenCalled();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from recordings where case_id = ${c.caseId} and kind = 'intake_call'`;
    expect(n.n).toBe(0);
    expect(await blockedAudit(c.caseId, "intake_processing")).toHaveLength(1);
  });

  it("brief generation: consent withdrawn after the call was saved -> recording failed, Gemini never called", async () => {
    const c = await world.kase(orgA);
    const linkId = await world.link(c.childId, guardian);
    await world.grant(c.childId, guardian, linkId, ["ai_intake_call"]);
    // Test-only trigger: the guardian withdraws in the same moment the intake recording is saved.
    const fn = `t020_withdraw_${c.caseId.slice(0, 8)}`;
    const payload = JSON.stringify({
      child_id: c.childId,
      action: "withdrawn",
      method: "digital",
      features: ["ai_intake_call"],
      guardian_user_id: guardian.id,
      guardian_link_id: linkId,
    });
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin perform public.record_consent('${payload}'::jsonb); return new; end $f$;
      create trigger ${fn} after insert on public.recordings for each row
      when (new.case_id = '${c.caseId}'::uuid and new.kind = 'intake_call') execute function public.${fn}();`);
    try {
      vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
      const { demoPostCallData, processPostCall } = await import("@/lib/intake/process");
      const result = await processPostCall(demoPostCallData(c.token, `conv_b_${c.caseId.slice(0, 8)}`));
      expect(result).toMatchObject({ received: true, case_id: c.caseId, brief: false });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on public.recordings; drop function if exists public.${fn}();`);
    }
    expect(ext.generateJson).not.toHaveBeenCalled();
    const [rec] = await sql<{ status: string; error: string }[]>`
      select status, error from recordings where case_id = ${c.caseId} and kind = 'intake_call'`;
    expect(rec).toEqual({ status: "failed", error: "consent_withdrawn" });
    expect(await blockedAudit(c.caseId, "brief_generation")).toHaveLength(1);
  });
});
