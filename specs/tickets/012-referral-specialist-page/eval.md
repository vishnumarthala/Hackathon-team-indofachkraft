# 012: Referral packet, specialist page and email - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: `DEMO_MODE=true NEXT_PUBLIC_APP_URL=http://localhost:<port> npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none (no login).
- Seed / reset: `npm run seed:demo -- --new --confirmed | tail -1` -> case C, session S.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- Extend `tests/packet.test.ts` to check a session with suggested ratings and confirmed ratings:
  no suggested values or `suggested_total` occur anywhere in the serialized packet. Test multiple
  sessions to ensure the displayed and referred session are the same, including the 422 case.

## Acceptance checks

### E-1: Send a referral from the Referral tab (covers FR-1, FR-2, FR-3, FR-4)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>/referral`
  2. `agent-browser get text body`
  3. `agent-browser find label "Specialist name" fill "Dr. Example Specialist"`
  4. `agent-browser find label "Specialist email" fill "specialist@example.com"`
  5. `agent-browser snapshot -i` (check `Send referral` is disabled)
  6. `agent-browser find label "The parent consented to share this case with the specialist" check`
  7. `agent-browser find role button click --name "Send referral"`
  8. `agent-browser get text body`
  9. `npm run db:sql -- "select r.status, r.parent_consent, r.emailed, length(r.share_token) as len, jsonb_array_length(r.packet->'key_evidence') as ev, c.status as case_status from referrals r join cases c on c.id=r.case_id where r.case_id='<C>'"`
  10. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 2 contains `Referral recommended`, `Red flag: lost speech`, `Red flag: self-injury`,
  `Suggested by CareThread - the therapist decides`, and the reason box contains
  `Red flag: lost speech; Red flag: self-injury`; step 5 shows the button disabled; step 8 contains
  `Referral sent`, `http://localhost:<port>/specialist/`, `Open specialist view`,
  `Email not sent (demo mode)`; step 9 `[{"status":"sent","parent_consent":true,"emailed":false,"len":43,"ev":<1..8>,"case_status":"referred"}]`.

### E-2: Specialist page (covers FR-5, FR-6, NFR-1, NFR-2)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open <specialist url from E-1>`
  2. `agent-browser get text body`
  3. `npm run db:sql -- "select status, viewed_at is not null as viewed from referrals where case_id='<C>'"`
  4. `ls app/api | grep -i referral || echo "no referral listing api"`
  5. `agent-browser screenshot evidence/E-2.png`
- **Expected:** step 2 contains `Referral: Ravi (synthetic)`, `From Demo Therapist`, `Reason`,
  `Questions for the specialist`, `ISAA total: `, `Key evidence`, `Session 1 · `,
  `Parent-reported at intake`, `Suggested by CareThread - the therapist decides` and
  `Prepared with CareThread. AI documents, the clinician decides. This is not a diagnosis by AI.`, and
  does not contain `AI suggested`; step 3 `[{"status":"viewed","viewed":true}]`; step 4 prints
  `no referral listing api`.

### E-3: Packet builder (covers FR-4, FR-7)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/packet.test.ts --reporter=verbose`
- **Expected:** exits 0 with tests for key-evidence order and max 8, verified-only evidence, decisions,
  intake highlights max 5, provisional score.

## Edge cases

### E-4: Validation and preconditions (covers FR-3)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/refer -H "Content-Type: application/json" -d '{"specialist_name":"S","specialist_email":"s@example.com","reason":"abc","parent_consent":false}'`
  2. `npm run seed:demo -- --new --stage transcribed | tail -1` -> C2; `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C2>/refer -H "Content-Type: application/json" -d '{"specialist_name":"S","specialist_email":"s@example.com","reason":"abc","parent_consent":true}'`
  3. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/00000000-0000-4000-8000-00000000ffff/refer -H "Content-Type: application/json" -d '{"specialist_name":"S","specialist_email":"s@example.com","reason":"abc","parent_consent":true}'`
  4. `agent-browser open http://localhost:<port>/cases/<C2>/referral` and `agent-browser get text body`
- **Expected:** step 1 400 with `"parent_consent":"Parent consent is required"`; step 2
  `{"error":"Confirm at least one ISAA item before referring"} 422`; step 3 `{"error":"Case not found"} 404`;
  step 4 contains `Process and confirm a session before referring.`

### E-5: Invalid or revoked link (covers FR-5)

- **Type:** API
- **Steps:**
  1. `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/specialist/not-a-token`
  2. `npm run db:sql -- "update referrals set status='revoked' where case_id='<C>' returning share_token"` -> token R
  3. `curl -s http://localhost:<port>/specialist/<R> | grep -o "This referral link is no longer valid."`
- **Expected:** step 1 `404`; step 3 prints the sentence.

### E-6: Gemini failure stores nothing (covers FR-3)

- **Type:** automated route test
- **Steps:** `npx vitest run tests/packet.test.ts --reporter=verbose`
- **Expected:** mock Gemini failure and assert 502 `Referral could not be prepared` and no referral
  is stored. The shared dev server stays running.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-4 |
| FR-2 | E-1 |
| FR-3 | E-1, E-4, E-6 |
| FR-4 | E-1, E-3 |
| FR-5 | E-2, E-5 |
| FR-6 | E-2 |
| FR-7 | E-3 |
| NFR-1 | E-2 |
| NFR-2 | E-2 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-3 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
