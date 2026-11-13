// Ticket 038 FR-5: the session note editor's writes. Server only. Callers passed the recording gate
// (requireRecordingActor) first.
//
// - `saveSessionNoteDraft`  - edit the markdown of a draft note.
// - `finalizeSessionNote`   - the note becomes `final` and is published through 024 `publishVersion` in the same
//                             transaction, with the clinician's `visible_to_guardian` choice (default off, NFR-1).
//                             The published text has the audio citation links removed (guardians never get audio).
// - `setSessionNoteSharing` - share / stop sharing a final note: a new published version with the same text.
// Both publishing writes are strict audit actions (041).
import { auditStrict } from "@/lib/audit";
import { getLatestPublished, publishVersion } from "@/lib/clinical/publish";
import { pg, type Tx } from "@/lib/pg";
import { stripCitations, violatesCopyRules } from "./process";

export const NOTE_MESSAGES = {
  notFound: "No session note yet. Run the AI scribe first.",
  final: "This note is final",
  notFinal: "Finalize the note first",
  copyRule: "Notes shared with the family must not name a condition. Reword the clinical labels before sharing.",
  unchanged: "The note is already shared this way",
} as const;

export type NoteFailure = { ok: false; status: 404 | 409 | 422; error: string };
export type NoteRow = { id: string; case_id: string; status: "draft" | "final"; content_md: string; updated_at: string };

async function lockNote(tx: Tx, recordingId: string): Promise<NoteRow | null> {
  const rows = await tx<NoteRow[]>`
    select id, case_id, status, content_md, updated_at from reports
    where recording_id = ${recordingId} and kind = 'session_note' for update`;
  return rows[0] ?? null;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function saveSessionNoteDraft(input: {
  recordingId: string;
  contentMd: string;
  actorUserId: string;
}): Promise<{ ok: true; note: NoteRow } | NoteFailure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const note = await lockNote(tx, input.recordingId);
    if (!note) return { ok: false as const, status: 404 as const, error: NOTE_MESSAGES.notFound };
    if (note.status === "final") return { ok: false as const, status: 409 as const, error: NOTE_MESSAGES.final };
    const [row] = await tx<NoteRow[]>`
      update reports set content_md = ${input.contentMd}, updated_at = now() where id = ${note.id}
      returning id, case_id, status, content_md, updated_at`;
    await auditStrict(
      {
        caseId: note.case_id,
        actorUserId: input.actorUserId,
        action: "scribe.note_edited",
        entity: "report",
        entityId: note.id,
        details: { chars: input.contentMd.length },
      },
      tx,
    );
    return { ok: true as const, note: { ...row, updated_at: iso(row.updated_at) } };
  });
}

export async function finalizeSessionNote(input: {
  recordingId: string;
  contentMd?: string;
  visibleToGuardian: boolean;
  actorUserId: string;
}): Promise<{ ok: true; note: NoteRow; published_version: number; visible_to_guardian: boolean } | NoteFailure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const note = await lockNote(tx, input.recordingId);
    if (!note) return { ok: false as const, status: 404 as const, error: NOTE_MESSAGES.notFound };
    if (note.status === "final") return { ok: false as const, status: 409 as const, error: NOTE_MESSAGES.final };
    const content = input.contentMd ?? note.content_md;
    const published = stripCitations(content);
    if (input.visibleToGuardian && violatesCopyRules(published)) {
      return { ok: false as const, status: 422 as const, error: NOTE_MESSAGES.copyRule };
    }
    const [row] = await tx<NoteRow[]>`
      update reports set content_md = ${content}, status = 'final', updated_at = now() where id = ${note.id}
      returning id, case_id, status, content_md, updated_at`;
    const version = await publishVersion(tx, {
      entityType: "report",
      entityId: note.id,
      caseId: note.case_id,
      contentMd: published,
      visibleToGuardian: input.visibleToGuardian,
      publishedBy: input.actorUserId,
    });
    await auditStrict(
      {
        caseId: note.case_id,
        actorUserId: input.actorUserId,
        action: "scribe.note_finalized",
        entity: "report",
        entityId: note.id,
        details: { version: version.version, visible_to_guardian: input.visibleToGuardian },
      },
      tx,
    );
    return {
      ok: true as const,
      note: { ...row, updated_at: iso(row.updated_at) },
      published_version: version.version,
      visible_to_guardian: input.visibleToGuardian,
    };
  });
}

export async function setSessionNoteSharing(input: {
  recordingId: string;
  visibleToGuardian: boolean;
  actorUserId: string;
}): Promise<{ ok: true; published_version: number; visible_to_guardian: boolean } | NoteFailure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const note = await lockNote(tx, input.recordingId);
    if (!note) return { ok: false as const, status: 404 as const, error: NOTE_MESSAGES.notFound };
    if (note.status !== "final") return { ok: false as const, status: 409 as const, error: NOTE_MESSAGES.notFinal };
    const latest = await getLatestPublished(tx, "report", note.id);
    if (latest && latest.visible_to_guardian === input.visibleToGuardian) {
      return { ok: false as const, status: 409 as const, error: NOTE_MESSAGES.unchanged };
    }
    const published = latest?.content_md ?? stripCitations(note.content_md);
    if (input.visibleToGuardian && violatesCopyRules(published)) {
      return { ok: false as const, status: 422 as const, error: NOTE_MESSAGES.copyRule };
    }
    const version = await publishVersion(tx, {
      entityType: "report",
      entityId: note.id,
      caseId: note.case_id,
      contentMd: published,
      visibleToGuardian: input.visibleToGuardian,
      publishedBy: input.actorUserId,
    });
    await auditStrict(
      {
        caseId: note.case_id,
        actorUserId: input.actorUserId,
        action: "scribe.note_sharing_changed",
        entity: "report",
        entityId: note.id,
        details: { version: version.version, visible_to_guardian: input.visibleToGuardian },
      },
      tx,
    );
    return { ok: true as const, published_version: version.version, visible_to_guardian: input.visibleToGuardian };
  });
}
