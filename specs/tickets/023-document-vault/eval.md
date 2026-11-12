# 023: Document vault - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Accounts via `npm run -s seed:users -- --prefix <acct>`; child of `guardian_a` with cases in org A and
  org B (020/022 eval setup). Synthetic test files generated into `.tmp/docs-<port>/` by
  `node -e` (a 1-page PDF, a PNG, a 21 MB file, a `.pdf` file containing PNG bytes). Never real documents.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/documents-access.test.ts tests/documents-upload.test.ts --reporter=verbose` exits 0,
  covering the FR-4 matrix (guardian linked/unlinked; provider own org / shared org / grant / revoked
  grant / other org; `visible_to_guardian` true/false; deleted documents), size/type/magic-byte
  rejections, and strict-audit failure -> no signed URL returned.

## Acceptance checks

### E-1: Guardian upload and share (FR-3, FR-7)

1. As `guardian_a`, upload the PDF titled `<acct> School letter`, category `School`, share with org A only.
2. As `provider_a`: visible in the case `Documents` tab; download works (302, signed URL expires; reuse after 5 min -> denied by storage).
3. As `provider_b`: not visible; `GET /api/documents/:id/download` -> 404.

### E-2: Provider upload visibility (FR-3, FR-8)

1. As `provider_a`, upload a PNG with `Parent can see this document` unticked -> `guardian_a` does not
   see it; direct download -> 404. Tick visibility -> guardian sees it.

### E-3: Validation (FR-2)

21 MB -> 413; `.txt` -> 415; PDF-named PNG bytes -> 422 and no object left in the bucket.

### E-4: Cross-org via grant (FR-4)

Guardian grants org A -> org B `Documents`: `provider_b` sees org A provider-uploaded documents read-only
under `Shared with us`; revoke -> 404 again. Guardian-uploaded documents not shared with org B stay hidden.

### E-5: Delete (FR-6)

`guardian_a` deletes own upload: object removed from storage, listed nowhere, audit `document.deleted`.
`guardian_a` `DELETE` on a provider document -> 403.

### E-6: Private bucket (NFR-1)

Anonymous `GET <SUPABASE_URL>/storage/v1/object/public/documents/<path>` -> not found/denied.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
