import { audit } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { seedProvider } from "@/lib/providers/claims";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { SeedSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-5 admin seeding from public information: unclaimed profile + organisation + location.
// `unverified` and unlisted unless the admin verifies the registration in the same step.
export async function POST(req: Request) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;

  const parsed = await parseJson(req, SeedSchema);
  if ("response" in parsed) return parsed.response;

  const result = await seedProvider(gate.actor.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actor: "system",
    actorUserId: gate.actor.user.id,
    action: "provider.seeded",
    entity: "provider_profile",
    entityId: result.data.profileId,
    details: { org_id: result.data.orgId, verified: parsed.data.verified, is_synthetic: parsed.data.is_synthetic },
  });
  invalidatePublicProviders();
  return ok(
    {
      profile_id: result.data.profileId,
      org_id: result.data.orgId,
      location_id: result.data.locationId,
      slug: result.data.slug,
    },
    201,
  );
}
