// Ticket 029: query parameters of GET /api/public/providers and /find (FR-3, FR-5). Shared so the page and the
// API accept exactly the same values. Empty strings (blank form fields) count as "not set".
import { z } from "zod";
import { PROFILE_LANGUAGES } from "@/lib/providers/constants";
import { DEFAULT_RADIUS_KM, DIRECTORY_TYPES, MAX_RADIUS_KM, MIN_RADIUS_KM, SEARCH_MODES } from "./constants";

const coordinate = (min: number, max: number, label: string) =>
  z.coerce
    .number({ error: `${label} must be a number` })
    .min(min, { error: `${label} must be ${min} to ${max}` })
    .max(max, { error: `${label} must be ${min} to ${max}` });

export const SearchQuerySchema = z
  .object({
    lat: coordinate(-90, 90, "lat").optional(),
    lng: coordinate(-180, 180, "lng").optional(),
    q: z.string().trim().max(100, { error: "Location must be at most 100 characters" }).optional(),
    radius_km: z.coerce
      .number({ error: "radius_km must be a number" })
      .int({ error: "radius_km must be a whole number" })
      .min(MIN_RADIUS_KM, { error: `radius_km must be ${MIN_RADIUS_KM}-${MAX_RADIUS_KM}` })
      .max(MAX_RADIUS_KM, { error: `radius_km must be ${MIN_RADIUS_KM}-${MAX_RADIUS_KM}` })
      .default(DEFAULT_RADIUS_KM),
    type: z.enum(DIRECTORY_TYPES, { error: "Unknown type" }).optional(),
    language: z.enum(PROFILE_LANGUAGES, { error: "Unknown language" }).optional(),
    mode: z.enum(SEARCH_MODES, { error: "mode must be in_clinic, video or any" }).default("any"),
    page: z.coerce.number({ error: "page must be a number" }).int().min(1).max(500).default(1),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { error: "lat and lng go together", path: ["lat"] });

export type SearchQuery = z.output<typeof SearchQuerySchema>;

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

/** First non-empty value per key; repeated keys keep the first. */
export function normalizeParams(raw: RawParams): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: [string, string | string[] | undefined][] = raw instanceof URLSearchParams ? [...raw.entries()] : Object.entries(raw);
  for (const [key, value] of entries) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined || first.trim() === "" || key in out) continue;
    out[key] = first;
  }
  return out;
}

export function parseSearchQuery(raw: RawParams) {
  return SearchQuerySchema.safeParse(normalizeParams(raw));
}
