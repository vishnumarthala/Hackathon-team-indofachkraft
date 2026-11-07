import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUDIO_BYTES,
  TOO_LARGE,
  UNSUPPORTED_TYPE,
  newProgress,
  runFlow,
  validateAudioFile,
  type ApiResult,
  type FlowDeps,
  type StepId,
  type StepState,
} from "@/components/session/uploadFlow";

const res = (status: number, json: Record<string, unknown>): ApiResult => ({ ok: status < 400, status, json });
const file = new File([new Uint8Array(10)], "a.wav", { type: "audio/wav" });

function setup(responses: Record<string, ApiResult[]>, uploadError: { message: string } | null = null) {
  const calls: string[] = [];
  const upload = vi.fn(async () => ({ error: uploadError }));
  const deps: FlowDeps = {
    post: async (url) => {
      calls.push(url);
      const key = Object.keys(responses).find((k) => url.endsWith(k))!;
      return responses[key].shift() ?? res(500, {});
    },
    uploadToSignedUrl: upload,
  };
  const states: string[] = [];
  const onStep = (step: StepId, state: StepState) => states.push(`${step}:${state}`);
  return { calls, upload, deps, states, onStep };
}

const created = res(201, { recording_id: "rec-1", path: "c/rec-1.wav", token: "tok" });

describe("validateAudioFile (FR-5)", () => {
  it("accepts audio up to 50 MB", () => {
    expect(validateAudioFile({ size: MAX_AUDIO_BYTES, type: "audio/mpeg" })).toBeNull();
  });
  it("rejects files over 52,428,800 bytes", () => {
    expect(validateAudioFile({ size: MAX_AUDIO_BYTES + 1, type: "audio/wav" })).toBe(TOO_LARGE);
  });
  it("rejects types outside the list", () => {
    expect(validateAudioFile({ size: 10, type: "text/plain" })).toBe(UNSUPPORTED_TYPE);
    expect(validateAudioFile({ size: 10, type: "" })).toBe(UNSUPPORTED_TYPE);
  });
});

describe("runFlow (FR-3, FR-4)", () => {
  it("runs create, upload, transcribe, extract in order and returns the recording id", async () => {
    const s = setup({ "/sessions": [created], "/transcribe": [res(200, {})], "/extract": [res(200, {})] });
    const progress = newProgress();
    const result = await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(result).toEqual({ ok: true, recordingId: "rec-1" });
    expect(s.calls).toEqual(["/api/cases/c/sessions", "/api/sessions/rec-1/transcribe", "/api/sessions/rec-1/extract"]);
    expect(s.upload).toHaveBeenCalledWith("c/rec-1.wav", "tok", file, "audio/wav");
  });

  it("sends file name, MIME type, size and consent when creating the session", async () => {
    const post = vi.fn(async (url: string) => (url.endsWith("/sessions") ? created : res(200, {})));
    await runFlow({
      caseId: "c",
      file,
      progress: newProgress(),
      deps: { post, uploadToSignedUrl: async () => ({ error: null }) },
      onStep: () => {},
    });
    expect(post.mock.calls[0]).toEqual([
      "/api/cases/c/sessions",
      { file_name: "a.wav", mime_type: "audio/wav", size_bytes: 10, consent: true },
    ]);
  });

  it("a failed transcribe shows the API error; retry skips create and upload", async () => {
    const s = setup({
      "/sessions": [created],
      "/transcribe": [res(502, { error: "Transcription failed" }), res(200, {})],
      "/extract": [res(200, {})],
    });
    const progress = newProgress();
    const first = await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(first).toEqual({ ok: false, step: "transcribe", error: "Transcription failed" });
    expect(s.states.at(-1)).toBe("transcribe:failed");

    const second = await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(second).toEqual({ ok: true, recordingId: "rec-1" });
    expect(s.calls.filter((c) => c.endsWith("/sessions"))).toHaveLength(1);
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(s.calls.filter((c) => c.endsWith("/transcribe"))).toHaveLength(2);
  });

  it("a failed extract keeps transcribe done; retry only calls extract", async () => {
    const s = setup({
      "/sessions": [created],
      "/transcribe": [res(200, {})],
      "/extract": [res(502, { error: "Extraction failed" }), res(200, {})],
    });
    const progress = newProgress();
    const first = await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(first).toEqual({ ok: false, step: "extract", error: "Extraction failed" });
    await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(s.calls.filter((c) => c.endsWith("/transcribe"))).toHaveLength(1);
    expect(s.calls.filter((c) => c.endsWith("/extract"))).toHaveLength(2);
  });

  it("a missing extract endpoint (non-JSON 404) fails the extract row with a readable message", async () => {
    const s = setup({ "/sessions": [created], "/transcribe": [res(200, {})], "/extract": [res(404, {})] });
    const result = await runFlow({ caseId: "c", file, progress: newProgress(), deps: s.deps, onStep: s.onStep });
    expect(result).toEqual({ ok: false, step: "extract", error: "Extraction failed (404)" });
  });

  it("a failed upload retries the upload with the same recording, never creating a second one", async () => {
    const s = setup({ "/sessions": [created, created], "/transcribe": [res(200, {})], "/extract": [res(200, {})] }, { message: "network" });
    const progress = newProgress();
    const first = await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(first).toEqual({ ok: false, step: "upload", error: "network" });
    s.upload.mockResolvedValueOnce({ error: null });
    const second = await runFlow({ caseId: "c", file, progress, deps: s.deps, onStep: s.onStep });
    expect(second.ok).toBe(true);
    expect(s.calls.filter((c) => c.endsWith("/sessions"))).toHaveLength(1);
  });

  it("an API error while creating the session fails the upload row and uploads nothing", async () => {
    const s = setup({ "/sessions": [res(400, { error: "Unsupported audio type" })] });
    const result = await runFlow({ caseId: "c", file, progress: newProgress(), deps: s.deps, onStep: s.onStep });
    expect(result).toEqual({ ok: false, step: "upload", error: "Unsupported audio type" });
    expect(s.upload).not.toHaveBeenCalled();
  });
});
