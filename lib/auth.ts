import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { isInvalidSessionError } from "@/lib/auth-access";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";
import { supabaseServer } from "@/lib/supabase-server";

export type UserRole = "platform_admin" | "provider" | "guardian";

export const USER_ROLES: readonly UserRole[] = ["platform_admin", "provider", "guardian"];

export async function getAuthenticatedUser(): Promise<User | null> {
  const { data, error } = await (await supabaseServer()).auth.getUser();
  if (error && !isInvalidSessionError(error)) {
    throw new Error(`Could not verify Supabase session: ${error.message}`);
  }
  if (!data.user) return null;
  return data.user;
}

export async function requirePageUser(): Promise<User> {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireApiUser(): Promise<Response | null> {
  const user = await getAuthenticatedUser();
  return user ? null : fail(401, "Authentication required");
}

export async function getUserRole(userId: string): Promise<UserRole> {
  const { data, error } = await supabaseAdmin()
    .from("user_profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (error) throw new Error(`Could not load user role: ${error.message}`);
  if (!USER_ROLES.includes(data.role)) throw new Error("Unexpected user role");
  return data.role as UserRole;
}
