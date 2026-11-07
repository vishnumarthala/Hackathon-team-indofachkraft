import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRow, ReportRow } from "@/lib/types";

const m = vi.hoisted(() => ({
  getReport: vi.fn(),
  getCase: vi.fn(),
  saveParentSummary: vi.fn(),
  setEmailStatus: vi.fn(),
  uploadAudio: vi.fn(),
  removeAudio: vi.fn(),
  signedAudioUrl: vi.fn(),
  generateJson: vi.fn(),
  synthesize: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/queries/reports", () => ({ getReport: m.getReport }));
vi.mock("@/lib/queries/cases", () => ({ getCase: m.getCase }));
vi.mock("@/lib/queries/parentNote", () => ({
  saveParentSummary: m.saveParentSummary,
  setEmailStatus: m.setEmailStatus,
  uploadAudio: m.uploadAudio,
  removeAudio: m.removeAudio,
  signedAudioUrl: m.signedAudioUrl,
}));
vi.mock("@/lib/gemini", () => ({ generateJson: m.generateJson }));
vi.mock("@/lib/elevenlabs/tts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/elevenlabs/tts")>("@/lib/elevenlabs/tts");
  return { ...actual, synthesize: m.synthesize };
});
vi.mock("@/lib/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { POST } from "@/app/api/reports/[id]/parent-voice-note/route";
import { ParentVoiceNote, buttonLabel, createVoiceNote, type NoteView } from "@/components/report/ParentVoiceNote";
import {
  EMAIL_STATUS_TEXT,
  audioObjectPath,
  buildParentSummaryPrompt,
  emailSubject,
  emailText,
  looksLikeScore,
  noteView,
  parentSummarySystemPrompt,
  type EmailStatus,
  type ParentSummaryRow,
} from "@/lib/parentNote";
import { ParentSummarySchema } from "@/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = ParentSummarySchema.parse(
  JSON.parse(readFileSync(path.join(ROOT, "demo/fixtures/gemini/parent-summary.json"), "utf8")),
);

const CASE: CaseRow = {
  id: "00000000-0000-4000-8000-0000000000c5",
  child_alias: "Ravi (synthetic)",
  child_age_months: 40,
  parent_alias: "Lakshmi (synthetic)",
  parent_email: "parent@example.com",
  parent_phone: null,
  language: "te",
  therapist_name: "Demo Therapist",
  facp_score: null,
  status: "in_assessment",
  intake_token: null,
  created_at: "2026-11-07T00:00:00Z",
};
const REPORT_ID = "00000000-0000-4000-8000-0000000000d1";
const SESSION_ID = "00000000-0000-4000-8000-0000000000e1";
const NOTE_ID = "00000000-0000-4000-8000-0000000000f1";
const assessment = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: REPORT_ID,
  case_id: CASE.id,
  recording_id: SESSION_ID,
  kind: "assessment",
  content: {},
  content_md: "# Assessment report - Ravi (synthetic)\n\nISAA total: 83 · Mild (70-106)\n\nFinal text.",
  audio_path: null,
  status: "final",
  created_at: "2026-11-07T00:00:00Z",
  updated_at: "2026-11-07T00:00:00Z",
  ...over,
});
const noteRow = (over: Partial<ParentSummaryRow> = {}): ParentSummaryRow => ({
  id: NOTE_ID,
  case_id: CASE.id,
  recording_id: SESSION_ID,
  kind: "parent_summary",
  content: FIXTURE,
  content_md: FIXTURE.text,
  audio_path: null,
  status: "final",
  created_at: "2026-11-07T00:00:00Z",
  updated_at: "2026-11-07T00:00:00Z",
  email_status: null,
  ...over,
});

const call = (id = REPORT_ID) =>
  POST(new Request(`http://x/api/reports/${id}/parent-voice-note`, { method: "POST" }), { params: Promise.resolve({ id }) });
const actions = () => m.audit.mock.calls.map((c) => (c[0] as { action: string }).action);

// A tiny in-memory "reports table" so status persistence can be read back like a page reload would.
let stored: ParentSummaryRow | null = null;

beforeEach(() => {
  vi.resetAllMocks();
  stored = null;
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("ELEVENLABS_VOICE_ID_TE", "voice_te");
  vi.stubEnv("ELEVENLABS_API_KEY", "sk_test");
  m.getReport.mockResolvedValue(assessment());
  m.getCase.mockResolvedValue(CASE);
  m.generateJson.mockResolvedValue(FIXTURE);
  m.synthesize.mockResolvedValue(Buffer.from([1, 2, 3]));
  m.uploadAudio.mockResolvedValue(undefined);
  m.signedAudioUrl.mockResolvedValue("https://storage.example/signed?token=abc");
  m.sendEmail.mockResolvedValue({ id: "em_1", delivered: true });
  m.saveParentSummary.mockImplementation(async (row) => {
    stored = noteRow({ content: row.content, content_md: row.contentMd, audio_path: row.audioPath, email_status: null });
    return stored;
  });
  m.setEmailStatus.mockImplementation(async (_id: string, status: EmailStatus) => {
    if (stored) stored = { ...stored, email_status: status };
  });
});
afterEach(() => vi.unstubAllEnvs());

const reloadedText = () =>
  renderToStaticMarkup(createElement(ParentVoiceNote, { reportId: REPORT_ID, initialNote: noteView(stored, "https://storage.example/1h") }));

describe("POST /api/reports/:id/parent-voice-note - preconditions", () => {
  it("404 for an unknown report", async () => {
    m.getReport.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Report not found" });
  });

  it("422 unless the report is a final assessment", async () => {
    for (const over of [{ status: "draft" as const }, { kind: "pre_session_brief" as const }, { kind: "parent_summary" as const }]) {
      m.getReport.mockResolvedValue(assessment(over));
      const res = await call();
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "Finalize the report first" });
    }
    expect(m.generateJson).not.toHaveBeenCalled();
  });

  it("422 `No voice configured for te` before calling Gemini", async () => {
    vi.stubEnv("ELEVENLABS_VOICE_ID_TE", "");
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "No voice configured for te" });
    expect(m.generateJson).not.toHaveBeenCalled();
    expect(m.saveParentSummary).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/:id/parent-voice-note - live path (mocked provider, storage, email)", () => {
  it("sent: Gemini from the final report, TTS, unique upload, report saved, email with 7-day link, status persisted", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emailed).toBe(true);
    expect(body.email_status).toBe("sent");
    expect(body.report.email_status).toBe("sent");

    const req = m.generateJson.mock.calls[0][0];
    expect(req.task).toBe("parent-summary");
    expect(req.system).toBe(parentSummarySystemPrompt());
    expect(req.schema).toBe(ParentSummarySchema);
    expect(req.prompt).toContain("Final text.");
    expect(req.prompt).toContain("te - Telugu");

    expect(m.synthesize).toHaveBeenCalledWith({ text: FIXTURE.text, language: "te" });
    const uploadedPath = m.uploadAudio.mock.calls[0][0] as string;
    expect(uploadedPath).toMatch(new RegExp(`^${CASE.id}/parent-note-${REPORT_ID}-[0-9a-f-]{36}\\.mp3$`));
    expect(m.saveParentSummary.mock.calls[0][0]).toEqual({
      caseId: CASE.id,
      recordingId: SESSION_ID,
      content: FIXTURE,
      contentMd: FIXTURE.text,
      audioPath: uploadedPath,
    });
    expect(m.signedAudioUrl).toHaveBeenCalledWith(uploadedPath, 7 * 24 * 60 * 60);
    const email = m.sendEmail.mock.calls[0][0];
    expect(email.to).toBe("parent@example.com");
    expect(email.subject).toBe("A voice note from Demo Therapist about Ravi (synthetic)");
    expect(email.text).toContain(FIXTURE.text);
    expect(email.text).toContain("https://storage.example/signed?token=abc");
    expect(m.setEmailStatus).toHaveBeenCalledWith(NOTE_ID, "sent");
    expect(actions()).toEqual(["parent_note.sent"]);
    expect(m.audit.mock.calls[0][0].details).toMatchObject({ emailed: true, email_status: "sent", audio: true });

    const reloaded = reloadedText();
    expect(reloaded).toContain("Email sent to parent");
    expect(reloaded).toContain("<audio");
    expect(reloaded).toContain("Recreate and send");
  });

  it("repeated generation uses a new audio object path each time and never deletes the earlier one", async () => {
    await call();
    await call();
    const [a, b] = m.uploadAudio.mock.calls.map((c) => c[0] as string);
    expect(a).not.toBe(b);
    expect(m.removeAudio).not.toHaveBeenCalled();
  });

  it("failed: email error is persisted and audited without claiming it was sent", async () => {
    m.sendEmail.mockRejectedValue(new Error("Email could not be sent: 403"));
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ emailed: false, email_status: "failed" });
    expect(m.setEmailStatus).toHaveBeenCalledWith(NOTE_ID, "failed");
    expect(actions()).toEqual(["parent_note.email_failed"]);
    expect(m.audit.mock.calls[0][0].details).toMatchObject({ emailed: false, email_status: "failed" });
    expect(reloadedText()).toContain("Email could not be sent");
  });

  it("no_email: no parent email on the case, nothing sent", async () => {
    m.getCase.mockResolvedValue({ ...CASE, parent_email: null });
    const body = await (await call()).json();
    expect(body).toMatchObject({ emailed: false, email_status: "no_email" });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.setEmailStatus).toHaveBeenCalledWith(NOTE_ID, "no_email");
    expect(reloadedText()).toContain("No parent email on the case");
  });

  it("provider failure (TTS) -> 502, no upload, no report stored", async () => {
    m.synthesize.mockRejectedValue(new Error("TTS request failed (HTTP 500)"));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Voice note could not be created" });
    expect(m.uploadAudio).not.toHaveBeenCalled();
    expect(m.saveParentSummary).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(actions()).toEqual(["parent_note.failed"]);
  });

  it("Gemini failure or score-like/wrong-language text -> 502, nothing stored", async () => {
    m.generateJson.mockRejectedValueOnce(new Error("Gemini request failed"));
    expect((await call()).status).toBe(502);
    m.generateJson.mockResolvedValueOnce({ language: "te", text: "రవి ISAA 83/200" });
    expect((await call()).status).toBe(502);
    m.generateJson.mockResolvedValueOnce({ language: "en", text: "Hello." });
    expect((await call()).status).toBe(502);
    expect(m.synthesize).not.toHaveBeenCalled();
    expect(m.saveParentSummary).not.toHaveBeenCalled();
  });

  it("report persistence failure removes the uploaded object and sends no email", async () => {
    m.saveParentSummary.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(500);
    const uploaded = m.uploadAudio.mock.calls[0][0];
    expect(m.removeAudio).toHaveBeenCalledWith(uploaded);
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(actions()).toEqual(["parent_note.failed"]);
  });

  it("upload failure -> 500 and no report stored", async () => {
    m.uploadAudio.mockRejectedValue(new Error("storage down"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(m.saveParentSummary).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/:id/parent-voice-note - DEMO_MODE", () => {
  it("demo: no TTS/upload, audio_path null, status demo persisted", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ELEVENLABS_VOICE_ID_TE", "");
    m.sendEmail.mockResolvedValue({ id: "demo", delivered: false });
    const body = await (await call()).json();
    expect(body).toMatchObject({ emailed: false, email_status: "demo" });
    expect(body.report.audio_path).toBeNull();
    expect(m.synthesize).not.toHaveBeenCalled();
    expect(m.uploadAudio).not.toHaveBeenCalled();
    expect(m.sendEmail.mock.calls[0][0].text).toBe(FIXTURE.text);
    expect(m.setEmailStatus).toHaveBeenCalledWith(NOTE_ID, "demo");
    const reloaded = reloadedText();
    expect(reloaded).toContain("Email not sent (demo mode)");
    expect(reloaded).toContain("Voice note skipped in demo mode");
    expect(reloaded).not.toContain("<audio");
  });
});

describe("helpers and component", () => {
  it("fixture and prompt rules (NFR-2, FR-4)", () => {
    expect(looksLikeScore(FIXTURE.text)).toBe(false);
    expect(/[ఀ-౿]/.test(FIXTURE.text)).toBe(true);
    for (const bad of ["ISAA total", "83/200", "score 107", "/ 200", "FACP"]) expect(looksLikeScore(bad)).toBe(true);
    expect(looksLikeScore("He used a few words at age 2.")).toBe(false);
    const system = parentSummarySystemPrompt();
    expect(system).toMatch(/Telugu script/);
    expect(system).toMatch(/Devanagari/);
    expect(system).toMatch(/120 words/);
    expect(system).toMatch(/autism/);
    expect(system).toContain("Your therapist will talk with you about the next steps.");
  });

  it("subject, email text, unique paths, prompt", () => {
    expect(emailSubject("T", "C")).toBe("A voice note from T about C");
    expect(emailText("Hi", null)).toBe("Hi");
    expect(emailText("Hi", "https://u")).toContain("https://u");
    expect(audioObjectPath("c", "r")).not.toBe(audioObjectPath("c", "r"));
    expect(buildParentSummaryPrompt({ language: "hi", parentAlias: "P", childAlias: "C", reportMd: "MD" })).toContain("Devanagari");
  });

  it("renders all four persisted email statuses and both button labels", () => {
    for (const status of ["sent", "demo", "no_email", "failed"] as EmailStatus[]) {
      const html = renderToStaticMarkup(
        createElement(ParentVoiceNote, { reportId: REPORT_ID, initialNote: noteView(noteRow({ email_status: status }), null) }),
      );
      expect(html).toContain(EMAIL_STATUS_TEXT[status]);
    }
    const empty = renderToStaticMarkup(createElement(ParentVoiceNote, { reportId: REPORT_ID, initialNote: null }));
    expect(empty).toContain("<h2");
    expect(empty).toContain("Parent voice note");
    expect(empty).toContain("Create and send voice note");
    expect(buttonLabel({} as NoteView)).toBe("Recreate and send");
  });

  it("createVoiceNote maps the API response and errors", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ report: { content_md: "T", audio_path: null }, emailed: false, email_status: "demo" })));
    expect(await createVoiceNote(ok, REPORT_ID)).toEqual({
      ok: true,
      note: { text: "T", hasAudio: false, audioUrl: null, emailStatus: "demo" },
    });
    expect(ok).toHaveBeenCalledWith(`/api/reports/${REPORT_ID}/parent-voice-note`, { method: "POST" });
    const bad = vi.fn(async () => new Response(JSON.stringify({ error: "Finalize the report first" }), { status: 422 }));
    expect(await createVoiceNote(bad, REPORT_ID)).toEqual({ ok: false, error: "Finalize the report first" });
  });
});
