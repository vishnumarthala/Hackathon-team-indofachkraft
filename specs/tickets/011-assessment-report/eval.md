# 011: Draft assessment report - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none (no login).
- Seed / reset: `npm run seed:demo -- --new --confirmed | tail -1` -> case C, session S.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- Extend `tests/report.test.ts` to assert that unconfirmed ratings never appear in the model prompt,
  report or domain sums, and that unsupported item IDs and evidence-free quotations are rejected.

## Acceptance checks

### E-1: Generate, edit and finalize (covers FR-1, FR-2, FR-3, FR-4, FR-5, NFR-1, NFR-2)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>/report`
  2. `agent-browser find role button click --name "Generate draft report"` (time it)
  3. `agent-browser get text body`
  4. `npm run db:sql -- "select sum((value)::int)::int as total from facts where recording_id='<S>' and instrument='ISAA'"`
  5. `agent-browser find label "Report (Markdown)" fill "# Edited by therapist"`, then `agent-browser find role button click --name "Save"`, then `agent-browser get text body`
  6. `agent-browser find role button click --name "Mark final"`, then `agent-browser get text body`
  7. `npm run db:sql -- "select status, content_md from reports where recording_id='<S>' and kind='assessment'"`
  8. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 2 completes in < 5 s; step 3 contains `Assessment report - Ravi (synthetic)`,
  `Session 1`, `ISAA total: <total from step 4> · `, `Observations`, `Red flags`, `Lost speech`,
  `Suggested next steps` and
  `AI-drafted from confirmed observations. Reviewed and decided by Demo Therapist. This is not a diagnosis by AI.`;
  step 5 shows `Saved`; step 6 shows `Final` and no `Save` button; step 7 shows `final` and `# Edited by therapist`.

### E-2: Markdown composer rules (covers FR-4, FR-6, FR-7)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/report.test.ts --reporter=verbose`
  2. `grep -ciE "total score|band" prompts/report.md`
- **Expected:** step 1 exits 0 with tests for headings, domain table, provisional wording, red flags,
  footer; step 2 prints a number >= 1 (the prompt tells the model not to compute the total score or band).

## Edge cases

### E-3: Preconditions and errors (covers FR-1, FR-3, FR-5)

- **Type:** API
- **Steps:**
  1. `npm run seed:demo -- --new | tail -1` -> S2 (2 confirmed items) and `npm run seed:demo -- --new --stage transcribed | tail -1` -> case C3, S3
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<S3>/report`
  3. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<S>/report` (the report from E-1 is final)
  4. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/reports/00000000-0000-4000-8000-00000000ffff -H "Content-Type: application/json" -d '{"status":"final"}'`
  5. `npm run db:sql -- "select id from reports where case_id=(select case_id from recordings where id='<S2>') and kind='pre_session_brief'"` -> B; `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/reports/<B> -H "Content-Type: application/json" -d '{"content_md":"x"}'`
  6. `agent-browser open http://localhost:<port>/cases/<C3>/report` and `agent-browser get text body`
  7. `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:<port>/api/sessions/<S2>/report`
- **Expected:** step 2 `{"error":"Confirm at least one ISAA item first"} 422` (S3 exists but has no
  facts); step 3 `{"error":"Report is final"} 409`; step 4 `{"error":"Report not found"} 404`;
  step 5 `{"error":"Only assessment reports can be edited here"} 422`; step 6 contains
  `Confirm ISAA items in a session first.`; step 7 `200` (provisional report allowed).

### E-4: Gemini failure (covers FR-3)

- **Type:** automated route test
- **Steps:** `npx vitest run tests/report.test.ts --reporter=verbose`
- **Expected:** mock Gemini failure and assert 502 `Report could not be generated` and no draft is
  created or overwritten. The shared dev server stays running.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-3 |
| FR-2 | E-1 |
| FR-3 | E-1, E-3, E-4 |
| FR-4 | E-1, E-2 |
| FR-5 | E-1, E-3 |
| FR-6 | E-2 |
| FR-7 | E-2 |
| NFR-1 | E-1 |
| NFR-2 | E-1 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-2 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
