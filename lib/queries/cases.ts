import { supabaseAdmin } from "@/lib/db";
import type { CaseRow, RecordingRow } from "@/lib/types";
import { isUuid } from "@/lib/cases/validation";

export type SessionListItem = Pick<RecordingRow, "id" | "session_number" | "status" | "created_at" | "template">;

// 022 FR-2: owners/admins see all their orgs' cases, members only cases they are assigned to (filtered in SQL).
export async function listCases(userId: string): Promise<CaseRow[]> {
  const { data, error } = await supabaseAdmin().rpc("accessible_cases", { p_user: userId });
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
    .select("id, session_number, status, created_at, template")
    .eq("case_id", caseId)
    .in("kind", ["session", "consult"])
    .order("session_number", { ascending: true });
  if (error) throw new Error(`Could not load sessions: ${error.message}`);
  return (data ?? []) as SessionListItem[];
}
