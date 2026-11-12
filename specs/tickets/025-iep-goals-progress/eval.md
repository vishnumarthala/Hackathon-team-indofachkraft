# 025: IEP plans, SMART goals and progress - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate` (024 merged first).
- Accounts: `npm run -s seed:users -- --prefix <acct> --extra-member`; child of `guardian_a` with an
  org A case where `provider_a` and `provider_a2` are assigned; an org B case for the same child.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/iep.test.ts tests/iep-access.test.ts --reporter=verbose` exits 0, covering FR-2
  validation per measure type, `goalTrend` (0/1/2+ points, decreasing targets), markdown rendering,
  single active plan per case, guardian responses containing no draft text, version conflicts.

## Acceptance checks

### E-1: Create, publish, view (FR-3, FR-4, FR-5, FR-6)

1. As `provider_a`, create plan `<acct> Term 1`, add goal: domain `Communication`, statement
   `Asha will request 5 preferred items using 2-word phrases`, all SMART fields, `count`, baseline 1,
   target 5, target date in 3 months. Missing `Measurable` -> validation error.
2. `Publish to parent`. As `guardian_a`, `/family/children/<id>/plan` shows the plan text.
3. As `provider_a`, edit the goal statement (do not republish): badge `Unpublished changes`; guardian
   still sees the old text. Republish -> guardian sees new text; `published_versions` has versions 1 and 2.

### E-2: Progress (FR-3, FR-7, NFR-2)

Record values 1, 2, 3 on three dates: provider and guardian charts show 3 points with baseline/target
lines; text `on track` shown; `Show data` table lists the values. Future date -> 400.

### E-3: Concurrent edit (FR-3)

`provider_a` and `provider_a2` edit the same plan from the same `version`; second save -> 409 message.

### E-4: Authz negatives

1. `provider_b` (org B) reads org A's plan API -> 404; with an `iep` grant from `guardian_a` -> read-only
   under `Shared with us`; `PATCH` -> 403/404.
2. `guardian_b` -> 404 on the plan page/API. Unassigned member -> 404.
3. Guardian calls provider plan APIs -> 403.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
