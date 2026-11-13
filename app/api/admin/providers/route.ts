import { audit } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { geocodeLocationFields } from "@/lib/geo/geocode";
import { fail, ok, parseJson } from "@/lib/http";
import { seedProvider } from "@/lib/providers/claims";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { SeedSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-5 admin seeding from public information: unclaimed profile + organisation + location.
// `unverified` and unlisted unless the admin verifies the registration in the same step.
// 029 FR-4: a new location keeps admin-supplied lat/lng, otherwise its address is geocoded server-side; if that
// fails it is saved without coordinates (not searchable) and the response says `geocoded: false`.
export async function POST(req: Request) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;

  const parsed = await parseJson(req, SeedSchema);
  if ("response" in parsed) return parsed.response;

  let input = parsed.data;
  let geocoded: boolean | null = null;
  if (input.location) {
    const geo = await geocodeLocationFields(input.location, { trustCoordinates: true });
    geocoded = geo.geocoded;
    input = { ...input, location: geo.fields };
  }
  const result = await seedProvider(gate.actor.user.id, input);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actorUserId: gate.actor.user.id,
    action: "provider.seeded",
    entity: "provider_profile",
    entityId: result.data.profileId,
    details: { org_id: result.data.orgId, verified: input.verified, is_synthetic: input.is_synthetic, geocoded },
  });
  invalidatePublicProviders();
  return ok(
    {
      profile_id: result.data.profileId,
      org_id: result.data.orgId,
      location_id: result.data.locationId,
      slug: result.data.slug,
      geocoded,
    },
    201,
  );
}
