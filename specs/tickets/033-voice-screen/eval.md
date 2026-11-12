# 033: Voice developmental check-in - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Voice is mocked (`@elevenlabs/react` + client
  tools); live agent check is a manual smoke test by a human. Accounts from `seed:users`. Synthetic
  answers only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/screen-flow.test.ts tests/screen-red-flags.test.ts --reporter=verbose` exits 0:
  band computation for synthetic answer sets per age band; every red-flag code stops the flow and the
  finish response has no band; session expiry; rate limit; `screen_sessions` contains no free-text
  fields; save requires consent and child link.

## Acceptance checks

### E-1: Form mode (FR-2, FR-4, FR-6)

At 375 px, choose `3-5 years`, tick the agreement, `Answer by tapping instead`, answer all questions
with a "some concerns" pattern: result headline `Some areas are worth discussing with a professional`,
`not a diagnosis` line, directory with suggested types. Start disabled until ticked.

### E-2: Red flag (FR-7)

Answer the regression red-flag question `yes`: only the 108/112 message; no provider list or `Book`
anywhere in the DOM; API `finish` -> `red_flag: true`, no band.

### E-3: Voice (mocked) (FR-3, FR-4)

Mock the SDK: client tool calls `record_answer` x N then `finish` -> same result as the form for the
same answers. DEMO_MODE -> `{ demo: true }` and no SDK start.

### E-4: Pre-consent data and save (FR-5, FR-8)

1. `screen_sessions` row has only the FR-5 columns; no IP.
2. Anonymous save -> 401. `guardian_a` save without `screen_result_save` consent -> 422; allow -> saved
   to own child; save to `guardian_b`'s child -> 404.

### E-5: Agent guide (FR-3)

`docs/elevenlabs-screen-agent.md` contains the no-PII rules, red-flag-first order, fixed safety
message, client tools and env var name.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
