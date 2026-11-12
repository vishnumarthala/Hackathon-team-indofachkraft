import { audit } from "@/lib/audit";
import { getAuthenticatedUser } from "@/lib/auth";
import { fail, ok, parseJson } from "@/lib/http";
import { registerProvider } from "@/lib/providers";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { RegisterSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-2: any signed-in account may ask; the database decides (guardians with child links and platform
// admins are refused). Body fields other than provider_type and full_name are ignored.
export async function POST(req: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");

  const parsed = await parseJson(req, RegisterSchema);
  if ("response" in parsed) return parsed.response;

  const result = await registerProvider(user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  if (result.data.created) {
    await audit({
      actor: "therapist",
      actorUserId: user.id,
      action: "provider.registered",
      entity: "provider_profile",
      entityId: result.data.profileId,
      details: { provider_type: parsed.data.provider_type },
    });
    invalidatePublicProviders();
  }
  return ok({ profile_id: result.data.profileId, redirect: "/dashboard/profile" }, result.data.created ? 201 : 200);
}
