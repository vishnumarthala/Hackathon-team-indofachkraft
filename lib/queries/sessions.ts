import { supabaseAdmin } from "@/lib/db";
import { isUuid } from "@/lib/cases/validation";
import type { CaseRow, FactRow, RecordingRow } from "@/lib/types";

export const AUDIO_URL_TTL_SEC = 60 * 60;

export type SessionReview = {
  caseRow: CaseRow;
  recording: RecordingRow;
  facts: FactRow[];
  audioUrl: string | null;
};

// FR-10: everything the review screen needs. Null when the recording is unknown, not a session,
// or belongs to another case (the page answers 404).
export async function getSessionReview(caseId: string, recordingId: string): Promise<SessionReview | null> {
  if (!isUuid(caseId) || !isUuid(recordingId)) return null;
  const db = supabaseAdmin();

  const [caseRes, recRes] = await Promise.all([
    db.from("cases").select("*").eq("id", caseId).maybeSingle(),
    db.from("recordings").select("*").eq("id", recordingId).eq("case_id", caseId).eq("kind", "session").maybeSingle(),
  ]);
  if (caseRes.error) throw new Error(`Could not load case: ${caseRes.error.message}`);
  if (recRes.error) throw new Error(`Could not load session: ${recRes.error.message}`);
  if (!caseRes.data || !recRes.data) return null;

  const recording = recRes.data as RecordingRow;

  const [factsRes, audioUrl] = await Promise.all([
    db.from("facts").select("*").eq("recording_id", recordingId).eq("instrument", "ISAA"),
    signedAudioUrl(recording.storage_path),
  ]);
  if (factsRes.error) throw new Error(`Could not load facts: ${factsRes.error.message}`);

  const facts = ((factsRes.data ?? []) as FactRow[]).sort((a, b) => Number(a.item_id) - Number(b.item_id));
  return { caseRow: caseRes.data as CaseRow, recording, facts, audioUrl };
}

async function signedAudioUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabaseAdmin().storage.from("recordings").createSignedUrl(path, AUDIO_URL_TTL_SEC);
  if (error || !data) {
    console.error(`signed audio url failed: ${error?.message ?? "no url"}`);
    return null;
  }
  return data.signedUrl;
}
