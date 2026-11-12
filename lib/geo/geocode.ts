// Ticket 029 FR-4: server-side geocoding. Google Geocoding API with GOOGLE_MAPS_SERVER_KEY in live mode; the
// bundled Hyderabad locality + PIN code table (demo/fixtures/geocode/hyderabad.json) in DEMO_MODE or when no
// key is set. The server key never leaves the server: this module refuses to load in the browser.
import table from "@/demo/fixtures/geocode/hyderabad.json";
import { env } from "@/lib/env";
import { isInIndia } from "./constants";

if (typeof window !== "undefined") {
  throw new Error("lib/geo/geocode.ts is server-only");
}

export type GeoPoint = { lat: number; lng: number };
export type GeocodeResult = GeoPoint & { locality: string | null; source: "google" | "table" };

export type AddressInput = {
  address_line1: string;
  address_line2?: string | null;
  locality: string;
  city: string;
  state: string;
  pincode: string;
};

export interface Geocoder {
  /** A practice location address -> coordinates, or null when it cannot be placed (saved without geo). */
  geocodeAddress(address: AddressInput): Promise<GeocodeResult | null>;
  /** Free text from the /find location box (locality or PIN code) -> coordinates, or null. */
  geocodeQuery(text: string): Promise<GeocodeResult | null>;
}

type Locality = { name: string; pincode?: string; lat: number; lng: number; aliases?: string[] };
const LOCALITIES = (table as { localities: Locality[] }).localities;

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Locality names for the key-less `/find` suggestions (a `<datalist>`). */
export const KNOWN_LOCALITIES: readonly string[] = LOCALITIES.map((l) => l.name);

function fromLocality(l: Locality): GeocodeResult {
  return { lat: l.lat, lng: l.lng, locality: l.name, source: "table" };
}

export function lookupPincode(pincode: string): GeocodeResult | null {
  const hit = LOCALITIES.find((l) => l.pincode === pincode.trim());
  return hit ? fromLocality(hit) : null;
}

/** Exact locality/alias or PIN code match; then a locality name contained in the text ("Road 12, Banjara Hills"). */
export function lookupLocality(text: string): GeocodeResult | null {
  const pin = /\b([1-9][0-9]{5})\b/.exec(text)?.[1];
  if (pin) return lookupPincode(pin);
  const q = normalize(text).replace(/\b(hyderabad|telangana|india|secunderabad)\b$/g, "").trim() || normalize(text);
  if (!q) return null;
  const names = (l: Locality) => [l.name, ...(l.aliases ?? [])].map(normalize);
  const exact = LOCALITIES.find((l) => names(l).includes(q));
  if (exact) return fromLocality(exact);
  const contained = LOCALITIES.filter((l) => names(l).some((n) => n.length >= 3 && ` ${q} `.includes(` ${n} `)));
  if (contained.length) return fromLocality(contained.sort((a, b) => b.name.length - a.name.length)[0]);
  const prefix = q.length >= 3 ? LOCALITIES.find((l) => names(l).some((n) => n.startsWith(q))) : undefined;
  return prefix ? fromLocality(prefix) : null;
}

export const tableGeocoder: Geocoder = {
  // DEMO_MODE fixtures are keyed by PIN code: an unknown PIN code is the "couldn't find this address" path.
  async geocodeAddress(address) {
    return lookupPincode(address.pincode);
  },
  async geocodeQuery(text) {
    return lookupLocality(text);
  },
};

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const TIMEOUT_MS = 5000;

type GoogleComponent = { long_name: string; types: string[] };
type GoogleResponse = {
  status: string;
  results?: { geometry?: { location?: { lat: number; lng: number } }; address_components?: GoogleComponent[] }[];
};

function pickLocality(components: GoogleComponent[] | undefined): string | null {
  const order = ["sublocality_level_1", "sublocality", "neighborhood", "locality"];
  for (const type of order) {
    const hit = components?.find((c) => c.types.includes(type));
    if (hit) return hit.long_name;
  }
  return null;
}

export function googleGeocoder(key: string, fetchImpl: typeof fetch = fetch): Geocoder {
  async function call(params: Record<string, string>): Promise<GeocodeResult | null> {
    const url = new URL(GEOCODE_URL);
    for (const [k, v] of Object.entries({ ...params, region: "in", key })) url.searchParams.set(k, v);
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
      if (!res.ok) {
        console.error(`[geocode] Google Geocoding HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as GoogleResponse;
      if (body.status !== "OK") {
        // ZERO_RESULTS is an expected "not found"; anything else (quota, key restrictions) is worth a log line.
        if (body.status !== "ZERO_RESULTS") console.error(`[geocode] Google Geocoding status ${body.status}`);
        return null;
      }
      const first = body.results?.[0];
      const loc = first?.geometry?.location;
      if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || !isInIndia(loc.lat, loc.lng)) return null;
      return { lat: loc.lat, lng: loc.lng, locality: pickLocality(first.address_components), source: "google" };
    } catch (error) {
      console.error(`[geocode] Google Geocoding request failed: ${(error as Error).name}`);
      return null;
    }
  }

  return {
    geocodeAddress(address) {
      const text = [address.address_line1, address.address_line2, address.locality, address.city, `${address.state} ${address.pincode}`]
        .filter(Boolean)
        .join(", ");
      return call({ address: text, components: `country:IN|postal_code:${address.pincode}` });
    },
    async geocodeQuery(text) {
      // The bundled table answers common localities and PIN codes without a billable call.
      const local = lookupLocality(text);
      if (local) return local;
      return call({ address: `${text}, Hyderabad, Telangana`, components: "country:IN" });
    },
  };
}

/** The geocoder for this environment: Google when a server key is set and DEMO_MODE is off, else the table. */
export function getGeocoder(): Geocoder {
  const key = env.GOOGLE_MAPS_SERVER_KEY;
  if (env.DEMO_MODE || !key) return tableGeocoder;
  return googleGeocoder(key);
}

type LocationCoords = { lat?: number | null; lng?: number | null };

/**
 * FR-4: coordinates for a new practice location. Coordinates supplied by a trusted caller (platform admin
 * seeding) are kept; otherwise the address is geocoded. `geocoded: false` -> saved with null lat/lng (not
 * searchable) and the editor shows "We couldn't find this address on the map. Check the pincode."
 */
export async function geocodeLocationFields<T extends AddressInput & LocationCoords>(
  fields: T,
  options: { trustCoordinates: boolean; geocoder?: Geocoder },
): Promise<{ fields: T & { lat: number | null; lng: number | null }; geocoded: boolean }> {
  if (options.trustCoordinates && typeof fields.lat === "number" && typeof fields.lng === "number") {
    return { fields: { ...fields, lat: fields.lat, lng: fields.lng }, geocoded: true };
  }
  const hit = await (options.geocoder ?? getGeocoder()).geocodeAddress(fields);
  if (!hit) return { fields: { ...fields, lat: null, lng: null }, geocoded: false };
  return { fields: { ...fields, lat: round6(hit.lat), lng: round6(hit.lng) }, geocoded: true };
}

// practice_locations.lat/lng are numeric(9, 6).
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
