# 007: Therapist review screen - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`, `mkdir -p .tmp`, `cp -R demo/fixtures .tmp/ct-fx-<port>`.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/ct-fx-<port> npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none needed.
- Seed / reset: `npm run -s seed:demo -- --new` -> note `case=` (C) and `session=` (S).

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Page shows transcript, 40 items, evidence and score (covers FR-1, FR-2, FR-3, FR-4, FR-5, FR-10, NFR-1)

- **Type:** Browser
- **Steps:**
  1. `curl -s -o /dev/null http://localhost:<port>/cases/<C>/sessions/<S>` (warm-up)
  2. `curl -s -o /dev/null -w "%{time_total}" http://localhost:<port>/cases/<C>/sessions/<S>`
  3. `npm run -s db:sql -- "select storage_path is not null as has_audio from recordings where id='<S>'"`
  4. `agent-browser open http://localhost:<port>/cases/<C>/sessions/<S>`
  5. `agent-browser eval "document.querySelectorAll('[data-item]').length"`
  6. `agent-browser eval "document.querySelectorAll('[id^=seg-s]').length"`
  7. `node -e "console.log(require('./demo/fixtures/roleplay-segments.json').length)"`
  8. `agent-browser eval "document.querySelectorAll('audio').length"`
  9. `agent-browser get text body`
  10. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 2 prints a time below `2`; step 5 returns `40`; step 6 equals step 7; when step 3 is
  `false`, step 8 returns `0` and step 9 contains `No audio uploaded for this session (transcript only).`,
  otherwise step 8 returns `1`; step 9 contains `Session 1`, `Therapist`, `Parent`,
  `ISAA total: at least`, `(provisional - 2 of 40 confirmed; AI-suggested total `,
  `Red flag: lost speech · Red flag: self-injury - consider referral`, `Referral recommended`,
  `Suggested by CareThread - the therapist decides`, `Voice note`, `AI suggested`,
  `No evidence - needs rating`, `Social relationship and reciprocity` and `Cognitive component`.

### E-2: Evidence button highlights the segment (covers FR-2, FR-5)

- **Type:** Browser
- **Steps:**
  1. `agent-browser snapshot -i` and click the first button whose name starts with `▶` (`agent-browser click @<ref>`)
  2. `agent-browser eval "document.querySelectorAll('[id^=seg-s][data-active=true]').length"`
- **Expected:** step 2 returns `1`.

### E-3: Confirm and edit one item (covers FR-6, FR-7, NFR-2)

- **Type:** Browser
- **Steps:**
  1. `npm run -s db:sql -- "select item_id, value from facts where recording_id='<S>' and status='suggested' and value is not null order by item_id::int limit 2"` -> items A (value a) and B (value b)
  2. `agent-browser find role button click --name "Confirm item <A>"`
  3. `agent-browser wait 1500`
  4. `agent-browser find role button click --name "Rate item <B> as <1 if b is not 1, else 2>"`
  5. `agent-browser wait 1500`
  6. `agent-browser get text body`
  7. `npm run -s db:sql -- "select item_id, value, status, confirmed_by from facts where recording_id='<S>' and item_id in ('<A>','<B>') order by item_id::int"`
  8. `npm run -s db:sql -- "select action, entity, details->>'from_status' as from_status, details->>'to_status' as to_status from audit_events where case_id='<C>' and action like 'fact.%' order by id"`
- **Expected:** step 6 contains `(provisional - 4 of 40 confirmed`; step 7 shows A with value a,
  `confirmed`, `Demo Therapist` and B with the clicked value, `edited`, `Demo Therapist`; step 8 lists
  `fact.confirmed` (entity `fact`, `suggested` -> `confirmed`) and `fact.edited` (`suggested` -> `edited`).

### E-4: Bulk actions reach a final score (covers FR-8, FR-9)

- **Type:** Browser
- **Steps:**
  1. `agent-browser find role button click --name "Rate all unrated as 1 (Rarely)"`
  2. `agent-browser find role button click --name "Yes"`
  3. `agent-browser wait 2000`
  4. `agent-browser find role button click --name "Confirm all remaining suggestions"`
  5. `agent-browser find role button click --name "Yes"`
  6. `agent-browser wait 2000`
  7. `agent-browser get text body`
  8. `npm run -s db:sql -- "select count(*)::int as n from facts where recording_id='<S>' and status in ('confirmed','edited') and value is not null"`
  9. `npm run -s db:sql -- "select count(*)::int as n from audit_events where entity_id='<S>' and action in ('facts.bulk_confirmed','facts.bulk_rated')"`
  10. `agent-browser screenshot evidence/E-4.png`
- **Expected:** step 7 contains `ISAA total: ` followed by a number, ` · ` and a band label, and does not
  contain `provisional`; step 8 `[{"n":40}]`; step 9 `[{"n":2}]`.

## Edge cases

### E-5: API errors (covers FR-6, FR-8)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/facts/00000000-0000-4000-8000-00000000ffff -H "Content-Type: application/json" -d '{"action":"confirm"}'`
  2. `npm run -s seed:demo -- --new` -> session S2
  3. `npm run -s db:sql -- "select id from facts where recording_id='<S2>' and value is null limit 1"` -> F
  4. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/facts/<F> -H "Content-Type: application/json" -d '{"action":"confirm"}'`
  5. `npm run -s db:sql -- "select id from facts where instrument='CASE_SHEET' and case_id=(select case_id from recordings where id='<S2>') limit 1"` -> G
  6. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/facts/<G> -H "Content-Type: application/json" -d '{"action":"edit","value":2}'`
  7. `curl -s -o /dev/null -w "%{http_code}" -X PATCH http://localhost:<port>/api/facts/<F> -H "Content-Type: application/json" -d '{"action":"edit","value":7}'`
  8. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/00000000-0000-4000-8000-00000000ffff/bulk -H "Content-Type: application/json" -d '{"action":"confirm_suggested"}'`
- **Expected:** step 1 `{"error":"Fact not found"} 404`; step 4 `{"error":"Rate this item before confirming"} 422`;
  step 6 `{"error":"Only ISAA items can be rated here"} 422`; step 7 `400`; step 8 `{"error":"Session not found"} 404`.

### E-6: Wrong case or unprocessed session (covers FR-1)

- **Type:** Browser
- **Steps:**
  1. `npm run -s seed:demo -- --new` -> case C3
  2. `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/cases/<C3>/sessions/<S>`
  3. `npm run -s seed:demo -- --new --stage transcribed` -> case C4, session S4
  4. `agent-browser open http://localhost:<port>/cases/<C4>/sessions/<S4>`
  5. `agent-browser get text body`
  6. `agent-browser eval "document.querySelector('a[href$=\"/sessions/new\"]') !== null"`
- **Expected:** step 2 `404`; step 5 contains `This session is transcribed. Process it from the New session page.`;
  step 6 returns `true`.

### E-7: Status rules unit tests and wording (covers FR-6, FR-8, NFR-3)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/facts.test.ts --reporter=verbose`
  2. `node scripts/dev/check-copy.mjs app/cases components/session`
- **Expected:** step 1 exits 0 with tests for confirm, edit, same-value edit, null confirm, both bulk
  actions; step 2 prints `clean`.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-6 |
| FR-2 | E-1, E-2 |
| FR-3 | E-1 |
| FR-4 | E-1 |
| FR-5 | E-1, E-2 |
| FR-6 | E-3, E-5, E-7 |
| FR-7 | E-3 |
| FR-8 | E-4, E-5, E-7 |
| FR-9 | E-4 |
| FR-10 | E-1 |
| NFR-1 | E-1 |
| NFR-2 | E-3 |
| NFR-3 | E-7 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-4 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
