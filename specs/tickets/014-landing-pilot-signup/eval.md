# 014: Landing page and pilot sign-up - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none (no login). Use emails `t<port>-<n>@example.com`.
- Seed / reset: none.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Landing content (covers FR-1, FR-5)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/`
  2. `agent-browser get text body`
  3. `agent-browser get title`
  4. `agent-browser find role link click --name "Open the demo"` then `agent-browser get url`
  5. `agent-browser screenshot evidence/E-1.png` (taken after step 1)
- **Expected:** step 2 contains the exact subtitle, `1. Intake call`, `2. Online session`,
  `3. Specialist handoff`, `AI documents, the clinician decides.`,
  `Pilot pricing: Rs 3,000 (India) / EUR 199 (Germany) per clinician per month` and `Join the pilot`;
  step 3 `CareThread - AI assistant for early intervention therapists`; step 4 ends with `/dashboard`.

### E-2: Sign up through the form (covers FR-2, FR-3, FR-4)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/#pilot`
  2. `agent-browser find label "Name" fill "Test Therapist"`
  3. `agent-browser find label "Email" fill "T<port>-1@Example.com "`
  4. `agent-browser find label "I am a" select "Therapist"`
  5. `agent-browser find label "Country" fill "India"`
  6. `agent-browser find label "Number of clinicians (optional)" fill "4"`
  7. `agent-browser find role button click --name "Join the pilot"`
  8. `agent-browser get text body`
  9. `npm run db:sql -- "select email, role, clinicians from pilot_signups where email='t<port>-1@example.com'"`
  10. `agent-browser open http://localhost:<port>/dashboard/pilots` and `agent-browser get text body`
- **Expected:** step 8 contains `Thanks, you're on the pilot list. We'll contact you soon.`; step 9
  `[{"email":"t<port>-1@example.com","role":"therapist","clinicians":4}]`; step 10 contains
  `Pilot sign-ups`, `sign-ups`, `t<port>-1@example.com`, `India`.

## Edge cases

### E-3: Validation, duplicate and honeypot (covers FR-3)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/pilot-signups -H "Content-Type: application/json" -d '{"name":"","email":"x","role":"boss","country":"","clinicians":0}'`
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/pilot-signups -H "Content-Type: application/json" -d '{"name":"Again","email":"t<port>-1@example.com","role":"parent","country":"Germany"}'`
  3. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/pilot-signups -H "Content-Type: application/json" -d '{"name":"Bot","email":"t<port>-bot@example.com","role":"other","country":"XX","website":"http://spam"}'`
  4. `npm run db:sql -- "select (select name from pilot_signups where email='t<port>-1@example.com') as name, (select count(*)::int from pilot_signups where email='t<port>-bot@example.com') as bot"`
- **Expected:** step 1 status 400 with details `Name is required`, `Enter a valid email`,
  `Choose who you are`, `Country is required`, `Clinicians must be between 1 and 1000`; step 2
  `{"ok":true} 200`; step 3 `{"ok":true} 200`; step 4 `[{"name":"Test Therapist","bot":0}]`.

### E-4: Mobile and copy rules (covers NFR-1, NFR-2)

- **Type:** Browser
- **Steps:**
  1. `agent-browser set viewport 375 800`, `agent-browser open http://localhost:<port>/`
  2. `agent-browser eval "document.documentElement.scrollWidth <= window.innerWidth"`
  3. `agent-browser console` (list console messages)
  4. `grep -rniE "diagnos|hipaa compliant|fee per referral" app/page.tsx components/landing | grep -vi "not a diagnosis" || echo clean`
- **Expected:** step 2 `true`; step 3 shows no `error` entries; step 4 prints `clean`.

### E-5: Validation unit tests (covers FR-3)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/pilot-validation.test.ts --reporter=verbose`
- **Expected:** exits 0 with tests for every message in FR-3, email lower-casing/trimming and the honeypot.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1 |
| FR-2 | E-2 |
| FR-3 | E-2, E-3, E-5 |
| FR-4 | E-2 |
| FR-5 | E-1 |
| NFR-1 | E-4 |
| NFR-2 | E-4 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-2 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
