// Speaker swap (008 FR-6). Pure rules are unit tested; the transaction locks the recording row
// the same way updateFact/bulkUpdate do, so it is serialized against manual decisions and extraction.
import type postgres from "postgres";
import { isUuid } from "@/lib/cases/validation";
import { EXTRACTION_RUNNING, SESSION_NOT_FOUND, db } from "@/lib/facts";
import { isManualDecision, swapSegments, swapSpeakerMap } from "@/lib/speaker-swap";
import type { Segment, SpeakerRole } from "@/lib/types";

export { isManualDecision, swapRole, swapSegments, swapSpeakerMap } from "@/lib/speaker-swap";

export const SWAP_BLOCKED = "Speakers can't be swapped after items are confirmed";
export const TRANSCRIPTION_RUNNING = "Transcription already running";
export const TRANSCRIBE_FIRST = "Transcribe the session first";

export type SwapResult =
  | { ok: true; data: { speaker_map: Record<string, SpeakerRole>; segments_count: number } }
  | { ok: false; status: 404 | 409; error: string };

type Tx = postgres.TransactionSql;

type LockedRecording = {
  id: string;
  case_id: string;
  kind: string;
  status: string;
  speaker_map: Record<string, SpeakerRole> | null;
  segments: Segment[] | null;
};

export async function swapSpeakersInTx(tx: Tx, recordingId: string): Promise<SwapResult> {
  // The row lock comes first: updateFact, bulkUpdate and the extraction claim all wait on it.
  const rows = await tx<LockedRecording[]>`
    select id, case_id, kind, status, speaker_map, segments
    from recordings where id = ${recordingId} for update`;
  const rec = rows[0];
  if (!rec || rec.kind !== "session") return { ok: false, status: 404, error: SESSION_NOT_FOUND };
  if (rec.status === "extracting") return { ok: false, status: 409, error: EXTRACTION_RUNNING };
  if (rec.status === "transcribing") return { ok: false, status: 409, error: TRANSCRIPTION_RUNNING };
  if (rec.status !== "transcribed" && rec.status !== "extracted") {
    return { ok: false, status: 409, error: TRANSCRIBE_FIRST };
  }

  const facts = await tx<{ status: string; source: string }[]>`
    select status, source from facts
    where recording_id = ${recordingId} and instrument = 'ISAA'
    for update`;
  if (facts.some(isManualDecision)) return { ok: false, status: 409, error: SWAP_BLOCKED };

  const speaker_map = swapSpeakerMap(rec.speaker_map ?? {});
  const segments = swapSegments(rec.segments ?? []);

  // Every ISAA result derived from the old mapping goes: AI suggestions, evidence, voice-note
  // confirmations. Extraction red flags are cleared with them.
  const reset = await tx`
    update facts
    set value = null, ai_value = null, evidence = null, confidence = null, rationale = null,
        confirmed_by = null, confirmed_at = null, source = 'session', status = 'suggested'
    where recording_id = ${recordingId} and instrument = 'ISAA'`;
  await tx`
    update recordings
    set speaker_map = ${tx.json(speaker_map)}, segments = ${tx.json(segments)}, red_flags = '[]'::jsonb
    where id = ${recordingId}`;
  await tx`
    insert into audit_events (case_id, actor, action, entity, entity_id, details)
    values (${rec.case_id}, 'therapist', 'recording.speakers_swapped', 'recording', ${recordingId},
            ${tx.json({ segments_count: segments.length, facts_reset: reset.count })})`;

  return { ok: true, data: { speaker_map, segments_count: segments.length } };
}

export async function swapSpeakers(recordingId: string): Promise<SwapResult> {
  if (!isUuid(recordingId)) return { ok: false, status: 404, error: SESSION_NOT_FOUND };
  const sql = await db();
  return sql.begin((tx) => swapSpeakersInTx(tx, recordingId)) as Promise<SwapResult>;
}

// True when the speakers were swapped after the last completed extraction, i.e. the ISAA form was
// cleared and still needs the AI to fill it again (the page shows a retry instead of empty ratings).
export async function needsReextraction(recordingId: string): Promise<boolean> {
  if (!isUuid(recordingId)) return false;
  const sql = await db();
  const rows = await sql<{ swapped: string | null; completed: string | null }[]>`
    select max(id) filter (where action = 'recording.speakers_swapped')::text as swapped,
           max(id) filter (where action = 'extraction.completed')::text as completed
    from audit_events
    where entity = 'recording' and entity_id = ${recordingId}
      and action in ('recording.speakers_swapped', 'extraction.completed')`;
  const { swapped, completed } = rows[0] ?? { swapped: null, completed: null };
  return swapped !== null && (completed === null || BigInt(swapped) > BigInt(completed));
}
