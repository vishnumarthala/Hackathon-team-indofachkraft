# 029: PostGIS "near me" directory with Google Maps - Results

Branch: `ticket/029-geo-directory` (base: 017, 018, 019, 028 merged). Tested against the isolated local Supabase
stack of worker slot 5 (`dnmslot5`, all eight migrations applied by `supabase db reset`; PostGIS 3.3.7 available
in the image and installed into `extensions`), `DEMO_MODE=true`, dev server on port 3050, integrated browser at
1280 px and 375 px. No Google key exists locally: the key-less path was exercised for real, the Google paths with
mocks (vitest: mocked `fetch`; browser: a stubbed `window.google.maps` injected before page scripts). Synthetic
providers (`e029 ... (synthetic)`, `t029*`, `perf029*`), synthetic clinics, fake registration numbers only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint`, `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` | PASS | 46 files, 659 passed, 10 skipped (the pre-existing opt-in `CT_DB_TESTS` intake block); all DB suites ran, incl. the two new ones |
| `npx vitest run tests/directory-search.test.ts tests/geocode.test.ts --reporter=verbose` | PASS | 2 files, 50 tests (list below): distance ordering, radius, type/centre/language/mode filters, video-only behaviour, unverified/unlisted/null-geo exclusion, demo profiles with `is_synthetic` and hidden by `SHOW_SYNTHETIC_LISTINGS=false`, India bbox 422, 400s, 429, geocode failure path, one row per multi-location profile, service-role-only grant |
| `npm run build` | PASS | exit 0; `/find`, `/find/hyderabad/[type]`, `/api/public/providers` in the route list (the one Turbopack warning is the pre-existing `lib/demo.ts` fixture loader) |
| Migration | PASS | `20261113002900_postgis_directory.sql` applies on a fresh reset after 028; additive only (extension, nullable trigger-maintained `geog` + GiST index, two defaulted booleans, one function); existing coordinates backfilled by the trigger |
| E-1.1 distance + radius | PASS | `/find?lat=17.4126&lng=78.4482&radius_km=5`: Banjara Hills SLP 0.1 km, OT 0.4 km, Dev. paed 0.4 km (Demo badges), nothing else; 10 km adds Secunderabad 6.1 km; Gachibowli (10.9 km) absent until `Distance` = `25 km` (selected in the browser, URL updated to `radius_km=25`, list re-rendered: + Gachibowli SLP/Special educator 10.9 km, Kompally video-only 14.0 km) |
| E-1.2 filters | PASS | `type=speech_language_pathologist&language=te` (25 km): only Banjara SLP, Gachibowli SLP, Kompally video-only (all Telugu SLPs); `Consultation` = `Video` at 10 km: the video-only profile appears (`Video consultations`, no distance) although it is 14 km away; `type=centre`: only providers at centres |
| E-1.3 exclusion + bbox | PASS | the unverified and unlisted Banjara Hills profiles never appear (any radius/filter); `GET /api/public/providers?lat=51.5&lng=-0.1` -> 422 `{"error":"We currently list providers in Hyderabad only"}`; `/find` shows the same message; invalid params -> 400 `{"error":"Invalid request","details":{"radius_km":"radius_km must be 1-50"}}` |
| Server-side location search | PASS | `/find?q=Banjara+Hills` -> `Providers near Banjara Hills`; `q=500032` -> `Providers near Gachibowli`; `q=Atlantis` -> `We couldn't find that place. Try a locality or PIN code in Hyderabad.`; works without JavaScript (plain GET form) |
| E-2 without browser key | PASS | list only, no `Map`/`List` toggle, 0 console errors/warnings from the app, 0 third-party requests (Playwright request log); no static map on `/p`; 375 px: no horizontal scroll |
| E-2 with a browser key (stubbed Maps API) | PASS (mocked) | dev server with `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=test-browser-key-029`, stubbed `google.maps`: 16 results -> 16 markers with the same names; 50 results (perf data) -> 8 single markers + 15 clusters covering 42 = 50 (clustered above 30); map id `DEMO_MAP_ID`; Places suggestions requested with `includedRegionCodes=in`, choosing one navigates to `/find?lat=17.44&lng=78.498&q=...`; 375 px: `Map`/`List` toggle, map not mounted until `Map` is pressed, list hidden in map view and back with `List`. No screenshot of real tiles (no key) |
| E-2 `/p/<slug>` | PASS | `Get directions` -> `https://www.google.com/maps/dir/?api=1&destination=17.4126,78.4482` (admin coordinates) and `...destination=17.4401,78.3489` (address geocoded from PIN 500032 by the table); with the browser key a Maps Static image (`staticmap?...markers=color:0x0f766e|17.4126,78.4482&key=<browser key>`); consultation modes shown (`In clinic, Video`) |
| FR-4 geocoding | PASS | Seeding without coordinates geocodes from the PIN code (`geocoded: true`); provider editor (browser): new location with PIN `199999` saved, `We couldn't find this address on the map. Check the pincode.` shown, the location flagged `Not on the map ...`; DB `lat`/`lng`/`geog` null and never returned by search; client-sent `lat/lng` ignored for providers |
| E-3 privacy | PASS | `Use my location` with mocked `navigator.geolocation` (17.440123, 78.348987) -> URL `/find?lat=17.44&lng=78.349` (rounded to 3 decimals) -> Gachibowli providers; dev log has 0 lines containing `lat=` (`logging.incomingRequests.ignore`); no DB column other than `practice_locations.lat/lng/geog` holds coordinates and no audit row contains them |
| E-3 keys | PASS | `GOOGLE_MAPS_SERVER_KEY=leakcheck-server-key-029 npm run build`: value found in 0 files of `.next` (and the variable name in 0 files of `.next/static`); the browser key is not inlined either (read on the server per request, passed as a prop) |
| E-4 / NFR-1 performance | PASS | 1,000 verified + listed profiles, 2,000 locations (`.tmp` generator, removed afterwards): plan of the search statement uses `Bitmap Index Scan on practice_locations_geog_idx` (`geog && _st_expand(...)`, 581 candidate rows -> 413 within 10 km); 50 varied calls (radius 2-25 km, filters, modes): p50 1.06 ms, **p95 5.16 ms**, max 6.06 ms; through the API (`curl`, dev server): p50 21 ms, p95 51 ms |
| E-5 rate limit | PASS | 50 + 10 requests from one client within a minute -> 200; the 61st -> 429 (`Retry-After: 60`); also covered by a test (another IP still 200) |
| FR-3 caching | PASS | 200 responses carry `Cache-Control: public, s-maxage=60` |
| FR-7 SEO | PASS | `/find/hyderabad/speech-language-pathologist` 200, title `Speech-language pathologists in Hyderabad \| DoctorNearMe`, absolute canonical, indexable, list from central Hyderabad nearest first; `/find/hyderabad/surgeons` 404; `/find` with parameters `noindex, follow`; landing page links `/find` (nav + footer) and five SEO pages (footer) |
| NFR-3 / i18n | PASS | all new chrome through `t()` (`directory.*`, 96 keys in en/hi/te, `messages/REVIEW.md` regenerated, 757 rows); `hi`/`te` cookies render translated titles, headings and `कि.मी. दूर` / `కి.మీ. దూరంలో`; `/find` loads no analytics/ads |

Ticket test list - `tests/geocode.test.ts`: table geocodes PIN codes/localities/aliases; unknown places null;
addresses matched by PIN only; Google request (India + PIN restriction, key) and first result; null on
ZERO_RESULTS, REQUEST_DENIED, HTTP 500, result outside India, network error; key/address never logged; free text
answered from the table before Google; geocoder selection (DEMO_MODE / no key -> table); trusted vs untrusted
coordinates; failure leaves coordinates null; DB: provider location geocoded server-side (client lat/lng ignored);
failure path (201, `geocoded: false`, null geo, audit `geocoded: false`); owner sets consultation modes; admin
seeding geocodes / keeps given coordinates / fails to null. `tests/directory-search.test.ts`: query parsing (defaults,
blank fields, 10 rejection cases); India bbox; `/find` URL builder, SEO slugs, directions/static map URLs;
clustering (<= 30 unclustered, > 30 clustered, zoom splits); rate limiter; DB (profiles created through
`POST /api/admin/providers`): geog trigger; distance order, exclusions, radius; one row per multi-location profile
at the nearest location; type/centre/language filters; modes incl. video-only; demo profiles; SQL validation and
clamping; service-role-only execute; API 200 shape + cache header + no private fields; pagination;
`SHOW_SYNTHETIC_LISTINGS=false`; 400/422; 429 on the 61st request; public path rules.

## Deviations

- **Google Maps keys (open question, human task).** No billing account or keys exist, so the real Maps
  JavaScript, Places (New), Static Maps and Geocoding APIs were not called. They sit behind small interfaces
  (`lib/geo/geocode.ts` `Geocoder`, `lib/geo/maps-client.ts`) with a key-less path that is fully functional
  (bundled Hyderabad locality + PIN code table, list without map). Google responses are mocked in vitest and the
  Maps JS API was stubbed in the browser check; the eval's "markers match results" screenshot of real tiles must
  be taken once a browser key exists (setup in `docs/maps.md`).
- **Places Autocomplete** uses the Places API (New) data API (`AutocompleteSuggestion`) with our own accessible
  combobox instead of the legacy `Autocomplete` widget (unavailable to new keys since March 2025).
- **`search_providers` signature**: a trailing `p_include_synthetic boolean default true` (SQL cannot read the
  app's env) and extra output columns `org_slug`, `is_synthetic`, `lat`, `lng` (needed for links, the badge and
  map markers). `offers_*` are `not null` (defaults as specified).
- **Geocoded locality**: the provider-entered `locality` is kept (it is required and used in page titles); the
  geocoder's locality is only used for the `/find` heading.
- **Page size 50** (not specified): the map shows exactly the listed results, so clustering above 30 is reachable.
- **Consultation modes** became editable by the provider (profile editor, `PATCH /api/providers/:id`) and by
  admins when seeding, so the `Consultation` filter has data before 030 derives them from services.
- **Rate limit** is in-memory per server instance (same pattern as `/api/providers/join`).
- **Request logs**: the dev server drops request lines carrying `lat`/`lng`/`q`; production host logs are outside
  the app (noted for 041 retention).

## Notes

- New helpers: `lib/geo/constants.ts` (bbox, radius/mode vocabularies, `findHref`, `directionsUrl`,
  `staticMapUrl`, SEO slugs), `lib/geo/params.ts` (shared query schema), `lib/geo/search.ts`
  (`searchProviders`), `lib/geo/geocode.ts` (`getGeocoder`, `geocodeLocationFields`, `lookupLocality`),
  `lib/geo/rate-limit.ts`, `lib/geo/cluster.ts`, `lib/geo/maps-client.ts`; components in `components/directory/`.
- New env names (optional): `GOOGLE_MAPS_SERVER_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`,
  `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (`.env.example`, `lib/env.ts`, `docs/maps.md`).
- 030: replace the disabled `Book` buttons on result cards (`components/directory/ResultList.tsx`) and derive
  `offers_video`/`offers_in_clinic` from active services. 034: call `GET /api/public/providers` or
  `searchProviders()`. 036: fill `rating_avg`/`rating_count` in `search_providers`. 042: seed through
  `POST /api/admin/providers` with `lat`/`lng` (or PIN codes from the table) and `offers_*`.
- Shared files touched additively: `messages/*.json` (new `directory` namespace only), `messages/REVIEW.md`
  (regenerated), `lib/auth-access.ts` (one public API path), `docs/system-design.md` (one bullet, two env rows,
  one API row), `lib/env.ts`, `next.config.ts` (logging ignore).
- The E2E data (`e029 ... (synthetic)` profiles, `e029-*@example.test` accounts) is left in the slot 5 database;
  the `perf029` load data was deleted.
