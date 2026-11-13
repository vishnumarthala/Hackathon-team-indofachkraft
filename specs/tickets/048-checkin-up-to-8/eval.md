# 048: Parent check-in up to 8 - Evaluation

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/screen-*.test.ts --reporter=verbose` exits 0, covering:
  - The new bands are validated, and `9y+` gets no questions.
  - `under-18m` gets no questions.
  - `MCHAT_LICENSED=false` → ISAA-derived 18–35-month items; `true` → the 20 M-CHAT items with the
    official scoring (low / moderate → follow-up / high).
  - The concern → provider-type mapping is covered by a table test.
  - A red flag still overrides everything.
  - Old sessions with `10y+` still render.

## Acceptance checks

### E-1: Speech worry, age 2½–5 (FR-5, FR-6)

Choose speech, answer by tapping, and get a "closer look" result. The first suggestion is a speech
therapist with a one-line reason, and a developmental paediatrician comes second. The free options
card is shown.

### E-2: Under 18 months (FR-2)

The milestone guidance and the paediatrician advice appear, with no questions.

### E-3: Over 8 (FR-1)

The "up to 8" page appears with a link to `/find`.
