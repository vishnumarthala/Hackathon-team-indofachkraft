# Maps, geocoding and the "near me" directory (ticket 029)

Families find verified providers near a place in Hyderabad at `/find`. Geo queries run in Postgres with
PostGIS; Google Maps Platform draws the map, suggests places and geocodes addresses. Google is the only third
party on these pages (no analytics, ads or pixels). Everything also works **without any Google key**: the list
is server-rendered and addresses are geocoded from a bundled table.

## Data model (`supabase/migrations/20261113002900_postgis_directory.sql`)

| Object | What |
|---|---|
| `extensions.postgis` | `create extension if not exists postgis with schema extensions` (available in the Supabase image; PostGIS 3.3 locally). Qualify PostGIS names with `extensions.` in `search_path = ''` functions. |
| `practice_locations.geog geography(Point, 4326)` | Always derived from `lat`/`lng` by the `practice_locations_set_geog` trigger (insert and every update); null while the address could not be geocoded. GiST index `practice_locations_geog_idx`. Existing rows were backfilled. |
| `provider_profiles.offers_in_clinic` (default `true`), `offers_video` (default `false`) | Consultation modes. Set by the provider in the profile editor (`PATCH /api/providers/:id`) or by a platform admin when seeding. Since 030 they are derived from active services (triggers) as soon as the profile has any service; manual changes are then overridden. |
| `search_providers(p_lat, p_lng, p_radius_km = 10, p_types = null, p_language = null, p_mode = 'any', p_limit = 20, p_offset = 0, p_include_synthetic = true)` | `security definer`, `stable`, execute granted to `service_role` only. See below. |

### `search_providers`

- Only `verification_status = 'verified' and listed` profiles; demo (`is_synthetic`) profiles unless
  `p_include_synthetic` is false (the app passes `SHOW_SYNTHETIC_LISTINGS`).
- One row per profile: its nearest geocoded location within the radius (`ST_DWithin` on the GiST index), ordered
  by distance, then name. Null-geo locations are never searchable.
- `p_types`: provider types and/or `centre` (= practises at an organisation of kind `centre`).
  `p_language`: one of the profile languages. `p_mode`: `in_clinic` (offers in clinic), `video` (offers video;
  **video-only providers are added whatever their distance**, after the nearby ones, ordered by name, with
  `distance_km`, `lat`, `lng` null), `any` (either mode, within the radius).
- Radius is clamped to 1-50 km, limit to 1-100; invalid coordinates or mode raise `22023`.
- Returns `profile_id, slug, display_name, provider_type, languages, location_id, locality, distance_km,
  org_public_name, org_kind, org_slug (only if the organisation is listed), offers_video, offers_in_clinic,
  rating_avg (036: average of published ratings, null below 3), rating_count (published ratings, 0 when none), is_synthetic, lat, lng`. No user ids, emails, registration
  numbers or verification notes.
- NFR-1: with 1,000 profiles / 2,000 locations the plan uses a Bitmap Index Scan on
  `practice_locations_geog_idx`; p95 over 50 varied calls was 5.2 ms locally (see the ticket results).

TypeScript wrapper: `searchProviders()` in `lib/geo/search.ts` (pages of 50, `has_more` by fetching one extra row;
coordinates rounded to 3 decimals before the query).

## Public surfaces

| Path | What |
|---|---|
| `GET /api/public/providers?lat=&lng=&radius_km=&type=&language=&mode=&page=` | Public (listed in `isPublicApiPath`). 200 `{ results, page, has_more }` with `Cache-Control: public, s-maxage=60`; 400 `{ error: "Invalid request", details }` for invalid/missing params; 422 `{ error: "We currently list providers in Hyderabad only" }` outside the India bounding box; 429 after 60 requests/min per IP (`lib/geo/rate-limit.ts`, in-memory per instance). For 034's voice agent and other clients. |
| `/find` | Search page (translated). Server-rendered from the URL (`/find?lat=&lng=&q=&type=&language=&mode=&radius_km=&page=`), so results are shareable and the form works without JavaScript (`q` is geocoded on the server). `Use my location` (browser geolocation, rounded to ~100 m, only in the URL). Distance `2/5/10/25 km`. With a browser key: Google Places suggestions (`includedRegionCodes: ["in"]`, biased to Hyderabad) and a map with markers (grid clustering above 30, `lib/geo/cluster.ts`); `Map`/`List` toggle on mobile; the map only loads when visible. Without a browser key: list only, a `<datalist>` of known localities, no Google request. `noindex` when the URL has query parameters. |
| `/find/hyderabad/<type>` | Indexable SEO pages (`speech-language-pathologist`, ..., `centres`): providers of that type within 25 km of central Hyderabad, nearest first. Linked from the landing page (nav + footer) and from `/find`. |
| `/p/<slug>` | Adds a Maps Static API image of the locations (browser key only) and a `Get directions` link per geocoded location: `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`. Shows consultation modes. |

## Geocoding (`lib/geo/geocode.ts`, server-only)

- **When:** a new practice location is created by a provider (`POST /api/providers/:id/locations`; any client
  `lat`/`lng` is ignored) or by a platform admin seeding a profile (`POST /api/admin/providers`; admin-supplied
  coordinates are kept, otherwise the address is geocoded). There is no address-edit endpoint yet; if one is
  added it must geocode again.
- **How:** `getGeocoder()` returns the Google geocoder when `GOOGLE_MAPS_SERVER_KEY` is set and `DEMO_MODE` is
  off (Geocoding API, `components=country:IN|postal_code:<pin>`, 5 s timeout, result must be inside India);
  otherwise the **bundled table** `demo/fixtures/geocode/hyderabad.json` (about 40 Hyderabad localities with
  approximate centroids and PIN codes). Addresses are matched by PIN code only; the `/find` text box matches a
  locality name, alias or PIN code (and falls back to Google when configured).
- **Failure:** the location is saved with `lat`/`lng` null (not searchable), the API answers
  `{ ..., geocoded: false }` and the editor shows `We couldn't find this address on the map. Check the pincode.`;
  unmapped locations stay flagged in the editor. Errors are logged by status only (never the key or address).
- Tests mock the Google boundary (`fetch`); no test calls Google.

## Keys (NFR-2) - human setup

Create two keys in the Google Cloud project with billing enabled (plan §6):

1. **Server key** -> `GOOGLE_MAPS_SERVER_KEY`. API restriction: *Geocoding API* only. Application restriction:
   the server's egress IP addresses (Vercel: use a static egress IP / Secure Compute, or keep the key unset and
   rely on the table until one exists). Never prefix with `NEXT_PUBLIC_`; it is read only by
   `lib/geo/geocode.ts`, which throws if bundled for the browser. Checked: a build with a dummy server key has no
   trace of it in `.next/static`.
2. **Browser key** -> `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`. API restriction: *Maps JavaScript API*, *Places API
   (New)*, *Maps Static API*. Application restriction: HTTP referrers `https://<production domain>/*`,
   `https://*.vercel.app/*` (previews, if wanted) and `http://localhost:3000/*`. The key is public by design; it
   is read on the server at request time and passed to client components as a prop (not inlined at build).
3. Optional `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (a vector map id for advanced markers); default `DEMO_MAP_ID`.

Set quotas/budget alerts on both keys.

## Privacy (D-3, NFR-3)

- The searcher's coordinates are used for one query and never stored: no table has them, nothing logs them.
  `Use my location` rounds to 3 decimals (~100 m) before the URL; the server rounds again before querying.
- `next.config.ts` drops dev-server request log lines whose URL carries `lat`, `lng` or `q`. In production,
  the host's request logs (e.g. Vercel) still record URLs: keep their retention short (041).
- `/find` is not a child page and has no family CSP; it loads no analytics or ads. With a browser key the only
  third-party requests are to `maps.googleapis.com` / `maps.gstatic.com`.
