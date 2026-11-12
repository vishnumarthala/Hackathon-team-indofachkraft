# 042: Hyderabad seed data - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` if touching any app code (this ticket should not).
- `cp <main checkout>/.env.local .env.local`, `npm install`; migrations of 028-030 applied.
- Start (for E-3): `DEMO_MODE=true SHOW_SYNTHETIC_LISTINGS=true npm run dev -- -p <port>`.
- Synthetic CSV fixtures for the importer in `.tmp/import-<port>/` (valid file with 3 fictional rows,
  invalid file with a bad pincode and unknown provider type).

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/seed-hyderabad.test.ts tests/import-providers.test.ts --reporter=verbose` exits 0:
  determinism (same seed -> same names/coords), all generated coordinates within Hyderabad bbox, every
  record flagged synthetic, production guard, importer validation all-or-nothing, claim links not
  written to disk.

## Acceptance checks

### E-1: Synthetic seed (FR-1, FR-2, NFR-1)

`npm run -s seed:hyderabad -- --count 1000` completes < 60 s; JSON summary printed; >= 12 localities
and all 9 types present (SQL counts in `evidence/`).

### E-2: Visibility (FR-2)

By default `/find` near Gachibowli shows `(Demo)` providers with the `Demo profile` badge. Holding a
slot without `demo_ack` -> 422; with it -> an `is_demo` appointment with no email/WhatsApp outbox rows and no
payment. Restart with `SHOW_SYNTHETIC_LISTINGS=false`: none appear.

### E-3: Reset safety (FR-3)

Create one non-synthetic profile (028 admin seeding), run `--reset-synthetic`: synthetic count 0,
non-synthetic profile intact.

### E-4: Importer (FR-4)

Invalid CSV -> errors with row numbers, nothing imported. Valid CSV `--dry-run` -> nothing written;
real run -> 3 unclaimed, unverified, unlisted profiles; claim links printed and working (028 E-2).

### E-5: Guard and data (NFR-2)

With a non-local Supabase URL and no `ALLOW_SYNTHETIC_SEED`, the seed exits non-zero before writing.
Review `scripts/data/demo-names.json`: fictional names only.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
