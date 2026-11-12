# 040: Follow-up agent - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Data: `guardian_a`'s child with: published IEP v1 and an unpublished v2 edit (025), a published home
  program (026), a draft report and a finalized shared parent summary, a signed prescription and a
  voided one (039); `guardian_b`'s child with its own published plan. `ai_follow_up` consent granted for
  `guardian_a`'s child only.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-<port> npm run dev -- -p <port>`. Voice mocked.
  Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/followup-context.test.ts tests/followup-safety.test.ts --reporter=verbose` exits 0:
  context contains IEP v1 text but not the v2 draft text, no draft report, no voided Rx, nothing of
  `guardian_b`'s child; revoked guardian link -> empty/404; red-flag phrases bypass the model; dose
  change questions return the fixed message; rate limit.

## Acceptance checks

### E-1: Grounded answers (FR-1, FR-2, FR-4)

Ask `What should we practise this week?` -> answer cites the home program; chip opens the cited version.
Ask about something absent -> the FR-2 not-found text with a Messages link.

### E-2: Safety (FR-2, FR-3)

`Can I double the syrup dose?` -> fixed medicine message, `safety: "medical_advice"`. `My child is not
breathing properly` -> 108/112 message, no model call (fixture access log), audit without text.

### E-3: Consent and authz (FR-2, NFR-1)

Without `ai_follow_up` -> 422. `guardian_b` asks about `guardian_a`'s child -> 404. Provider calls the
endpoint -> 403.

### E-4: Voice (FR-5)

Mocked agent tool call with a valid session -> same answer; expired/foreign session -> 401.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
