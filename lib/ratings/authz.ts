// 036 gates. Guardians rate their own completed appointments (anyone else: 403 `You can rate only your completed
// appointments`, also for unknown ids, so ids leak nothing); providers report ratings of their own profile (404
// otherwise); platform admins moderate (403 otherwise).
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { requirePlatformAdminApi, requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { NOT_ELIGIBLE } from "./rules";
import type { Actor } from "./store";

export async function requireRatingGuardian(appointmentId: string): Promise<{ actor: Actor } | { response: Response }> {
  const user = await getAuthenticatedUser();
  if (!user) return { response: fail(401, "Authentication required") };
  const role = await getUserRole(user.id);
  if (role !== "guardian" || !isUuid(appointmentId)) return { response: fail(403, NOT_ELIGIBLE) };
  return { actor: { userId: user.id, role: "guardian" } };
}

export async function requireRatingProvider(ratingId: string): Promise<{ actor: Actor } | { response: Response }> {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate;
  if (!isUuid(ratingId)) return { response: fail(404, "Rating not found") };
  return { actor: { userId: gate.actor.user.id, role: gate.actor.role === "platform_admin" ? "platform_admin" : "provider" } };
}

export async function requireRatingAdmin(ratingId: string): Promise<{ actor: Actor } | { response: Response }> {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate;
  if (!isUuid(ratingId)) return { response: fail(404, "Rating not found") };
  return { actor: { userId: gate.actor.user.id, role: "platform_admin" } };
}
