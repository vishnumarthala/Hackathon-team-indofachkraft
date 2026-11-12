# 021: Child health profile - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) for route handlers and forms before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; a child of `guardian_a` claimed into a case of
  org A (`seed:demo -- --new` + claim, see 020 eval) and an org B provider without a case for that child.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/health-profile.test.ts --reporter=verbose` exits 0, covering schema limits,
  NKA exclusivity, version conflict 409, history row per update, `healthSummary` output, audit details
  without values.

## Acceptance checks

### E-1: Guardian edits (FR-3, FR-4)

1. As `guardian_a`, add allergy `Peanut / hives / severe`, medicine `Synthetic syrup 5 ml twice daily`,
   save. Reload: values persist, `version = 1`, `Last updated` line shown.
2. Tick `No known allergies` while an allergy exists -> validation error.

### E-2: Concurrent edit (FR-3)

Open the editor in two tabs, save tab 1, then save tab 2 -> FR-3 409 message; tab 2 data not written.

### E-3: Provider read-only + banner (FR-5)

1. As `provider_a`, open the case: banner `Severe allergy: Peanut`; `Health` tab shows the profile, no edit controls.
2. `PUT /api/family/children/:id/health` as `provider_a` -> 403.

### E-4: Authz negatives (NFR-1)

1. As `provider_b` (org B, no case for the child): `GET /api/cases/<org A case>/health` -> 404.
2. As `guardian_b` (not linked): `GET /api/family/children/<id>/health` -> 404.
3. Remove `provider_a` from org A (017 revoke) -> next `GET /api/cases/:id/health` -> 403/404.

### E-5: History and privacy (FR-6, NFR-3)

1. History lists both versions; the older snapshot is read-only.
2. `audit_events.details` for `health_profile.updated` contains section names only, not `Peanut`.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
