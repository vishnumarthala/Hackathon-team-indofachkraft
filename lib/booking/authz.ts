// Gates for the booking routes (FR-4). Guardian routes use requireGuardian (019); provider routes resolve the
// caller's own profile and organisations server-side (nothing from the body). Missing/other ids -> 404.
import { getAuthenticatedUser, getUserRole, type UserRole } from "@/lib/auth";
import { requireProviderApi, type Actor } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { getProviderContext, isAppointmentProvider, type ProviderContext } from "./store";

export async function requireProviderContext(): Promise<{ actor: Actor; ctx: ProviderContext } | { response: Response }> {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate;
  const ctx = await getProviderContext(gate.actor.user.id);
  if (!ctx) return { response: fail(404, "Profile not found") };
  return { actor: gate.actor, ctx };
}

export type AppointmentActor = { userId: string; role: UserRole; kind: "guardian" | "provider" };

/**
 * Cancel / reschedule can come from either side. A guardian acts as `guardian` (the SQL function checks it is their
 * booking); anyone else must be the appointment's provider (profile owner or org owner/admin). Otherwise 404.
 */
export async function requireAppointmentActor(appointmentId: string): Promise<AppointmentActor | Response> {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  if (!isUuid(appointmentId)) return fail(404, "Appointment not found");
  const role = await getUserRole(user.id);
  if (role === "guardian") return { userId: user.id, role, kind: "guardian" };
  if (await isAppointmentProvider(appointmentId, user.id)) return { userId: user.id, role, kind: "provider" };
  return fail(404, "Appointment not found");
}
