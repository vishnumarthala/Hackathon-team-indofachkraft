import path from "node:path";
import { audit } from "@/lib/audit";
import { transcribeAudio, type ScribeResponse } from "@/lib/elevenlabs/stt";
import { requireApiUser } from "@/lib/auth";
import { fail, ok } from "@/lib/http";
import {
  claimForTranscription,
  downloadAudio,
  getRecording,
  hasConfirmedFacts,
  markFailed,
  saveTranscript,
} from "@/lib/queries/recordings";
import { buildSegments, mapSpeakers } from "@/lib/transcript";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const NO_SPEECH = "No speech found in the recording";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const recording = await getRecording(id);
  if (!recording || recording.kind !== "session") return fail(404, "Session not found");
  if (recording.status === "transcribing") return fail(409, "Transcription already running");
  if (await hasConfirmedFacts(id)) return fail(409, "Items already confirmed; create a new session instead");

  const audio = recording.storage_path ? await downloadAudio(recording.storage_path) : null;
  if (!audio || !recording.storage_path) return fail(409, "Audio file not uploaded yet");

  if (!(await claimForTranscription(id))) return fail(409, "Transcription already running");

  let scribe: ScribeResponse;
  try {
    scribe = await transcribeAudio({
      audio,
      fileName: path.posix.basename(recording.storage_path),
      mimeType: recording.mime_type ?? "application/octet-stream",
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
