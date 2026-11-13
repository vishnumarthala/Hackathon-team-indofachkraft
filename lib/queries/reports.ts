import { setActor } from "@/lib/clinical/publish";
import { supabaseAdmin } from "@/lib/db";
import { isUuid } from "@/lib/cases/validation";
import { db } from "@/lib/facts";
import type { FactRow, RecordingRow, ReportRow } from "@/lib/types";

export type ExtractedSession = Pick<RecordingRow, "id" | "session_number" | "created_at">;

export async function getReport(id: string): Promise<ReportRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabaseAdmin().from("reports").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load report: ${error.message}`);
  return (data ?? null) as ReportRow | null;
}

export async function getAssessmentReport(recordingId: string): Promise<ReportRow | null> {
  if (!isUuid(recordingId)) return null;
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .select("*")
    .eq("recording_id", recordingId)
    .eq("kind", "assessment")
    .maybeSingle();
  if (error) throw new Error(`Could not load report: ${error.message}`);
  return (data ?? null) as ReportRow | null;
}

export async function listExtractedSessions(caseId: string): Promise<ExtractedSession[]> {
  if (!isUuid(caseId)) return [];
  const { data, error } = await supabaseAdmin()
    .from("recordings")
    .select("id, session_number, created_at")
    .eq("case_id", caseId)
    .eq("kind", "session")
    .eq("status", "extracted")
    .order("session_number", { ascending: true });
  if (error) throw new Error(`Could not load sessions: ${error.message}`);
  return (data ?? []) as ExtractedSession[];
}

export async function listIsaaFacts(recordingId: string): Promise<FactRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("facts")
    .select("*")
    .eq("recording_id", recordingId)
    .eq("instrument", "ISAA");
  if (error) throw new Error(`Could not load facts: ${error.message}`);
  return (data ?? []) as FactRow[];
}

// The latest pre-session brief summary of the case, if one exists.
export async function getBriefSummary(caseId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .select("content")
    .eq("case_id", caseId)
    .eq("kind", "pre_session_brief")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not load the brief: ${error.message}`);
  const summary = (data?.[0]?.content as { summary?: unknown } | undefined)?.summary;
  return typeof summary === "string" ? summary : null;
}

export type DraftWrite = { content: unknown; content_md: string };
export type DraftResult = { ok: true; report: ReportRow } | { ok: false; final: true };

// Upsert the session's assessment draft; never overwrites a final report (conditional update).
export async function saveAssessmentDraft(
  ids: { caseId: string; recordingId: string },
  draft: DraftWrite,
): Promise<DraftResult> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const fields = { content: draft.content, content_md: draft.content_md, status: "draft", updated_at: now };

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getAssessmentReport(ids.recordingId);
    if (existing) {
      if (existing.status === "final") return { ok: false, final: true };
      const { data, error } = await db
        .from("reports")
        .update(fields)
        .eq("id", existing.id)
        .eq("status", "draft")
        .select("*");
      if (error) throw new Error(`Could not save the report: ${error.message}`);
      if (data && data[0]) return { ok: true, report: data[0] as ReportRow };
      return { ok: false, final: true };
    }
    const { data, error } = await db
      .from("reports")
      .insert({ case_id: ids.caseId, recording_id: ids.recordingId, kind: "assessment", ...fields })
      .select("*");
    if (!error && data && data[0]) return { ok: true, report: data[0] as ReportRow };
    // 23505: another request inserted the row first; read it again and update instead.
    if (error?.code !== "23505") throw new Error(`Could not save the report: ${error?.message ?? "no row"}`);
  }
  throw new Error("Could not save the report");
}

export type ReportPatch = { content_md?: string; status?: "final" };

// Only a draft row changes; returns null when the row is final (or vanished) by the time we write.
// 024 FR-3: finalising runs in one transaction with the actor set, so the `reports_publish_final` trigger
// publishes version 1 (published_versions, published_by = actor) atomically with the status change.
export async function updateDraftReport(id: string, patch: ReportPatch, actorUserId?: string): Promise<ReportRow | null> {
  if (patch.status === "final") return finalizeDraftReport(id, patch, actorUserId ?? null);
  const { data, error } = await supabaseAdmin()
    .from("reports")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "draft")
    .select("*");
  if (error) throw new Error(`Could not save the report: ${error.message}`);
  return (data?.[0] ?? null) as ReportRow | null;
}

async function finalizeDraftReport(id: string, patch: ReportPatch, actorUserId: string | null): Promise<ReportRow | null> {
  if (!isUuid(id)) return null;
  const sql = await db();
  const updated = await sql.begin(async (tx) => {
    if (actorUserId) await setActor(tx, actorUserId);
    const rows = await tx<{ id: string }[]>`
      update reports
      set status = 'final', content_md = coalesce(${patch.content_md ?? null}::text, content_md), updated_at = now()
      where id = ${id} and status = 'draft'
      returning id`;
    return rows.length > 0;
  });
  return updated ? getReport(id) : null;
}
