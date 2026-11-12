# 026: Home program - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; child of `guardian_a` with an org A case that
  has an active published IEP plan with one goal (025 eval E-1 or a seed flag `--with-iep`).
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/home-program.test.ts --reporter=verbose` exits 0: adherence maths across week
  boundaries in Asia/Kolkata (Sunday 23:30 IST vs Monday 00:30 IST), log upsert idempotency, date
  window validation, goal-from-other-plan rejection, draft exclusion for guardians.

## Acceptance checks

### E-1: Publish and view (FR-2, FR-3, FR-5)

1. As `provider_a`, add activity `Snack-time requesting`, linked to the goal, 5 times/week, 10 minutes;
   publish. Linking a goal from another case -> 422 message.
2. As `guardian_a`, `This week` shows the activity with `0/5 this week`.

### E-2: Logging (FR-5, NFR-1)

1. Tap `Done today`, `Okay`, `Save` -> `1/5`. Submit the same request twice (simulate retry) -> still one row.
2. `done_on` tomorrow -> 400; 20 days ago -> 400.
3. Provider adherence panel shows `done 1 of 5 times in the last 7 days` and the note.

### E-3: Snapshot semantics (FR-3, NFR-2)

Provider adds a second activity without publishing: guardian does not see it; logging against it -> 404.
Publish -> visible.

### E-4: Authz negatives

`guardian_b` logs against `guardian_a`'s activity -> 404. `provider_b` reads the program -> 404 (with a
`home_program` grant -> read-only). Guardian deletes another guardian's log -> 404.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
