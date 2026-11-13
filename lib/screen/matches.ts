// Ticket 048 FR-10: up to 3 matching providers below the recommendation, each with its next 2 free slots, so the
// check-in leads to a booking in one tap. Server only (directory search 029, services and slots 030).
//
// Order: the recommended provider types in order, then distance from the parent's location (or central Hyderabad).
// The nearest bookable provider of each recommended type is picked first (so a speech worry with a "closer look"
// shows a speech therapist AND a developmental paediatrician), then the list is filled in the same order.
// Providers with free slots are preferred; one without slots still shows (profile link, no chips).
import { getSlots, listServices, type ServiceRow } from "@/lib/booking/store";
import type { ProviderType } from "@/lib/providers/constants";
import { findHref, HYDERABAD_CENTRE, roundCoord } from "@/lib/geo/constants";
import { searchProviders, type DirectoryResult } from "@/lib/geo/search";

if (typeof window !== "undefined") {
  throw new Error("lib/screen/matches.ts is server-only");
}

export const MATCH_LIMIT = 3;
export const SLOTS_PER_PROVIDER = 2;
export const MATCH_RADIUS_KM = 25;
/** Directory rows fetched per recommended type. */
export const CANDIDATES_PER_TYPE = 5;
/** Upper bound on slot lookups per request (each is a few small queries). */
export const MAX_SLOT_LOOKUPS = 8;
/** Slots are looked up this many days ahead. */
export const SLOT_DAYS = 14;

export type MatchSlot = { start: string; end: string; book_href: string };

export type ProviderMatch = {
  profile_id: string;
  slug: string;
  display_name: string;
  provider_type: ProviderType;
  locality: string | null;
  org_public_name: string | null;
  distance_km: number | null;
  is_synthetic: boolean;
  service: { id: string; name: string; mode: "in_clinic" | "video"; duration_min: number } | null;
  slots: MatchSlot[];
};

export type MatchResponse = {
  origin: { lat: number; lng: number };
  types: ProviderType[];
  providers: ProviderMatch[];
  /** `See more`: /find with the first recommended type and the same origin. */
  see_more: string;
};

/** `/book/<profile>?service=<id>&start=<ISO>`: the booking page opens with that slot selected. */
export function bookHref(profileId: string, serviceId: string, start: string): string {
  return `/book/${profileId}?${new URLSearchParams({ service: serviceId, start })}`;
}

/**
 * Candidate order for the slot lookups: the nearest provider of each type (types in order), then the remaining
 * providers by type, then distance. A profile listed under several types is taken once.
 */
export function rankCandidates(groups: { type: ProviderType; results: DirectoryResult[] }[]): DirectoryResult[] {
  const seen = new Set<string>();
  const out: DirectoryResult[] = [];
  const take = (r: DirectoryResult | undefined) => {
    if (r && !seen.has(r.profile_id)) {
      seen.add(r.profile_id);
      out.push(r);
    }
  };
  for (const g of groups) take(g.results.find((r) => !seen.has(r.profile_id)));
  for (const g of groups) for (const r of g.results) take(r);
  return out;
}

/** Final display order: recommended type, then distance (video-only providers last within a type). */
export function orderMatches<T extends { provider_type: ProviderType; distance_km: number | null }>(list: T[], types: ProviderType[]): T[] {
  const rank = (t: ProviderType) => {
    const i = types.indexOf(t);
    return i === -1 ? types.length : i;
  };
  return [...list].sort(
    (a, b) => rank(a.provider_type) - rank(b.provider_type) || (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity),
  );
}

/** In-clinic services first (the parent searched near a place), then video. */
function servicesInOrder(services: ServiceRow[]): ServiceRow[] {
  return [...services.filter((s) => s.mode === "in_clinic"), ...services.filter((s) => s.mode === "video")].slice(0, 2);
}

async function nextSlots(profileId: string, now: Date): Promise<{ service: ServiceRow; slots: { start: string; end: string }[] } | null> {
  const services = servicesInOrder(await listServices(profileId, { activeOnly: true }));
  for (const service of services) {
    const { slots } = await getSlots(service, { days: SLOT_DAYS, now });
    if (slots.length > 0) return { service, slots: slots.slice(0, SLOTS_PER_PROVIDER) };
  }
  return null;
}

export async function findMatches(input: {
  types: ProviderType[];
  origin?: { lat: number; lng: number } | null;
  now?: Date;
}): Promise<MatchResponse> {
  const origin = input.origin ? { lat: roundCoord(input.origin.lat), lng: roundCoord(input.origin.lng) } : { ...HYDERABAD_CENTRE };
  const now = input.now ?? new Date();
  const groups = await Promise.all(
    input.types.map(async (type) => ({
      type,
      results: (
        await searchProviders({ ...origin, radiusKm: MATCH_RADIUS_KM, type, mode: "any", page: 1, pageSize: CANDIDATES_PER_TYPE })
      ).results.filter((r) => r.provider_type === type),
    })),
  );
  const candidates = rankCandidates(groups).slice(0, MAX_SLOT_LOOKUPS);
  const withSlots: ProviderMatch[] = [];
  const without: ProviderMatch[] = [];
  for (const c of candidates) {
    if (withSlots.length >= MATCH_LIMIT) break;
    const found = await nextSlots(c.profile_id, now);
    const match: ProviderMatch = {
      profile_id: c.profile_id,
      slug: c.slug,
      display_name: c.display_name,
      provider_type: c.provider_type,
      locality: c.locality,
      org_public_name: c.org_public_name,
      distance_km: c.distance_km,
      is_synthetic: c.is_synthetic,
      service: found
        ? { id: found.service.id, name: found.service.name, mode: found.service.mode, duration_min: found.service.duration_min }
        : null,
      slots: found ? found.slots.map((s) => ({ ...s, book_href: bookHref(c.profile_id, found.service.id, s.start) })) : [],
    };
    (found ? withSlots : without).push(match);
  }
  const picked = [...withSlots, ...without].slice(0, MATCH_LIMIT);
  return {
    origin,
    types: input.types,
    providers: orderMatches(picked, input.types),
    see_more: findHref({ ...origin, type: input.types[0], radius_km: MATCH_RADIUS_KM }),
  };
}
