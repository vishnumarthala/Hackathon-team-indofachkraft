// Ticket 029 FR-2/FR-3: directory search through the `search_providers` SQL function (service-role client; the
// function only ever returns verified + listed profiles and public fields). The caller's coordinates are used
// for this one query and never stored or logged (D-3).
import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";
import type { ProviderType } from "@/lib/providers/constants";
import { PAGE_SIZE, roundCoord, type DirectoryType, type SearchMode } from "./constants";

export type DirectoryResult = {
  profile_id: string;
  slug: string;
  display_name: string;
  provider_type: ProviderType;
  languages: string[];
  location_id: string | null;
  locality: string | null;
  distance_km: number | null;
  org_public_name: string | null;
  org_kind: "centre" | "solo" | null;
  org_slug: string | null;
  offers_video: boolean;
  offers_in_clinic: boolean;
  rating_avg: number | null;
  rating_count: number | null;
  is_synthetic: boolean;
  lat: number | null;
  lng: number | null;
};

export type DirectorySearch = {
  lat: number;
  lng: number;
  radiusKm: number;
  type?: DirectoryType;
  language?: string;
  mode: SearchMode;
  page: number;
  pageSize?: number;
};

export type DirectoryPage = { results: DirectoryResult[]; page: number; has_more: boolean };

export async function searchProviders(search: DirectorySearch, includeSynthetic = env.SHOW_SYNTHETIC_LISTINGS): Promise<DirectoryPage> {
  const pageSize = search.pageSize ?? PAGE_SIZE;
  const { data, error } = await supabaseAdmin().rpc("search_providers", {
    p_lat: roundCoord(search.lat),
    p_lng: roundCoord(search.lng),
    p_radius_km: search.radiusKm,
    p_types: search.type ? [search.type] : null,
    p_language: search.language ?? null,
    p_mode: search.mode,
    // One extra row tells us whether there is a next page.
    p_limit: pageSize + 1,
    p_offset: (search.page - 1) * pageSize,
    p_include_synthetic: includeSynthetic,
  });
  if (error) throw new Error(`Directory search failed: ${error.message}`);
  const rows = (data ?? []) as DirectoryResult[];
  return { results: rows.slice(0, pageSize), page: search.page, has_more: rows.length > pageSize };
}
