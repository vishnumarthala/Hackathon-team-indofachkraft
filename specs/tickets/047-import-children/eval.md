# 047: Import existing children - Evaluation

## Setup

- An org with 2 therapists. Fixture CSVs in `tests/fixtures/import/`: `valid-20.csv`, `errors.csv` (future
  DOB, unknown therapist, bad phone), `telugu-names.csv`, `dupes.csv`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/import-*.test.ts --reporter=verbose` exits 0, covering:
  - Both date formats parse.
  - Each row error message names the row.
  - Duplicates are detected.
  - Re-uploading the same file is idempotent.
  - No `consent_records` rows are created.
  - No outbox messages are queued.
  - Undo inside 24 h works and is refused once a session note exists.
  - A member (not owner/admin) gets 403.
  - 500 rows complete in < 30 s.

## Acceptance checks

### E-1: Happy path (FR-1, FR-3, FR-4)

Upload `valid-20.csv`; the preview shows 20 valid rows. Import: 20 children and cases appear on the
dashboard, and the result list has 20 codes with WhatsApp links.

### E-2: Errors (FR-2)

Upload `errors.csv`. Each bad row shows a plain message, and the import button covers only the valid rows.

### E-3: Consent stays honest (D-1)

Open an imported child. Consent shows `Not given`, and `Record paper consent` opens the 020 flow.
