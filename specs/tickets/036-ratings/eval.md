# 036: Ratings - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Data: 030 setup; three `completed` appointments of `guardian_a` and one of `guardian_b` with
  `provider_a` (mark completed via SQL time-travel + `booking_complete`); one `confirmed` (not completed).
- Start: `DEMO_MODE=true npm run dev -- -p <port>` and `npm run -s outbox:run`. Synthetic comments only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/ratings.test.ts --reporter=verbose` exits 0: eligibility matrix (status,
  owner, 30-day window, 7-day edit), comment screening (phone, email, URL, child name, abuse list),
  summary view excludes hidden/pending, threshold display logic.

## Acceptance checks

### E-1: Rate and display (FR-2, FR-3, FR-5)

1. Rate-prompt notification arrives after completion. `guardian_a` rates 5, 4, 5; `guardian_b` rates 4.
2. `/p/<slug>` shows `4.5 ★ (4 ratings)` and comments with `Verified booking`, no names.
3. With only 2 ratings (fresh provider) -> `New on DoctorNearMe`.

### E-2: Negatives (FR-3, FR-4)

Rate the non-completed appointment -> 403; rate twice -> 409; `guardian_b` rates `guardian_a`'s
appointment -> 403; comment with `9876543210` or the child's name -> 422.

### E-3: Moderation (FR-6)

Provider reports a rating -> hidden from the profile (`pending_review`); admin publishes -> visible again.
Provider calling admin moderation API -> 403.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
