# 004: Cases dashboard and case pages - Evaluation

## Setup

- `mkdir -p .tmp` for local test files.
- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: run prefix `<acct>` (e.g. `t3002-114502`, new per run). Child aliases start with `<acct>-`.
- Seed / reset: none.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `node scripts/dev/build-without-env.mjs` exits 0 (NFR-1)

## Acceptance checks

### E-1: Create a case through the UI (covers FR-1, FR-2, FR-5, FR-6, NFR-2)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/dashboard`
  2. `agent-browser find role link click --name "New case"`
  3. `agent-browser find label "Child alias" fill "<acct>-ravi"`
  4. `agent-browser find label "Child age (months)" fill "40"`
  5. `agent-browser find label "Parent alias" fill "<acct>-lakshmi"`
  6. `agent-browser find label "Parent email" fill "parent@example.com"`
  7. `agent-browser find label "Language" select "Telugu"`
  8. `agent-browser find role button click --name "Create case"`
  9. `agent-browser wait 2000`
  10. `agent-browser get url`
  11. `agent-browser get text body`
  12. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 10 matches `/cases/[0-9a-f-]{36}$` (call this id C); step 11 contains `<acct>-ravi`,
  `40 months`, `Telugu`, `Booked`, the tab links `Overview`, `Brief`, `Sessions`, `Report`, `Referral`,
  and `Send the parent an intake link from the Brief tab.`

### E-2: Dashboard lists the case (covers FR-1)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/dashboard`
  2. `agent-browser get text body`
  3. `agent-browser find role link click --name "<acct>-ravi"`
  4. `agent-browser get url`
- **Expected:** step 2 contains `Cases`, `Child`, `Age`, `Language`, `Status`, `Created`, `<acct>-ravi`,
  `40 months`, `Telugu`; step 4 ends with `/cases/<C>`.

### E-3: API validation messages (covers FR-3)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases -H "Content-Type: application/json" -d '{"child_alias":"","child_age_months":5,"parent_alias":"x","parent_email":"nope","language":"fr"}'`
  2. `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:<port>/api/cases -H "Content-Type: application/json" -d '{"child_alias":"<acct>-api","parent_alias":"p","language":"hi","parent_phone":"+49 151 0000000"}'`
- **Expected:** step 1 ends with ` 400` and its body is
  `{"error":"Invalid request","details":{"child_alias":"Child alias is required","child_age_months":"Age must be between 12 and 216 months","parent_email":"Enter a valid email","language":"Choose English, Hindi or Telugu"}}`
  (key order may differ); step 2 prints `201`.

### E-4: FACP update and next-step texts (covers FR-4, FR-6)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>`
  2. `agent-browser find label "FACP score (0-100)" fill "55"`
  3. `agent-browser find role button click --name "Save FACP score"`
  4. `agent-browser wait 1500`
  5. `agent-browser get text body`
  6. `npm run -s db:sql -- "select facp_score from cases where id='<C>'"`
  7. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/cases/<C> -H "Content-Type: application/json" -d '{"facp_score":101}'`
  8. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/cases/<C> -H "Content-Type: application/json" -d '{}'`
  9. `curl -s -o /dev/null -w "%{http_code}" -X PATCH http://localhost:<port>/api/cases/<C> -H "Content-Type: application/json" -d '{"parent_email":""}'`
  10. `npm run -s db:sql -- "select parent_email from cases where id='<C>'"`
  11. `agent-browser open http://localhost:<port>/cases/<C>` then `agent-browser eval "document.querySelector('input[name=facp_score]').value"`
- **Expected:** step 5 contains `Saved`; step 6 `[{"facp_score":55}]`; step 7 ends with ` 400` and the
  body contains `FACP score must be between 0 and 100`; step 8 `{"error":"Nothing to update"} 400`;
  step 9 `200`; step 10 `[{"parent_email":null}]`; step 11 returns `55`.

### E-5: Sessions tab, tab highlighting and placeholders (covers FR-5, FR-7, FR-8)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>/sessions`
  2. `agent-browser get text body`
  3. `agent-browser open http://localhost:<port>/cases/<C>/sessions/new`
  4. `agent-browser eval "document.querySelector('a[aria-current=page]')?.textContent.trim()"`
  5. `agent-browser open http://localhost:<port>/cases/<C>/report`
  6. `agent-browser get text body`
  7. `agent-browser eval "document.querySelector('a[aria-current=page]')?.textContent.trim()"`
- **Expected:** step 2 contains `No sessions yet.` and `New session`; step 4 returns `Sessions` (the page
  itself may be a 404 until 008); step 6 contains `Report` and `Coming soon.`; step 7 returns `Report`.

## Edge cases

### E-6: Unknown and malformed ids (covers FR-4, FR-5, FR-9)

- **Type:** API
- **Steps:**
  1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/cases/00000000-0000-4000-8000-00000000ffff`
  2. `curl -s http://localhost:<port>/cases/not-a-uuid -o .tmp/ct-404-<port>.html -w "%{http_code}"`
  3. `grep -c "Case not found" .tmp/ct-404-<port>.html`
  4. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/cases/not-a-uuid -H "Content-Type: application/json" -d '{"facp_score":10}'`
- **Expected:** step 1 `404`; step 2 `404`; step 3 a number >= 1; step 4 `{"error":"Case not found"} 404`.

### E-7: Mobile width (covers NFR-3)

- **Type:** Browser
- **Steps:**
  1. `agent-browser set viewport 375 800`
  2. `agent-browser open http://localhost:<port>/dashboard`
  3. `agent-browser eval "document.documentElement.scrollWidth <= window.innerWidth"`
  4. `agent-browser screenshot evidence/E-7.png`
- **Expected:** step 3 returns `true`.

### E-8: Validation unit tests (covers FR-3, FR-4)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/cases-validation.test.ts --reporter=verbose`
- **Expected:** exits 0 with tests for every message in FR-3, whitespace-only strings, phone regex,
  empty PATCH body, and clearing `parent_email`.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-2 |
| FR-2 | E-1 |
| FR-3 | E-3, E-8 |
| FR-4 | E-4, E-6, E-8 |
| FR-5 | E-1, E-5, E-6 |
| FR-6 | E-1, E-4 |
| FR-7 | E-5 |
| FR-8 | E-5 |
| FR-9 | E-6 |
| NFR-1 | Automated checks (build without .env.local) |
| NFR-2 | E-1 |
| NFR-3 | E-7 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-5 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
