# 034: Voice booking agent - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, set `ELEVENLABS_TOOL_SECRET=test-<port>`, `npm install`.
- Data: 030 setup (verified provider with slots), `guardian_a` with a child.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Live agent check is a manual human smoke test.
  Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/booking-agent-tools.test.ts --reporter=verbose` exits 0: secret missing/wrong ->
  401; expired/unknown session -> 401; extra payload keys -> 400; 21st tool call -> 429; second hold
  releases the first; `slot_taken` path; result limits (5 providers, 6 slots).

## Acceptance checks

### E-1: Scripted conversation to hold (FR-3, FR-4, NFR-3)

In DEMO_MODE, `Book by voice` -> scripted flow searches, lists slots, holds one: card shows provider,
time and countdown; `appointments` row `held` with `hold_owner_session` = sha256 of the cookie value.

### E-2: Confirm requires sign-in (FR-4, D-2)

`Sign in and confirm` -> sign in as `guardian_a` -> choose child -> confirm -> `confirmed`. Calling
`booking_confirm` through any agent tool endpoint is impossible (no such tool; direct POST to
`/api/appointments/:id/confirm` without session -> 401).

### E-3: Hold ownership (030 rule 10)

A different browser (other cookie) opening the confirm URL cannot attach the hold -> 404.

### E-4: Safety and PII (FR-1, NFR-2)

Guide contains red-flag handling and no-PII rules; a tool call with `child_name` -> 400; audit details
contain only the session hash.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
