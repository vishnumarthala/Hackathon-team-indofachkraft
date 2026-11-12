import { supabaseAdmin } from "@/lib/db";
import { newToken } from "@/lib/tokens";
import { INTAKE_LINK_DAYS, intakeLinkState } from "@/lib/intake/link";
import { isUuid } from "@/lib/cases/validation";
import type { CaseRow, RecordingRow, ReportRow } from "@/lib/types";

// Tokens from newToken() are 43-char base64url; seeded/demo tokens may be other base64url-ish strings.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export async function getCaseByToken(token: string): Promise<CaseRow | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await supabaseAdmin().from("cases").select("*").eq("intake_token", token).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.message}`);
  return (data ?? null) as CaseRow | null;
}

export async function hasIntakeRecording(caseId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from("recordings")
    .select("id", { count: "exact", head: true })
    .eq("case_id", caseId)
    .eq("kind", "intake_call");
  if (error) throw new Error(`Could not load recordings: ${error.message}`);
  return (count ?? 0) > 0;
}

// Reuses the case's active link; an expired or revoked link is replaced by a new token (FR-10). The
// compare-and-swap on the old token means two clicks never produce two different links.
export async function ensureIntakeToken(caseRow: CaseRow): Promise<{ token: string; created: boolean }> {
  if (caseRow.intake_token && intakeLinkState(caseRow) === "active") return { token: caseRow.intake_token, created: false };
  const db = supabaseAdmin();
  const expiresAt = new Date(Date.now() + INTAKE_LINK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const update = db
    .from("cases")
    .update({ intake_token: newToken(), intake_token_expires_at: expiresAt, intake_token_revoked_at: null })
    .eq("id", caseRow.id);
  const { data, error } = await (caseRow.intake_token ? update.eq("intake_token", caseRow.intake_token) : update.is("intake_token", null))
    .select("intake_token");
  if (error) throw new Error(`Could not create the intake link: ${error.message}`);
  const created = data?.[0]?.intake_token as string | undefined;
  if (created) return { token: created, created: true };

  const again = await db
    .from("cases")
    .select("intake_token, intake_token_expires_at, intake_token_revoked_at")
    .eq("id", caseRow.id)
    .single();
  if (again.error || !again.data?.intake_token || intakeLinkState(again.data as CaseRow) !== "active") {
    throw new Error("Could not create the intake link");
  }
  return { token: again.data.intake_token as string, created: false };
}

/** FR-10: revokes the case's open intake link. True when a link was revoked by this call. */
export async function revokeIntakeToken(caseId: string): Promise<boolean> {
  if (!isUuid(caseId)) return false;
  const { data, error } = await supabaseAdmin()
    .from("cases")
    .update({ intake_token_revoked_at: new Date().toISOString() })
    .eq("id", caseId)
    .not("intake_token", "is", null)
    .is("intake_token_revoked_at", null)
    .select("id");
  if (error) throw new Error(`Could not revoke the intake link: ${error.message}`);
  return (data ?? []).length > 0;
}

export type IntakeBrief = {
  recording: Pick<RecordingRow, "id" | "segments" | "created_at">;
  report: ReportRow | null;
};

// 010: the latest intake recording of a case and its pre-session brief (null when none).
export async function getIntakeBrief(caseId: string): Promise<IntakeBrief | null> {
  if (!isUuid(caseId)) return null;
  const db = supabaseAdmin();
  const rec = await db
    .from("recordings")
    .select("id, segments, created_at")
    .eq("case_id", caseId)
    .eq("kind", "intake_call")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rec.error) throw new Error(`Could not load the intake call: ${rec.error.message}`);
  if (!rec.data) return null;
  const rep = await db
    .from("reports")
    .select("*")
    .eq("recording_id", rec.data.id)
    .eq("kind", "pre_session_brief")
    .maybeSingle();
  if (rep.error) throw new Error(`Could not load the brief: ${rep.error.message}`);
  return { recording: rec.data as IntakeBrief["recording"], report: (rep.data ?? null) as ReportRow | null };
}

// 010 FR-9: marks the case's latest pre-session brief final; null when the case has none.
export async function markBriefReviewed(caseId: string): Promise<ReportRow | null> {
  if (!isUuid(caseId)) return null;
  const db = supabaseAdmin();
  const found = await db
    .from("reports")
    .select("id")
    .eq("case_id", caseId)
    .eq("kind", "pre_session_brief")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (found.error) throw new Error(`Could not load the brief: ${found.error.message}`);
  if (!found.data) return null;
  const { data, error } = await db
    .from("reports")
    .update({ status: "final", updated_at: new Date().toISOString() })
    .eq("id", found.data.id)
    .select("*")
    .single();
  if (error) throw new Error(`Could not update the brief: ${error.message}`);
  return data as ReportRow;
}
