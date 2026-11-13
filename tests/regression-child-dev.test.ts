// Ticket 024 NFR-1 / design rule 8: the Child Development (ISAA) pipeline is byte-identical before and after the
// shared clinical contracts. Runs the real route handlers against the local database in DEMO mode (fixtures for
// Gemini, Scribe, TTS and email): intake simulate -> brief; transcribe; extract; speaker swap + re-extract; swap
// back; confirm; ISAA score and band; report draft + finalise; referral packet; parent voice note. Every output
// (incl. the prompts sent to Gemini) is normalised (ids, timestamps) and compared with the baseline captured on
// the pre-024 code: tests/fixtures/regression-child-dev/baseline.json.
// `UPDATE_REGRESSION_BASELINE=1` rewrites the baseline (only on a commit that predates a behaviour change).
// Synthetic data only; everything is removed afterwards.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { grantSyntheticConsent } from "./helpers/consent";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1" && process.env.DEMO_MODE === "true";

const BASELINE_DIR = path.join(process.cwd(), "tests/fixtures/regression-child-dev");
const BASELINE_FILE = path.join(BASELINE_DIR, "baseline.json");

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

// Records every Gemini request (task, system prompt, prompt) and still answers from the demo fixtures.
const gemini = vi.hoisted(() => ({ calls: [] as { task: string; system: string; prompt: string }[] }));
vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return {
    ...actual,
    generateJson: vi.fn(async (args: Parameters<typeof actual.generateJson>[0]) => {
      gemini.calls.push({ task: args.task, system: args.system ?? "", prompt: args.prompt });
      return actual.generateJson(args);
    }),
  };
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

/** Replaces ids, timestamps and per-run tokens with stable placeholders (uuids numbered by first appearance). */
export function normalise(value: unknown, tokens: Record<string, string> = {}): unknown {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value, (_key, v) => (v instanceof Date ? v.toISOString() : v));
  let out = text;
  for (const [raw, label] of Object.entries(tokens)) out = out.split(raw).join(label);
  out = out
    .replace(UUID, (m) => {
      const key = m.toLowerCase();
      if (!ids.has(key)) ids.set(key, `<uuid-${ids.size + 1}>`);
      return ids.get(key) as string;
    })
    .replace(ISO_TS, "<ts>")
    .replace(DATE, "<date>")
    .replace(/demo-\d{10,}/g, "demo-<n>");
  return JSON.parse(out);
}

describe.skipIf(!enabled)("Child Development pipeline regression (DEMO fixtures, database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let owner: TestUser;
  let caseId: string;
  let sessionId: string;
  let token: string;
  const captured: Record<string, unknown> = {};

  const routes = async () => ({
    simulate: await import("@/app/api/dev/simulate-intake/[token]/route"),
    transcribe: await import("@/app/api/sessions/[id]/transcribe/route"),
    extract: await import("@/app/api/sessions/[id]/extract/route"),
    speakers: await import("@/app/api/sessions/[id]/speakers/route"),
    bulk: await import("@/app/api/sessions/[id]/bulk/route"),
    draft: await import("@/app/api/sessions/[id]/report/route"),
    report: await import("@/app/api/reports/[id]/route"),
    refer: await import("@/app/api/cases/[id]/refer/route"),
    voice: await import("@/app/api/reports/[id]/parent-voice-note/route"),
  });

  async function json(res: Response, status: number) {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  }

  const factColumns = (rows: Record<string, unknown>[]) =>
    rows.map((f) => ({
      instrument: f.instrument,
      item_id: f.item_id,
      value: f.value,
      ai_value: f.ai_value,
      source: f.source,
      evidence: f.evidence,
      confidence: f.confidence === null ? null : Number(f.confidence),
      rationale: f.rationale,
      status: f.status,
      confirmed_by: f.confirmed_by,
    }));

  async function facts(instrument: "ISAA" | "CASE_SHEET", recordingId: string) {
    const rows = await sql<Record<string, unknown>[]>`
      select * from facts where recording_id = ${recordingId} and instrument = ${instrument}
      order by case when item_id ~ '^[0-9]+$' then lpad(item_id, 4, '0') else item_id end`;
    return factColumns(rows);
  }

  async function recording(id: string) {
    const [row] = await sql<Record<string, unknown>[]>`
      select kind, session_number, status, speaker_map, segments, red_flags, language_code, duration_sec::float8 as duration_sec
      from recordings where id = ${id}`;
    return row;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t024reg");
    owner = await world.user("owner", "provider");
    const orgId = await world.org(owner, "Regression centre");
    caseId = randomUUID();
    sessionId = randomUUID();
    token = `t024regtok${randomUUID().replace(/-/g, "")}`;
    await sql`
      insert into cases (id, org_id, child_alias, child_age_months, parent_alias, parent_email, language, therapist_name,
                         status, intake_token)
      values (${caseId}, ${orgId}, 'Ravi (synthetic)', 40, 'Lakshmi (synthetic)', 'parent@example.test', 'te',
              'Demo Therapist', 'booked', ${token})`;
    const [{ child_id }] = await sql<{ child_id: string }[]>`select child_id from cases where id = ${caseId}`;
    world.trackChild(child_id);
    await grantSyntheticConsent(sql, caseId);
    session.user = owner;
  });

  afterAll(async () => {
    session.user = null;
    if (db && caseId) {
      const { data } = await db.storage.from("recordings").list(caseId, { limit: 100 });
      const keys = (data ?? []).map((o) => `${caseId}/${o.name}`);
      if (keys.length) await db.storage.from("recordings").remove(keys);
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("runs the whole pipeline and matches the pre-024 baseline", async () => {
    const r = await routes();
    gemini.calls.length = 0;

    // 1. Intake (demo simulate) -> case-sheet facts + pre-session brief.
    await json(await r.simulate.POST(post(`http://localhost/api/dev/simulate-intake/${token}`), ctx({ token })), 200);
    const [intake] = await sql<{ id: string }[]>`select id from recordings where case_id = ${caseId} and kind = 'intake_call'`;
    const [brief] = await sql<Record<string, unknown>[]>`
      select kind, status, content, content_md from reports where case_id = ${caseId} and kind = 'pre_session_brief'`;
    const [caseAfterIntake] = await sql<Record<string, unknown>[]>`select status from cases where id = ${caseId}`;
    captured.intake = {
      recording: await recording(intake.id),
      case_sheet_facts: await facts("CASE_SHEET", intake.id),
      brief,
      case_status: caseAfterIntake.status,
    };

    // 2. Session upload (any bytes: demo Scribe answers from the fixture) + transcription.
    await sql`
      insert into recordings (id, case_id, kind, session_number, storage_path, mime_type)
      values (${sessionId}, ${caseId}, 'session', 1, ${`${caseId}/${sessionId}.mp3`}, 'audio/mpeg')`;
    const { error: uploadError } = await db.storage
      .from("recordings")
      .upload(`${caseId}/${sessionId}.mp3`, Buffer.from("ID3 synthetic"), { contentType: "audio/mpeg" });
    expect(uploadError).toBeNull();
    captured.transcribe = await json(await r.transcribe.POST(post("http://x"), ctx({ id: sessionId })), 200);
    captured.transcribed = await recording(sessionId);

    // 3. Extraction.
    captured.extract_1 = await json(await r.extract.POST(post("http://x"), ctx({ id: sessionId })), 200);
    captured.facts_1 = await facts("ISAA", sessionId);
    captured.recording_1 = await recording(sessionId);

    // 4. Speaker swap (therapist <-> parent), re-extract with the swapped roles, swap back, re-extract.
    captured.swap_1 = await json(await r.speakers.PATCH(post("http://x", { swap: true }, "PATCH"), ctx({ id: sessionId })), 200);
    captured.swapped = await recording(sessionId);
    captured.facts_after_swap = await facts("ISAA", sessionId);
    captured.extract_swapped = await json(await r.extract.POST(post("http://x"), ctx({ id: sessionId })), 200);
    captured.facts_swapped = await facts("ISAA", sessionId);
    captured.swap_2 = await json(await r.speakers.PATCH(post("http://x", { swap: true }, "PATCH"), ctx({ id: sessionId })), 200);
    captured.extract_2 = await json(await r.extract.POST(post("http://x"), ctx({ id: sessionId })), 200);
    captured.facts_2 = await facts("ISAA", sessionId);
    expect(captured.facts_2).toEqual(captured.facts_1);

    // 5. Therapist confirms: confirm suggestions, rate the rest 1 -> ISAA score, band and recommendation.
    captured.bulk_confirm = await json(
      await r.bulk.POST(post("http://x", { action: "confirm_suggested" }), ctx({ id: sessionId })),
      200,
    );
    captured.bulk_rate = await json(await r.bulk.POST(post("http://x", { action: "rate_unrated", value: 1 }), ctx({ id: sessionId })), 200);
    const confirmed = await facts("ISAA", sessionId);
    captured.facts_confirmed = confirmed;
    const { scoreIsaa, recommend, collectRedFlags, formatIsaaScore } = await import("@/lib/scoring");
    const scoringFacts = confirmed.map((f) => ({ item_id: String(f.item_id), value: f.value as number | null, status: String(f.status) }));
    const score = scoreIsaa(scoringFacts);
    const redFlags = collectRedFlags({
      isaaFacts: scoringFacts,
      extractionRedFlags: (await recording(sessionId)).red_flags as { type: string; segment_id: string; quote: string }[],
    });
    captured.score = { score, red_flags: redFlags, recommendation: recommend({ isaa: score, facpScore: null, redFlags }), text: formatIsaaScore(score) };

    // 6. Report draft + finalise.
    captured.report_draft = await json(await r.draft.POST(post("http://x"), ctx({ id: sessionId })), 200);
    const [report] = await sql<{ id: string }[]>`select id from reports where recording_id = ${sessionId} and kind = 'assessment'`;
    const finalised = await json(await r.report.PATCH(post("http://x", { status: "final" }, "PATCH"), ctx({ id: report.id })), 200);
    const [reportRow] = await sql<Record<string, unknown>[]>`
      select kind, status, content, content_md from reports where id = ${report.id}`;
    captured.report_final = { response_status: finalised.report.status, row: reportRow };

    // 7. Referral packet.
    const referral = await json(
      await r.refer.POST(
        post(`http://localhost/api/cases/${caseId}/refer`, {
          specialist_name: "Dr Specialist (synthetic)",
          specialist_email: "specialist@example.test",
          reason: "Please assess for autism spectrum (synthetic).",
        }),
        ctx({ id: caseId }),
      ),
      201,
    );
    const [referralRow] = await sql<Record<string, unknown>[]>`
      select specialist_name, specialist_email, reason, packet, status, emailed from referrals where id = ${referral.referral_id}`;
    captured.referral = { response: { emailed: referral.emailed, email_status: referral.email_status }, row: referralRow };

    // 8. Parent voice note.
    const voice = await json(await r.voice.POST(post("http://x"), ctx({ id: report.id })), 200);
    const [summaryRow] = await sql<Record<string, unknown>[]>`
      select kind, status, content, content_md, audio_path, email_status from reports
      where recording_id = ${sessionId} and kind = 'parent_summary'`;
    captured.parent_voice_note = { response: { emailed: voice.emailed, email_status: voice.email_status }, row: summaryRow };

    const [caseRow] = await sql<Record<string, unknown>[]>`select status from cases where id = ${caseId}`;
    captured.case_status_final = caseRow.status;
    captured.gemini_requests = gemini.calls;

    const actual = normalise(captured, { [token]: "<intake-token>" });
    if (process.env.UPDATE_REGRESSION_BASELINE === "1") {
      mkdirSync(BASELINE_DIR, { recursive: true });
      writeFileSync(BASELINE_FILE, JSON.stringify(actual, null, 2) + "\n");
    }
    // Also written for the eval's `.tmp/baseline-<port>/` comparison (gitignored).
    const out = path.join(process.cwd(), ".tmp/regression-child-dev");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "actual.json"), JSON.stringify(actual, null, 2) + "\n");

    expect(existsSync(BASELINE_FILE), "baseline missing: run once with UPDATE_REGRESSION_BASELINE=1 on the pre-024 code").toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(BASELINE_FILE, "utf8")));
  });
});
