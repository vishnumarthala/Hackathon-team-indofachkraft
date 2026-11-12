// Ticket 029: directory vocabularies and pure helpers. Safe in client and server code (no keys here).
import { PROVIDER_TYPES, type ProviderType } from "@/lib/providers/constants";

/** Rough India bounding box (D-2). Anything outside answers 422. */
export const INDIA_BOUNDS = { minLat: 6.4, maxLat: 37.6, minLng: 68.1, maxLng: 97.5 } as const;
export const OUTSIDE_AREA_ERROR = "We currently list providers in Hyderabad only";

/** Central Hyderabad (Abids/Nampally area), used by the SEO landing pages and as the default map centre. */
export const HYDERABAD_CENTRE = { lat: 17.385, lng: 78.4867 } as const;
export const SEO_RADIUS_KM = 25;

export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 50;
export const DEFAULT_RADIUS_KM = 10;
export const RADIUS_OPTIONS = [2, 5, 10, 25] as const;

export const SEARCH_MODES = ["in_clinic", "video", "any"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** `centre` = providers practising at a centre (organisation kind `centre`). */
export const DIRECTORY_TYPES = [...PROVIDER_TYPES, "centre"] as const;
export type DirectoryType = ProviderType | "centre";

// 50 per page: the map shows the same results as the list, so clustering (above 30) is reachable.
export const PAGE_SIZE = 50;
/** Map markers are clustered above this many results (FR-5). */
export const CLUSTER_THRESHOLD = 30;

/** D-3: coordinates are rounded to 3 decimals (about 100 m) before they reach the URL or the database query. */
export const COORD_DECIMALS = 3;

export function roundCoord(value: number): number {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(value * f) / f;
}

export function isInIndia(lat: number, lng: number): boolean {
  return lat >= INDIA_BOUNDS.minLat && lat <= INDIA_BOUNDS.maxLat && lng >= INDIA_BOUNDS.minLng && lng <= INDIA_BOUNDS.maxLng;
}

/** FR-6 `Get directions` link (Google Maps URLs, no key needed). */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** FR-6 static map image of a profile's locations (Maps Static API, browser key: it is loaded by the browser). */
export function staticMapUrl(points: { lat: number; lng: number }[], browserKey: string): string {
  const params = new URLSearchParams({ size: "640x320", scale: "2", maptype: "roadmap", region: "IN", key: browserKey });
  if (points.length === 1) params.set("zoom", "15");
  params.append("markers", ["color:0x0f766e", ...points.map((p) => `${p.lat},${p.lng}`)].join("|"));
  return `https://maps.googleapis.com/maps/api/staticmap?${params}`;
}

/** `/find/hyderabad/<slug>` slug for a directory type, e.g. `speech-language-pathologist`, `centres`. */
export function typeSlug(type: DirectoryType): string {
  return type === "centre" ? "centres" : type.replaceAll("_", "-");
}

export function typeFromSlug(slug: string): DirectoryType | null {
  return DIRECTORY_TYPES.find((t) => typeSlug(t) === slug) ?? null;
}

export type FindQuery = {
  lat?: number;
  lng?: number;
  q?: string;
  radius_km?: number;
  type?: DirectoryType;
  language?: string;
  mode?: SearchMode;
  page?: number;
};

/** Shareable `/find?...` URL (FR-5: query state lives in the URL). Defaults are left out. */
export function findHref(query: FindQuery): string {
  const params = new URLSearchParams();
  if (query.lat !== undefined && query.lng !== undefined) {
    params.set("lat", String(roundCoord(query.lat)));
    params.set("lng", String(roundCoord(query.lng)));
  }
  if (query.q) params.set("q", query.q);
  if (query.radius_km !== undefined && query.radius_km !== DEFAULT_RADIUS_KM) params.set("radius_km", String(query.radius_km));
  if (query.type) params.set("type", query.type);
  if (query.language) params.set("language", query.language);
  if (query.mode && query.mode !== "any") params.set("mode", query.mode);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const qs = params.toString();
  return qs ? `/find?${qs}` : "/find";
}
