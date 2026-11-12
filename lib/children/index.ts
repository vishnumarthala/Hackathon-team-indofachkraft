// Ticket 020: children, guardian links and claim codes. Server only (pure helpers are in ./codes.ts).
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import type { Relationship } from "@/lib/consent/features";

if (typeof window !== "undefined") {
  throw new Error("lib/children is server-only");
}

export * from "./codes";

export type ChildSource = "guardian" | "provider" | "legacy_case";
export type ChildSex = "female" | "male" | "other" | "undisclosed";

export type ChildRow = {
  id: string;
  display_name: string;
  date_of_birth: string | null;
  sex: ChildSex | null;
  source: ChildSource;
  created_by: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type GuardianLinkRow = {
  id: string;
  child_id: string;
  user_id: string;
  relationship: Relationship;
  status: "active" | "revoked";
  verification_method: "self_registered" | "claim_code";
  declared_at: string;
  created_at: string;
  revoked_at: string | null;
};

export const CHILD_COLUMNS = "id, display_name, date_of_birth, sex, source, created_by, created_at, deleted_at";
const LINK_COLUMNS = "id, child_id, user_id, relationship, status, verification_method, declared_at, created_at, revoked_at";

export async function getChild(childId: string): Promise<ChildRow | null> {
  if (!isUuid(childId)) return null;
  const { data, error } = await supabaseAdmin().from("children").select(CHILD_COLUMNS).eq("id", childId).maybeSingle();
  if (error) throw new Error(`Could not load child: ${error.message}`);
  return (data ?? null) as ChildRow | null;
}

/** The user's active link to a live child, or null (FR-15/FR-16: checked on every request). */
export async function getActiveGuardianLink(
  childId: string,
  userId: string,
): Promise<{ link: GuardianLinkRow; child: ChildRow } | null> {
  if (!isUuid(childId)) return null;
  const { data, error } = await supabaseAdmin()
    .from("guardian_links")
    .select(LINK_COLUMNS)
    .eq("child_id", childId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not load guardian link: ${error.message}`);
  if (!data) return null;
  const child = await getChild(childId);
  if (!child || child.deleted_at) return null;
  return { link: data as GuardianLinkRow, child };
}

export async function listGuardianChildren(userId: string): Promise<{ link: GuardianLinkRow; child: ChildRow }[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("guardian_links")
    .select(LINK_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load children: ${error.message}`);
  const links = (data ?? []) as GuardianLinkRow[];
  if (links.length === 0) return [];
  const { data: rows, error: childError } = await db
    .from("children")
    .select(CHILD_COLUMNS)
    .in(
      "id",
      links.map((l) => l.child_id),
    )
    .is("deleted_at", null);
  if (childError) throw new Error(`Could not load children: ${childError.message}`);
  const byId = new Map(((rows ?? []) as ChildRow[]).map((c) => [c.id, c]));
  return links.flatMap((link) => {
    const child = byId.get(link.child_id);
    return child ? [{ link, child }] : [];
  });
}

export async function countActiveGuardians(childId: string): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from("guardian_links")
    .select("id", { count: "exact", head: true })
    .eq("child_id", childId)
    .eq("status", "active");
  if (error) throw new Error(`Could not load guardian links: ${error.message}`);
  return count ?? 0;
}

export async function createGuardianChild(input: {
  userId: string;
  displayName: string;
  dateOfBirth: string | null;
  sex: ChildSex | null;
  relationship: Relationship;
}): Promise<ChildRow> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("create_guardian_child", {
    p_user: input.userId,
    p_display_name: input.displayName,
    p_dob: input.dateOfBirth,
    p_sex: input.sex,
    p_relationship: input.relationship,
  });
  if (error || typeof data !== "string") throw new Error(`Could not add the child: ${error?.message ?? "no id"}`);
  const child = await getChild(data);
  if (!child) throw new Error("Could not add the child");
  return child;
}

/** FR-16: the guardian stops being linked; takes effect on the next request. */
export async function revokeGuardianLink(childId: string, userId: string, revokedBy: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("guardian_links")
    .update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: revokedBy })
    .eq("child_id", childId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(`Could not update the link: ${error.message}`);
  return (data ?? []).length > 0;
}

export type CreatedClaimCode = { id: string; child_id: string; expires_at: string };

export async function storeClaimCode(caseId: string, codeHash: string, createdBy: string, ttlHours: number) {
  const { data, error } = await supabaseAdmin().rpc("create_child_claim_code", {
    p_case: caseId,
    p_hash: codeHash,
    p_created_by: createdBy,
    p_ttl: `${ttlHours} hours`,
  });
  if (error || !data) throw new Error(`Could not create the code: ${error?.message ?? "no result"}`);
  return data as CreatedClaimCode;
}

export type ClaimResult =
  | { result: "claimed"; child_id: string; case_id: string; merged: boolean }
  | { result: "invalid" | "rate_limited" | "conflict" | "not_your_child" };

export async function claimChild(input: {
  codeHash: string;
  userId: string;
  relationship: Relationship;
  existingChildId: string | null;
}): Promise<ClaimResult> {
  const { data, error } = await supabaseAdmin().rpc("claim_child", {
    p_hash: input.codeHash,
    p_user: input.userId,
    p_relationship: input.relationship,
    p_existing_child: input.existingChildId,
  });
  if (error || !data) throw new Error(`Could not claim: ${error?.message ?? "no result"}`);
  return data as ClaimResult;
}

export function childJson(child: ChildRow) {
  return { id: child.id, display_name: child.display_name, date_of_birth: child.date_of_birth, sex: child.sex };
}
