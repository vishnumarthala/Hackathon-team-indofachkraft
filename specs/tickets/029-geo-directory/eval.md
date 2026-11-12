# 029: PostGIS directory - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes: `searchParams` as a promise,
  caching headers, `next/script`) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Data: create 6 synthetic verified, listed profiles via 028 admin seeding at known synthetic
  coordinates (e.g. Banjara Hills 17.4126,78.4482; Gachibowli 17.4401,78.3489; Secunderabad
  17.4399,78.4983), one unverified, one unlisted, one video-only. For NFR-1 use `042` seed if merged,
  else a SQL generator in `.tmp/`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>` (geocode fixtures). Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/directory-search.test.ts tests/geocode.test.ts --reporter=verbose` exits 0:
  distance ordering, radius filter, type/language/mode filters, video-only behaviour, unverified/unlisted/
  synthetic exclusion, India bbox 422, geocode failure path, one row per multi-location profile.

## Acceptance checks

### E-1: Search (FR-2, FR-3, FR-5)

1. `/find?lat=17.4126&lng=78.4482&radius_km=5` lists Banjara Hills providers first with distances;
   Gachibowli (~14 km) absent until `Distance` = `25 km`.
2. Filter `Speech-language pathologist` + `Telugu`: only matching. `Consultation` = `Video` includes the
   video-only profile.
3. Unverified/unlisted profiles never appear; API with `lat=51.5&lng=-0.1` -> 422 message.

### E-2: Map and fallback (FR-5, FR-6)

With a browser key: markers match results (screenshot). Without `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`:
list only, no console errors. `/p/<slug>` shows `Get directions` with the correct URL.

### E-3: Privacy and keys (NFR-2, NFR-3)

`Use my location` (mocked geolocation) -> results; server logs/DB contain no submitted coordinates
beyond the request log line (redacted). Client bundle grep for `GOOGLE_MAPS_SERVER_KEY` value -> none.

### E-4: Performance (NFR-1)

`explain analyze` of `search_providers` on 1,000 profiles shows an index scan on `geog`; p95 over 50
calls < 150 ms (record numbers).

### E-5: Rate limit (FR-3)

61st request within a minute from one IP -> 429.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
