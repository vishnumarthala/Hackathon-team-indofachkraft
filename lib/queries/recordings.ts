import { supabaseAdmin } from "@/lib/db";
import { isUuid } from "@/lib/cases/validation";
import type { RecordingRow, Segment, SpeakerRole } from "@/lib/types";

export const RECORDINGS_BUCKET = "recordings";

export async function getRecording(id: string): Promise<RecordingRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabaseAdmin().from("recordings").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load recording: ${error.message}`);
  return (data ?? null) as RecordingRow | null;
}

export async function nextSessionNumber(caseId: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("recordings")
    .select("session_number")
    .eq("case_id", caseId)
    .in("kind", ["session", "consult"])
    .not("session_number", "is", null)
    .order("session_number", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not load sessions: ${error.message}`);
  return ((data?.[0]?.session_number as number | undefined) ?? 0) + 1;
}

export async function insertSessionRecording(row: {
  id: string;
  case_id: string;
  session_number: number;
  storage_path: string;
  mime_type: string;
  /** 038: AI scribe recordings (default: the ISAA session path). */
  kind?: "session" | "consult";
  template?: string;
  uploaded_by?: string | null;
  appointment_id?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("recordings")
    .insert({ ...row, kind: row.kind ?? "session", status: "created" });
  if (error) throw new Error(`Could not create the recording: ${error.message}`);
}

export async function deleteRecording(id: string): Promise<void> {
  await supabaseAdmin().from("recordings").delete().eq("id", id);
}

export async function hasConfirmedFacts(recordingId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from("facts")
    .select("id", { count: "exact", head: true })
    .eq("recording_id", recordingId)
    .in("status", ["confirmed", "edited"]);
  if (error) throw new Error(`Could not load facts: ${error.message}`);
  return (count ?? 0) > 0;
}

// Returns null when the object does not exist (not uploaded yet).
export async function downloadAudio(path: string): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin().storage.from(RECORDINGS_BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

// One conditional update: only one request can move a recording into `transcribing`.
export async function claimForTranscription(id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("recordings")
    .update({ status: "transcribing", error: null })
    .eq("id", id)
    .neq("status", "transcribing")
    .select("id");
  if (error) throw new Error(`Could not claim the recording: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function markFailed(id: string, message: string): Promise<void> {
  const { error } = await supabaseAdmin().from("recordings").update({ status: "failed", error: message }).eq("id", id);
  if (error) console.error(`could not mark recording ${id} failed: ${error.message}`);
}

export async function saveTranscript(
  id: string,
  t: { segments: Segment[]; speaker_map: Record<string, SpeakerRole>; duration_sec: number; language_code: string | null },
): Promise<void> {
  const db = supabaseAdmin();
  // Only `suggested` facts can exist here; confirmed/edited ones block re-transcription.
  const del = await db.from("facts").delete().eq("recording_id", id).eq("instrument", "ISAA");
  if (del.error) throw new Error(`Could not clear old facts: ${del.error.message}`);
  const { error } = await db
    .from("recordings")
    .update({ ...t, red_flags: [], status: "transcribed", error: null })
    .eq("id", id);
  if (error) throw new Error(`Could not save the transcript: ${error.message}`);
}
