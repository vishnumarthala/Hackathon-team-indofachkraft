import path from "node:path";
import { audit } from "@/lib/audit";
import { transcribeAudio, type ScribeResponse } from "@/lib/elevenlabs/stt";
import { requireRecordingAccess } from "@/lib/authz";
import { assertConsentOrAbort, childIdForCase, consentRequired, requireConsent } from "@/lib/consent";
import { fail, ok } from "@/lib/http";
import {
  claimForTranscription,
  downloadAudio,
  getRecording,
  hasConfirmedFacts,
  markFailed,
  saveTranscript,
} from "@/lib/queries/recordings";
import { demoTranscriptFor } from "@/lib/scribe/templates";
import { buildSegments, mapSpeakers } from "@/lib/transcript";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const NO_SPEECH = "No speech found in the recording";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireRecordingAccess(id);
  if (denied) return denied;
  const recording = await getRecording(id);
  // 038: in-clinic consults (`consult`) are transcribed the same way as sessions.
  if (!recording || (recording.kind !== "session" && recording.kind !== "consult")) return fail(404, "Session not found");
  const childId = await childIdForCase(recording.case_id);
  const blocked = await requireConsent(childId, "ai_transcription");
  if (blocked) return blocked;
  if (recording.status === "transcribing") return fail(409, "Transcription already running");
  if (await hasConfirmedFacts(id)) return fail(409, "Items already confirmed; create a new session instead");

  const audio = recording.storage_path ? await downloadAudio(recording.storage_path) : null;
  if (!audio || !recording.storage_path) return fail(409, "Audio file not uploaded yet");
  // 020 FR-7: a `created` recording has just finished uploading and was never processed: upload completion
  // re-checks session_recording, and without it the unprocessed audio is deleted. (Re-transcribing audio
  // that was already processed needs only ai_transcription.)
  const uploadStage = {
    stage: "upload_completion",
    caseId: recording.case_id,
    recordingId: id,
    markRecordingFailed: true,
    audioPath: recording.storage_path,
  };
  if (recording.status === "created" && !(await assertConsentOrAbort(childId, "session_recording", uploadStage))) {
    return consentRequired(childId, "session_recording");
  }

  if (!(await claimForTranscription(id))) return fail(409, "Transcription already running");

  // 020 FR-8: last check before the audio leaves for ElevenLabs Scribe. Audio that was already processed
  // once is kept (withdrawal does not delete processed records); never-processed audio is deleted.
  const scribeStage = {
    ...uploadStage,
    stage: "before_scribe",
    audioPath: recording.status === "created" ? recording.storage_path : null,
  };
  if (!(await assertConsentOrAbort(childId, "ai_transcription", scribeStage))) {
    return consentRequired(childId, "ai_transcription");
  }

  let scribe: ScribeResponse;
  try {
    scribe = await transcribeAudio({
      audio,
      fileName: path.posix.basename(recording.storage_path),
      mimeType: recording.mime_type ?? "application/octet-stream",
      demoFixture: demoTranscriptFor(recording.template),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(id, message);
    await audit({
      caseId: recording.case_id,
      actor: "system",
      action: "recording.transcribe_failed",
      entity: "recording",
      entityId: id,
      details: { error: message },
    });
    return fail(502, "Transcription failed", message);
  }

  const words = scribe.words.filter((w) => w.type === "word");
  if (words.length === 0) {
    await markFailed(id, NO_SPEECH);
    return fail(422, NO_SPEECH);
  }

  const { segments, speaker_map } = mapSpeakers(buildSegments(scribe.words));
  const duration_sec = words[words.length - 1].end ?? segments[segments.length - 1]?.end_sec ?? 0;
  try {
    await saveTranscript(id, { segments, speaker_map, duration_sec, language_code: scribe.language_code ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(id, message);
    return fail(500, "Could not save the transcript");
  }

  await audit({
    caseId: recording.case_id,
    actor: "system",
    action: "recording.transcribed",
    entity: "recording",
    entityId: id,
    details: { segments_count: segments.length, duration_sec },
  });

  return ok({ recording_id: id, status: "transcribed", segments_count: segments.length, duration_sec, speaker_map });
}
