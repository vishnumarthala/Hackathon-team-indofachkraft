# 039: E-prescriptions - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Data: verified paediatrician `provider_rx` (NMC, synthetic number) and SLP `provider_a` in org A; a
  case for `guardian_a`'s child with a health profile allergy `Synthetic-drug-X`; an `rx_draft` from 038
  fixtures. Start: `DEMO_MODE=true npm run dev -- -p <port>` and `npm run -s outbox:run`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/prescriptions.test.ts --reporter=verbose` exits 0: prescriber gate matrix
  (verified/suspended/non-prescriber type), re-check at sign time (suspend between draft and sign ->
  403), immutability trigger, allergy match requiring override, deterministic hash, strict audit failure
  -> 503 and no version.

## Acceptance checks

### E-1: Draft -> sign -> guardian (FR-3, FR-4, FR-5)

As `provider_rx`, create from the `rx_draft`, edit one dose, sign with the confirmation: version 1
stored with snapshots; PDF downloads with footer details; guardian sees it and gets a notification
without drug names.

### E-2: Allergy and immutability (FR-4, FR-1)

Add `Synthetic-drug-X` -> sign -> 422 with matches; with override reason -> signed and reason stored.
`update prescription_versions` on a signed row -> error. `Void` with reason -> status `void`, guardian
sees `Cancelled by prescriber`.

### E-3: Authz negatives (NFR-1)

`provider_a` (SLP) -> tab hidden and APIs 403. `provider_rx` suspended by admin -> sign 403.
`provider_b` (other org) -> 404. `guardian_b` downloads the PDF -> 404.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
