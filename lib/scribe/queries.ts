// Ticket 038: read models for the scribe review screen (provider) and shared session notes (guardian). Server only.
import { supabaseAdmin } from "@/lib/db";
import { isUuid } from "@/lib/cases/validation";
import { pg } from "@/lib/pg";
import type { Segment } from "@/lib/types";
import { listSuggestions, uploaderCanPrescribe, type GoalSuggestionRow } from "./run";
import type { RxDraftContent, SessionNoteContent } from "./schema";
import type { NoteTemplate } from "./templates";

export const AUDIO_URL_TTL_SEC = 60 * 60;

export type ScribeRecording = {
  id: string;
  case_id: string;
  kind: "session" | "consult";
  template: NoteTemplate;
  status: string;
  error: string | null;
  session_number: number | null;
  segments: Segment[];
  storage_path: string | null;
  appointment_id: string | null;
  created_at: string;
};

export type ScribeNote = {
  id: string;
  status: "draft" | "final";
  content: SessionNoteContent;
  content_md: string;
  updated_at: string;
  published: { version: number; visible_to_guardian: boolean; published_at: string } | null;
};

export type ScribeRx = { id: string; status: "draft" | "final"; content: RxDraftContent; content_md: string };

export type ScribeReview = {
  recording: ScribeRecording;
  note: ScribeNote | null;
  rx: ScribeRx | null;
  suggestions: GoalSuggestionRow[];
  audioUrl: string | null;
  viewerCanPrescribe: boolean;
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

async function signedAudioUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabaseAdmin().storage.from("recordings").createSignedUrl(path, AUDIO_URL_TTL_SEC);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Template of a recording of this case (null = not a recording of the case). */
export async function recordingTemplate(caseId: string, recordingId: string): Promise<string | null> {
  if (!isUuid(caseId) || !isUuid(recordingId)) return null;
  const sql = await pg();
  const [row] = await sql<{ template: string }[]>`
    select template from recordings where id = ${recordingId} and case_id = ${caseId} and kind in ('session', 'consult')`;
  return row?.template ?? null;
}

/** Everything the scribe review needs; null when the recording is not a scribe recording of this case. */
export async function getScribeReview(caseId: string, recordingId: string, viewerUserId: string): Promise<ScribeReview | null> {
  if (!isUuid(caseId) || !isUuid(recordingId)) return null;
  const sql = await pg();
  const [rec] = await sql<ScribeRecording[]>`
    select id, case_id, kind, template, status, error, session_number, segments, storage_path, appointment_id, created_at
    from recordings
    where id = ${recordingId} and case_id = ${caseId} and kind in ('session', 'consult') and template <> 'child_dev_isaa'`;
  if (!rec) return null;
  const reports = await sql<{ id: string; kind: string; status: "draft" | "final"; content: unknown; content_md: string; updated_at: Date }[]>`
    select id, kind, status, content, content_md, updated_at from reports
    where recording_id = ${recordingId} and kind in ('session_note', 'rx_draft')`;
  const noteRow = reports.find((r) => r.kind === "session_note");
  const rxRow = reports.find((r) => r.kind === "rx_draft");
  let note: ScribeNote | null = null;
  if (noteRow) {
    const [pv] = await sql<{ version: number; visible_to_guardian: boolean; published_at: Date }[]>`
      select version, visible_to_guardian, published_at from published_versions
      where entity_type = 'report' and entity_id = ${noteRow.id} order by version desc limit 1`;
    note = {
      id: noteRow.id,
      status: noteRow.status,
      content: noteRow.content as SessionNoteContent,
      content_md: noteRow.content_md,
      updated_at: iso(noteRow.updated_at),
      published: pv ? { version: pv.version, visible_to_guardian: pv.visible_to_guardian, published_at: iso(pv.published_at) } : null,
    };
  }
  const [suggestions, audioUrl, viewerCanPrescribe] = await Promise.all([
    listSuggestions(sql, recordingId),
    signedAudioUrl(rec.storage_path),
    uploaderCanPrescribe(sql, viewerUserId),
  ]);
  return {
    recording: { ...rec, created_at: iso(rec.created_at) },
    note,
    rx: rxRow ? { id: rxRow.id, status: rxRow.status, content: rxRow.content as RxDraftContent, content_md: rxRow.content_md } : null,
    suggestions,
    audioUrl,
    viewerCanPrescribe,
  };
}

export type GuardianSessionNote = {
  report_id: string;
  version: number;
  content_md: string;
  published_at: string;
  org_name: string;
};

/**
 * NFR-1: session notes a guardian may read = the LATEST published version of each finalized session note of the
 * child, only when that version is `visible_to_guardian`. Drafts are never read here. The caller checked the
 * guardian's active link (requireChildGuardianPage).
 */
export async function listGuardianSessionNotes(childId: string): Promise<GuardianSessionNote[]> {
  if (!isUuid(childId)) return [];
  const sql = await pg();
  const rows = await sql<{ report_id: string; version: number; content_md: string; published_at: Date; org_name: string }[]>`
    select latest.entity_id as report_id, latest.version, latest.content_md, latest.published_at,
           coalesce(o.public_name, o.name) as org_name
    from (
      select distinct on (pv.entity_id) pv.*
      from published_versions pv
      join reports r on r.id = pv.entity_id and r.kind = 'session_note' and r.status = 'final'
      where pv.entity_type = 'report' and pv.child_id = ${childId}
      order by pv.entity_id, pv.version desc
    ) latest
    join organizations o on o.id = latest.org_id
    where latest.visible_to_guardian
    order by latest.published_at desc`;
  return rows.map((r) => ({ ...r, published_at: iso(r.published_at) }));
}
