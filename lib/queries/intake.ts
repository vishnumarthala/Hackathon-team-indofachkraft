import { supabaseAdmin } from "@/lib/db";
import { newToken } from "@/lib/tokens";
import type { CaseRow } from "@/lib/types";

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

// Sets the token only if the case has none yet, so two clicks never produce two links.
export async function ensureIntakeToken(caseRow: CaseRow): Promise<{ token: string; created: boolean }> {
  if (caseRow.intake_token) return { token: caseRow.intake_token, created: false };
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("cases")
    .update({ intake_token: newToken() })
    .eq("id", caseRow.id)
    .is("intake_token", null)
    .select("intake_token");
  if (error) throw new Error(`Could not create the intake link: ${error.message}`);
  const created = data?.[0]?.intake_token as string | undefined;
  if (created) return { token: created, created: true };

  const again = await db.from("cases").select("intake_token").eq("id", caseRow.id).single();
  if (again.error || !again.data?.intake_token) throw new Error("Could not create the intake link");
  return { token: again.data.intake_token as string, created: false };
}
