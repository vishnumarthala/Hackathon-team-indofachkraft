# 013: Ask the case - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: `DEMO_MODE=true NEXT_PUBLIC_APP_URL=http://localhost:<port> npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none (no login).
- Seed / reset: `npm run seed:demo -- --new --confirmed | tail -1` -> case C; create a referral:
  `curl -s -X POST http://localhost:<port>/api/cases/<C>/refer -H "Content-Type: application/json" -d '{"specialist_name":"Dr. Example","specialist_email":"s@example.com","reason":"Red flags","parent_consent":true}'` -> `url` (token K = last path part).

## Automated checks

- Extend `tests/ask.test.ts` to cover citations removed by context truncation, missing audio, and
  concurrent requests at the 50-question limit, including release on Gemini failure.
- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Ask from the specialist page (covers FR-1, FR-2, FR-3, FR-4, FR-6, NFR-1)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/specialist/<K>`
  2. `agent-browser find role button click --name "When did speech regress?"`
  3. `agent-browser find role button click --name "Ask"` (time it)
  4. `agent-browser get text body`
  5. `npm run db:sql -- "select q.question, q.found, jsonb_array_length(q.citations) as n, q.citations->0->>'label' as label from case_questions q join referrals r on r.id=q.referral_id where r.share_token='<K>'"`
  6. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 3 answers in < 5 s; step 4 contains `Ask the case`, the answer text from
  `demo/fixtures/gemini/ask.json` and a chip starting `Session 1 · `; step 5
  `[{"question":"When did speech regress?","found":true,"n":<>=1>,"label":"Session 1 · <mm:ss>"}]`.

### E-2: Citation rules (covers FR-2, FR-3, FR-5, FR-7, NFR-2)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/ask.test.ts --reporter=verbose`
  2. `grep -c "Not documented in this case." prompts/ask.md`
- **Expected:** step 1 exits 0 with tests for valid fact id, unknown fact id dropped, `1:s<k>` and
  `intake:t<k>` labels, found-without-citations fallback, context cut order; step 2 prints a number >= 1.

## Edge cases

### E-3: Access, validation and limit (covers FR-1)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/ask -H "Content-Type: application/json" -d '{"share_token":"wrong","question":"Any self-injury?"}'`
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/ask -H "Content-Type: application/json" -d '{"share_token":"<K>","question":"?"}'`
  3. `for i in $(seq 1 50); do curl -s -o /dev/null -X POST http://localhost:<port>/api/cases/<C>/ask -H "Content-Type: application/json" -d '{"share_token":"<K>","question":"Any self-injury?"}'; done; curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/ask -H "Content-Type: application/json" -d '{"share_token":"<K>","question":"Any self-injury?"}'`
  4. `npm run db:sql -- "update referrals set status='revoked' where share_token='<K>'"`; repeat step 1 with `<K>`
- **Expected:** step 1 `{"error":"Not found"} 404`; step 2 status `400`; step 3 last line
  `{"error":"Question limit reached for this referral"} 429`; step 4 `{"error":"Not found"} 404`.

### E-4: Gemini failure (covers FR-4)

- **Type:** automated route test
- **Steps:** `npx vitest run tests/ask.test.ts --reporter=verbose`
- **Expected:** mock Gemini failure and assert 502 `The question could not be answered` and no
  question is stored. The shared dev server stays running.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-3 |
| FR-2 | E-1, E-2 |
| FR-3 | E-1, E-2 |
| FR-4 | E-1, E-4 |
| FR-5 | E-2 |
| FR-6 | E-1 |
| FR-7 | E-2 |
| NFR-1 | E-1 |
| NFR-2 | E-2 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-2 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
