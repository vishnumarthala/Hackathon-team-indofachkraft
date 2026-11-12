import { audit } from "@/lib/audit";
import { requireProviderProfileOwner } from "@/lib/authz";
import { geocodeLocationFields } from "@/lib/geo/geocode";
import { fail, ok, parseJson } from "@/lib/http";
import { canManage, getMembershipRole } from "@/lib/orgs";
import { createLocation, getLocation, linkLocation } from "@/lib/providers";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { LocationLinkSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

// FR-3 locations: a provider links their profile to locations of organisations they are an active member
// of; creating a new location needs owner/admin rights in that organisation. Other orgs' ids -> 404.
// 029 FR-4: a new address is geocoded server-side (client-sent lat/lng are ignored); when that fails the
// location is still saved, without coordinates (not searchable), and the response says `geocoded: false`.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;
  const userId = gate.actor.user.id;

  const parsed = await parseJson(req, LocationLinkSchema);
  if ("response" in parsed) return parsed.response;

  let location;
  let geocoded = true;
  if ("location_id" in parsed.data) {
    location = await getLocation(parsed.data.location_id);
    if (!location || (await getMembershipRole(userId, location.org_id)) === null) {
      return fail(404, "Location not found");
    }
  } else {
    const { org_id, ...fields } = parsed.data;
    if (!canManage(await getMembershipRole(userId, org_id))) return fail(404, "Organisation not found");
    const geo = await geocodeLocationFields(fields, { trustCoordinates: false });
    geocoded = geo.geocoded;
    location = await createLocation(org_id, geo.fields);
    await audit({
      actor: "therapist",
      actorUserId: userId,
      action: "org.location_created",
      entity: "practice_location",
      entityId: location.id,
      details: { org_id, geocoded },
    });
  }

  await linkLocation(id, location);
  invalidatePublicProviders();
  return ok({ location, geocoded: location.lat !== null && location.lng !== null }, 201);
}
