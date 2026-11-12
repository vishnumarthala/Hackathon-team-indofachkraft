# 035: Appointment-scoped intake - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Data: 030 setup with one `child_dev` service and one `generic` service; `guardian_a`'s child with and
  without `ai_intake_call` consent (two children).
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-<port> npm run dev -- -p <port>` and
  `npm run -s outbox:run`. Use 010's simulate endpoint pattern for completion. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/appointment-intake.test.ts --reporter=verbose` exits 0: case reuse vs creation,
  consumer re-run idempotency, attempt expiry/revocation on cancel, duplicate webhook, consent re-check
  at start and completion, generic brief schema validation.

## Acceptance checks

### E-1: Child-Dev flow (FR-2 - FR-5)

Book the `child_dev` service for the consented child: a case is created in the org with the provider
assigned; confirmation includes `/intake/a/<token>`; open it -> language select en/hi/te; simulate
completion -> brief on the case; recording has `appointment_id`.

### E-2: Generic flow (FR-4, FR-5)

Book the `generic` service: link opens without language select; simulated completion -> one
`generic_intake_brief` report. Replay the webhook -> `duplicate: true`, no second report.

### E-3: Consent and expiry (FR-3, FR-4)

Child without consent: confirmation has the `Allow the AI intake call...` text and no link; grant
consent -> link issued (notification). Cancel the appointment -> link shows expired (410).

### E-4: Case reuse and authz

Second booking in the same org for the same child -> same case. Booking in another org -> a separate
case not visible to the first org. Token of another appointment cannot complete this one.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
