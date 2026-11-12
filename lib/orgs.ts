import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/db";
import { newToken } from "@/lib/tokens";

// Legacy CareThread cases and local demo data live in this organisation (migration 20261112120000).
export const BOOTSTRAP_ORG_ID = "00000000-0000-4000-8000-00000000a001";
export const INVITE_TTL_DAYS = 7;

export type OrgRole = "owner" | "admin" | "member";
export type OrgKind = "centre" | "solo";
export type Organization = { id: string; name: string; slug: string; kind: OrgKind; city: string | null };
export type Membership = { org: Organization; org_role: OrgRole };
export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export const OrgCreateSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(1, { error: "Name is required" }).max(120, { error: "Name must be at most 120 characters" }),
  kind: z.enum(["centre", "solo"], { error: "Choose centre or solo practice" }),
  city: z.string().trim().max(80, { error: "City must be at most 80 characters" }).optional().transform((v) => (v ? v : undefined)),
});

export const InviteCreateSchema = z.object({
  email: z.email({ error: "Enter a valid email" }).trim().toLowerCase().max(254),
  org_role: z.enum(["admin", "member"], { error: "Choose admin or member" }),
});

export const InviteAcceptSchema = z.object({ token: z.string().min(20).max(200) });

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

export function inviteUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/invite/${token}`;
}

export async function getMembershipRole(userId: string, orgId: string): Promise<OrgRole | null> {
  const { data, error } = await supabaseAdmin()
    .from("org_members")
    .select("org_role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not load membership: ${error.message}`);
  return (data as { org_role: OrgRole } | null)?.org_role ?? null;
}

export function canManage(role: OrgRole | null): boolean {
  return role === "owner" || role === "admin";
}

export async function listMemberships(userId: string): Promise<Membership[]> {
  const { data, error } = await supabaseAdmin()
    .from("org_members")
    .select("org_role, organizations(id, name, slug, kind, city)")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error(`Could not load organisations: ${error.message}`);
  return ((data ?? []) as unknown as { org_role: OrgRole; organizations: Organization }[])
    .map((row) => ({ org: row.organizations, org_role: row.org_role }))
    .sort((a, b) => a.org.name.localeCompare(b.org.name));
}

// Which organisation a new case belongs to: never guessed when the user has several.
export async function resolveCaseOrg(userId: string, requested: string | undefined): Promise<Result<string>> {
  const orgIds = (await listMemberships(userId)).map((m) => m.org.id);
  if (requested) {
    return orgIds.includes(requested)
      ? { ok: true, data: requested }
      : { ok: false, status: 403, error: "Not a member of this organisation" };
  }
  if (orgIds.length === 0) return { ok: false, status: 403, error: "Create or join an organisation first" };
  if (orgIds.length > 1) return { ok: false, status: 422, error: "Choose an organisation" };
  return { ok: true, data: orgIds[0] };
}

export async function createOrganization(userId: string, input: { name: string; kind: OrgKind; city?: string }): Promise<Organization> {
  const db = supabaseAdmin();
  const { data: id, error } = await db.rpc("create_organization", {
    org_name: input.name,
    org_slug: slugify(input.name),
    org_kind: input.kind,
    org_city: input.city ?? null,
    creator: userId,
  });
  if (error || !id) throw new Error(`Could not create organisation: ${error?.message ?? "no id"}`);
  const { data, error: loadError } = await db
    .from("organizations")
    .select("id, name, slug, kind, city")
    .eq("id", id)
    .single();
  if (loadError) throw new Error(`Could not load organisation: ${loadError.message}`);
  return data as Organization;
}

export async function createInvitation(
  orgId: string,
  inviterId: string,
  input: z.output<typeof InviteCreateSchema>,
  now: Date = new Date(),
): Promise<{ token: string; invitationId: string; orgName: string }> {
  const db = supabaseAdmin();
  const { data: org, error: orgError } = await db.from("organizations").select("name").eq("id", orgId).single();
  if (orgError) throw new Error(`Could not load organisation: ${orgError.message}`);

  const token = newToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await db
    .from("org_invitations")
    .insert({
      org_id: orgId,
      email: input.email,
      org_role: input.org_role,
      token_hash: hashToken(token),
      invited_by: inviterId,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not create invitation: ${error.message}`);
  return { token, invitationId: (data as { id: string }).id, orgName: (org as { name: string }).name };
}

export async function revokeInvitation(orgId: string, invitationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("org_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`Could not revoke invitation: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function acceptInvitation(
  user: { id: string; email?: string | null },
  token: string,
): Promise<Result<{ orgId: string }>> {
  const { data, error } = await supabaseAdmin().rpc("accept_org_invitation", {
    invite_hash: hashToken(token),
    accepting_user: user.id,
    accepting_email: user.email ?? "",
  });
  if (error) throw new Error(`Could not accept invitation: ${error.message}`);
  const outcome = data as { result: "accepted" | "invalid" | "wrong_email"; org_id?: string };
  if (outcome.result === "accepted" && outcome.org_id) return { ok: true, data: { orgId: outcome.org_id } };
  if (outcome.result === "wrong_email") {
    return { ok: false, status: 403, error: "This invitation was sent to a different email" };
  }
  return { ok: false, status: 404, error: "This invitation is not valid" };
}

export async function revokeMember(orgId: string, userId: string): Promise<Result<null>> {
  const { data, error } = await supabaseAdmin().rpc("revoke_org_member", { target_org: orgId, target_user: userId });
  if (error) throw new Error(`Could not revoke member: ${error.message}`);
  if (data === "revoked") return { ok: true, data: null };
  if (data === "last_owner") return { ok: false, status: 409, error: "An organisation needs at least one owner" };
  return { ok: false, status: 404, error: "Member not found" };
}

export type MemberRow = { user_id: string; email: string | null; org_role: OrgRole; created_at: string };
export type InvitationRow = { id: string; email: string; org_role: OrgRole; expires_at: string };

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("org_members")
    .select("user_id, org_role, created_at")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at");
  if (error) throw new Error(`Could not load members: ${error.message}`);
  const rows = (data ?? []) as Omit<MemberRow, "email">[];
  return Promise.all(
    rows.map(async (row) => {
      const { data: u } = await db.auth.admin.getUserById(row.user_id);
      return { ...row, email: u?.user?.email ?? null };
    }),
  );
}

export async function listPendingInvitations(orgId: string, now: Date = new Date()): Promise<InvitationRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("org_invitations")
    .select("id, email, org_role, expires_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load invitations: ${error.message}`);
  return (data ?? []) as InvitationRow[];
}
