import { supabaseAdmin } from "@/lib/db";
import type { CaseRow, RecordingRow } from "@/lib/types";
import { isUuid } from "@/lib/cases/validation";

export type SessionListItem = Pick<RecordingRow, "id" | "session_number" | "status" | "created_at">;

export async function listCases(): Promise<CaseRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("cases")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load cases: ${error.message}`);
  return (data ?? []) as CaseRow[];
}

export async function getCase(id: string): Promise<CaseRow | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabaseAdmin().from("cases").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.message}`);
  return (data ?? null) as CaseRow | null;
}

export async function listSessions(caseId: string): Promise<SessionListItem[]> {
  if (!isUuid(caseId)) return [];
  const { data, error } = await supabaseAdmin()
    .from("recordings")
    .select("id, session_number, status, created_at")
    .eq("case_id", caseId)
    .eq("kind", "session")
    .order("session_number", { ascending: true });
  if (error) throw new Error(`Could not load sessions: ${error.message}`);
  return (data ?? []) as SessionListItem[];
}
