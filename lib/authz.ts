import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { getAuthenticatedUser, getUserRole, requirePageUser, type UserRole } from "@/lib/auth";
import { FAMILY_LOGIN_PATH, homeForRole } from "@/lib/auth-access";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";

// Resource-level authorisation. The server reads clinical tables with the service-role client, which
// bypasses RLS, so every route and page must pass one of these gates before touching case data.
// A provider may access a case only while they are an active member of the case's organisation.
// Missing, invalid and other-tenant ids all give the same 404 so ids from other tenants leak nothing.

export type Actor = { user: User; role: UserRole };

export async function getActiveOrgIds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error(`Could not load memberships: ${error.message}`);
  return (data ?? []).map((row: { org_id: string }) => row.org_id);
}

export async function isActiveMember(userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`Could not check membership: ${error.message}`);
  return data !== null;
}

export async function requireProviderApi(): Promise<{ actor: Actor } | { response: Response }> {
  const user = await getAuthenticatedUser();
  if (!user) return { response: fail(401, "Authentication required") };
  const role = await getUserRole(user.id);
  if (role === "guardian") return { response: fail(403, "Provider access required") };
  return { actor: { user, role } };
}

export async function requirePlatformAdminApi(): Promise<{ actor: Actor } | { response: Response }> {
  const user = await getAuthenticatedUser();
  if (!user) return { response: fail(401, "Authentication required") };
  const role = await getUserRole(user.id);
  if (role !== "platform_admin") return { response: fail(403, "Platform admin access required") };
  return { actor: { user, role } };
}

// Ticket 028: only the provider bound to a profile may change it. Other providers' ids, missing and
// malformed ids all give the same 404.
export async function requireProviderProfileOwner(
  profileId: string,
): Promise<{ actor: Actor } | { response: Response }> {
  const result = await requireProviderApi();
  if ("response" in result) return result;
  if (!isUuid(profileId)) return { response: fail(404, "Profile not found") };
  const { data, error } = await supabaseAdmin().from("provider_profiles").select("user_id").eq("id", profileId).maybeSingle();
  if (error) throw new Error(`Could not load provider profile: ${error.message}`);
  if ((data as { user_id: string | null } | null)?.user_id !== result.actor.user.id) {
    return { response: fail(404, "Profile not found") };
  }
  return result;
}

async function lookupCaseId(table: "recordings" | "reports" | "facts", id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabaseAdmin().from(table).select("case_id").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load ${table} row: ${error.message}`);
  return (data as { case_id: string } | null)?.case_id ?? null;
}

async function caseOrgId(caseId: string | null): Promise<string | null> {
  if (!caseId || !isUuid(caseId)) return null;
  const { data, error } = await supabaseAdmin().from("cases").select("org_id").eq("id", caseId).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.message}`);
  return (data as { org_id: string } | null)?.org_id ?? null;
}

async function canAccessCase(userId: string, caseId: string | null): Promise<boolean> {
  const orgId = await caseOrgId(caseId);
  return orgId !== null && (await isActiveMember(userId, orgId));
}

async function gate(resolveCaseId: () => Promise<string | null>, notFoundMessage: string): Promise<Response | null> {
  const result = await requireProviderApi();
  if ("response" in result) return result.response;
  const allowed = await canAccessCase(result.actor.user.id, await resolveCaseId());
  return allowed ? null : fail(404, notFoundMessage);
}

export function requireCaseAccess(caseId: string, notFoundMessage = "Case not found"): Promise<Response | null> {
  return gate(async () => caseId, notFoundMessage);
}

export function requireRecordingAccess(recordingId: string, notFoundMessage = "Session not found") {
  return gate(() => lookupCaseId("recordings", recordingId), notFoundMessage);
}

export function requireReportAccess(reportId: string, notFoundMessage = "Report not found") {
  return gate(() => lookupCaseId("reports", reportId), notFoundMessage);
}

export function requireFactAccess(factId: string, notFoundMessage = "Fact not found") {
  return gate(() => lookupCaseId("facts", factId), notFoundMessage);
}

export async function requirePlatformAdminPage(): Promise<Actor> {
  const user = await requirePageUser();
  const role = await getUserRole(user.id);
  if (role !== "platform_admin") notFound();
  return { user, role };
}

export async function requireProviderPage(): Promise<Actor> {
  const user = await requirePageUser();
  const role = await getUserRole(user.id);
  if (role === "guardian") notFound();
  return { user, role };
}

export async function requireCasePage(caseId: string): Promise<Actor> {
  const actor = await requireProviderPage();
  if (!(await canAccessCase(actor.user.id, caseId))) notFound();
  return actor;
}

// ---------- 019: guardians ----------

export type UserProfile = {
  id: string;
  role: UserRole;
  display_name: string | null;
  preferred_locale: string | null;
  phone_verified_at: string | null;
};

export type GuardianSession = { user: User; profile: UserProfile & { role: "guardian" } };

export const PROFILE_COLUMNS = "id, role, display_name, preferred_locale, phone_verified_at";

export async function loadUserProfile(userId: string): Promise<UserProfile> {
  const { data, error } = await supabaseAdmin().from("user_profiles").select(PROFILE_COLUMNS).eq("id", userId).single();
  if (error) throw new Error(`Could not load user profile: ${error.message}`);
  return data as UserProfile;
}

/** FR-5: every `/api/family/**` route calls this (or a stricter helper) before reading data. */
export async function requireGuardian(): Promise<GuardianSession | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const profile = await loadUserProfile(user.id);
  if (profile.role !== "guardian") return fail(403, "Not allowed");
  return { user, profile: profile as GuardianSession["profile"] };
}

/** FR-5 for `/family/**` server components: anonymous -> sign-in page, other roles -> their own home. */
export const requireGuardianPage = cache(async (): Promise<GuardianSession> => {
  const user = await getAuthenticatedUser();
  if (!user) redirect(FAMILY_LOGIN_PATH);
  const profile = await loadUserProfile(user.id);
  if (profile.role !== "guardian") redirect(homeForRole(profile.role));
  return { user, profile: profile as GuardianSession["profile"] };
});
