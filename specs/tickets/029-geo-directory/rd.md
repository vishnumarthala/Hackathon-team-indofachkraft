# 029: PostGIS "near me" directory with Google Maps

**Status:** draft
**Mode:** solo
**Runs:** waits for 028: searches verified, listed provider profiles and their practice locations

## Summary

The public acquisition channel: `/find` lets a parent search verified providers and centres near a
location in Hyderabad by specialty, language and consultation mode, with a list and a Google map.
Geo queries run in Postgres with PostGIS; addresses are geocoded server-side when saved.

## Functional requirements

- **FR-1** - Migration `<ts>_postgis_directory.sql`: `create extension if not exists postgis`;
  `practice_locations.geog geography(Point, 4326)` generated/maintained from `lat/lng` (trigger), GiST
  index; `provider_profiles.offers_video boolean default false`, `offers_in_clinic boolean default true`
  (030 later derives these from active services).
- **FR-2** - SQL function `search_providers(p_lat float8, p_lng float8, p_radius_km int, p_types text[],
  p_language text, p_mode text, p_limit int, p_offset int)` (`security definer`, `stable`) returning
  `profile_id, slug, display_name, provider_type, languages, location_id, locality, distance_km,
  org_public_name, org_kind, offers_video, offers_in_clinic, rating_avg, rating_count` for profiles
  with `verification_status = 'verified' and listed` (and `is_synthetic = false` unless the caller
  passes the synthetic flag from env), ordered by distance then name; one row per profile (nearest
  location). Radius 1-50 km (default 10); `p_mode` `in_clinic | video | any` (video-only providers
  appear regardless of distance when mode is `video`, ordered by name). `rating_*` null until 036.
- **FR-3** - `GET /api/public/providers?lat=&lng=&radius_km=&type=&language=&mode=&page=` (public) ->
  200 `{ results, page, has_more }`; invalid params -> 400; lat/lng outside India bounding box -> 422
  `{ error: "We currently list providers in Hyderabad only" }`. Rate limit 60 requests/min per IP -> 429.
  `Cache-Control: public, s-maxage=60`.
- **FR-4** - Geocoding: `lib/geo/geocode.ts` calls Google Geocoding API server-side
  (`GOOGLE_MAPS_SERVER_KEY`) when a location address is created/changed (028 editor, admin seeding);
  stores `lat/lng`, `locality`; failure -> location saved with `lat/lng` null and editor shows
  `We couldn't find this address on the map. Check the pincode.`; null-geo locations are not searchable.
  `DEMO_MODE` uses fixtures keyed by pincode.
- **FR-5** - `/find` page (public, translated): `Location` input with Places Autocomplete (browser key
  `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`, restricted to `country: in`) and `Use my location` (browser
  geolocation; coordinates never stored server-side), `Specialty` select (provider types + `Centres`),
  `Language`, `Consultation` (`In clinic`, `Video`, `Any`), `Distance` (`2 km`, `5 km`, `10 km`, `25 km`).
  Results list cards: name, type, locality, `<x.x> km away`, languages, modes, `View profile`, `Book`
  (030). Map with markers (clustered at > 30) on desktop; `Map`/`List` toggle on mobile. Without a
  browser key: list only, no errors. Empty state: `No providers found nearby. Try a larger distance.`
  Query state lives in the URL (`/find?lat=...&type=...`) so results are shareable.
- **FR-6** - Profile page `/p/[slug]` (028) gains a static map image or embedded map of locations and a
  `Get directions` link (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`).
- **FR-7** - SEO landing pages `/find/hyderabad/[type]` (server-rendered list for central Hyderabad,
  indexable), linked from the landing page; `/find` with query params is `noindex`.

## Non-functional requirements

- **NFR-1** - `search_providers` p95 < 150 ms for 1,000 profiles / 2,000 locations (seeded in 042;
  `explain analyze` uses the GiST index).
- **NFR-2** - Google keys: browser key HTTP-referrer restricted, server key IP/API restricted
  (documented in `.env.example` and `docs/maps.md`); server key never reaches the browser.
- **NFR-3** - `/find` is not a child page, but loads no analytics/ads; Google Maps is the only third party.

## Affected areas

- `supabase/migrations/<ts>_postgis_directory.sql` (new); `lib/geo/**` (new); `demo/fixtures/geocode/**` (new)
- `app/find/**`, `app/api/public/providers/route.ts` (new); `app/p/[slug]/**` (map section);
  landing link to `/find`; `lib/auth-access.ts` (public paths)
- `.env.example`, `docs/maps.md` (new), `messages/*.json`
- `tests/directory-search.test.ts`, `tests/geocode.test.ts` (new)

## Don't touch

- Profile verification logic (028), existing migrations, `BOARD.md`

## Out of scope

- Booking/slots (030), ratings (036), voice search (034), cities other than Hyderabad, locale URL prefixes.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Geo stack | Supabase PostGIS + Google Maps/Places | plan §2 "Geo" |
| D-2 | Launch area | Hyderabad; India bounding box check | plan §1 |
| D-3 | User location | Never stored; only used per request | DPDP minimisation |
| D-4 | Visibility | Verified + listed only | plan §2 "Verification" |

## Open questions

- Google Maps billing account and keys (human task, plan §6).
