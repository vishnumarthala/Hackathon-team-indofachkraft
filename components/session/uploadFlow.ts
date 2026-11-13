// Upload -> transcribe -> extract flow of the New session page (008 FR-3, FR-4, FR-5).
// Pure of React so the retry rules can be unit tested with fake dependencies.
import { withConsentHint } from "@/lib/consent/features";
import { isNoteTemplate, type ScribeTemplate } from "@/lib/scribe/templates";

export const MAX_AUDIO_BYTES = 52_428_800;
// Keep in sync with the list accepted by POST /api/cases/:id/sessions (005).
export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/webm",
  "audio/ogg",
] as const;

export const TOO_LARGE = "File too large (max 50 MB)";
export const UNSUPPORTED_TYPE = "Unsupported audio type";
export const NETWORK_ERROR = "Network error - try again";

export function validateAudioFile(file: { size: number; type: string }): string | null {
  if (file.size > MAX_AUDIO_BYTES) return TOO_LARGE;
  if (!(AUDIO_MIME_TYPES as readonly string[]).includes(file.type)) return UNSUPPORTED_TYPE;
  if (file.size < 1) return "The file is empty";
  return null;
}

export type StepId = "upload" | "transcribe" | "extract";
export type StepState = "waiting" | "running" | "done" | "failed";
export const STEP_ORDER: StepId[] = ["upload", "transcribe", "extract"];

export type ApiResult = { ok: boolean; status: number; json: Record<string, unknown> };

export type FlowDeps = {
  post(url: string, body?: unknown): Promise<ApiResult>;
  uploadToSignedUrl(
    path: string,
    token: string,
    file: File,
    contentType: string,
  ): Promise<{ error: { message: string } | null }>;
};

// What has already succeeded; a retry resumes from the first step that is not done.
export type FlowProgress = {
  session: { recordingId: string; path: string; token: string } | null;
  uploaded: boolean;
  transcribed: boolean;
};

export const newProgress = (): FlowProgress => ({ session: null, uploaded: false, transcribed: false });

export type FlowResult = { ok: true; recordingId: string } | { ok: false; step: StepId; error: string };

export function apiError(res: ApiResult, fallback: string): string {
  return typeof res.json.error === "string" ? withConsentHint(res.json.error) : `${fallback} (${res.status})`;
}

export async function runFlow(args: {
  caseId: string;
  file: File;
  progress: FlowProgress;
  deps: FlowDeps;
  onStep: (step: StepId, state: StepState, error?: string) => void;
  /** 038: `Session type` and optional appointment. AI scribe templates run the scribe as the third step. */
  template?: ScribeTemplate;
  appointmentId?: string | null;
}): Promise<FlowResult> {
  const { caseId, file, progress, deps, onStep, template, appointmentId } = args;
  const failed = (step: StepId, error: string): FlowResult => {
    onStep(step, "failed", error);
    return { ok: false, step, error };
  };

  if (!progress.uploaded) {
    onStep("upload", "running");
    if (!progress.session) {
      const res = await deps.post(`/api/cases/${caseId}/sessions`, {
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        consent: true,
        ...(template ? { template } : {}),
        ...(appointmentId ? { appointment_id: appointmentId } : {}),
      });
      const { recording_id, path, token } = res.json;
      if (!res.ok || typeof recording_id !== "string" || typeof path !== "string" || typeof token !== "string") {
        return failed("upload", apiError(res, "Could not start the upload"));
      }
      progress.session = { recordingId: recording_id, path, token };
    }
    const { error } = await deps.uploadToSignedUrl(progress.session.path, progress.session.token, file, file.type);
    // A lost response after a successful upload makes the retry see "already exists": that is done.
    if (error && !/already exists|duplicate/i.test(error.message)) return failed("upload", error.message);
    progress.uploaded = true;
  }
  onStep("upload", "done");
  const recordingId = progress.session!.recordingId;

  if (!progress.transcribed) {
    onStep("transcribe", "running");
    const res = await deps.post(`/api/sessions/${recordingId}/transcribe`);
    if (!res.ok) return failed("transcribe", apiError(res, "Transcription failed"));
    progress.transcribed = true;
  }
  onStep("transcribe", "done");

  onStep("extract", "running");
  const scribe = isNoteTemplate(template);
  const res = await deps.post(`/api/sessions/${recordingId}/${scribe ? "scribe" : "extract"}`);
  if (!res.ok) return failed("extract", apiError(res, scribe ? "The AI scribe failed" : "Extraction failed"));
  onStep("extract", "done");
  return { ok: true, recordingId };
}

export async function postJson(url: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: { error: NETWORK_ERROR } };
  }
}
