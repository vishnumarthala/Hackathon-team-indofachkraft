import { supabaseAdmin } from "@/lib/db";
import { isUuid } from "@/lib/cases/validation";
import { RECORDINGS_BUCKET } from "@/lib/queries/recordings";
import type { EmailStatus, ParentSummaryRow } from "@/lib/parentNote";

export async function getParentSummary(recordingId: string): Promise<ParentSummaryRow | null> {
  if (!isUuid(recordingId)) return null;
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .select("*")
    .eq("recording_id", recordingId)
    .eq("kind", "parent_summary")
    .maybeSingle();
  if (error) throw new Error(`Could not load the parent voice note: ${error.message}`);
  return (data ?? null) as ParentSummaryRow | null;
}

export async function uploadAudio(path: string, audio: Buffer): Promise<void> {
  const { error } = await supabaseAdmin()
    .storage.from(RECORDINGS_BUCKET)
    .upload(path, audio, { contentType: "audio/mpeg", upsert: false });
  if (error) throw new Error(`Could not upload the voice note: ${error.message}`);
}

export async function removeAudio(path: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(RECORDINGS_BUCKET).remove([path]);
  if (error) console.error(`could not remove voice note ${path}: ${error.message}`);
}

export async function signedAudioUrl(path: string, ttlSec: number): Promise<string | null> {
  const { data, error } = await supabaseAdmin().storage.from(RECORDINGS_BUCKET).createSignedUrl(path, ttlSec);
  if (error || !data) {
    console.error(`signed voice note url failed: ${error?.message ?? "no url"}`);
    return null;
  }
  return data.signedUrl;
}

export async function saveParentSummary(row: {
  caseId: string;
  recordingId: string;
  content: unknown;
  contentMd: string;
  audioPath: string | null;
}): Promise<ParentSummaryRow> {
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .upsert(
      {
        case_id: row.caseId,
        recording_id: row.recordingId,
        kind: "parent_summary",
        content: row.content,
        content_md: row.contentMd,
        audio_path: row.audioPath,
        status: "final",
        email_status: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "recording_id,kind" },
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not save the parent voice note: ${error?.message ?? "no row"}`);
  return data as ParentSummaryRow;
}

export async function setEmailStatus(reportId: string, status: EmailStatus): Promise<void> {
  const { error } = await supabaseAdmin().from("reports").update({ email_status: status }).eq("id", reportId);
  if (error) throw new Error(`Could not save the email status: ${error.message}`);
}
