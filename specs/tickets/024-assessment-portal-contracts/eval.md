# 024: Assessment portal and shared clinical contracts - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`.
- **Before** migrating, capture the regression baseline: run the existing pipeline on a fresh seed
  (`npm run -s seed:demo -- --new`) and save facts, score, brief markdown, report markdown and referral
  packet to `.tmp/baseline-<port>/` with `npm run -s db:sql`. Then `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; child of `guardian_a` claimed into an org A case.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-<port> npm run dev -- -p <port>`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0 (all pre-existing tests unchanged and passing).
- `npx vitest run tests/clinical-contracts.test.ts tests/assessments.test.ts tests/regression-child-dev.test.ts --reporter=verbose` exits 0:
  - registry loads ISAA/CASE_SHEET/ISAA_PARENT_CHECKIN; `facts` insert with an unknown instrument fails (FK);
  - `published_versions` update/delete raise; hash = sha256(content_md);
  - speaker swap leaves `child`/`other_adult` untouched and still swaps therapist<->parent;
  - parent check-in scoring and red-flag detection on synthetic answer sets for each band;
  - regression (DEMO fixtures): intake simulate -> brief; transcribe; speaker swap; extract; ISAA score
    and band; report draft + finalise; referral packet; parent voice note - outputs equal the
    `.tmp/baseline-<port>/` files (timestamps/ids normalised).

## Acceptance checks

### E-1: Report finalisation publishes (FR-3)

1. Finalise the seeded case's assessment report. `published_versions` has one row (`entity_type =
   'report'`, `version = 1`, `content_md` equals `reports.content_md`, `visible_to_guardian = false`).
2. `PATCH` the report again -> 409 `Report is final` (unchanged); no second published row.
3. Backfill: every pre-existing final report has exactly one published version.

### E-2: Assign and fill a questionnaire (FR-8, FR-9)

1. As `provider_a`, `Send questionnaire` `Parent developmental check-in` to `guardian_a`, due in 7 days.
2. As `guardian_a`, answer 5 questions, `Save and continue later`, reload: answers kept. Submit with
   missing answers -> 422 listing them. Answer all, submit -> status `submitted`.
3. As `provider_a`, open it: score/band shown with `This is a developmental check-in, not a diagnosis.`;
   `Mark reviewed`, tick `Share result with parent` -> guardian sees the published summary.

### E-3: Red flag (FR-9)

Answer the `skill_regression` red-flag question `yes`: the 108/112 message shows immediately; outbox
event `assessment.red_flag` exists (or is skipped with a note if 032 is not merged); provider sees the highlight.

### E-4: Concurrency and authz negatives (NFR-2)

1. Two tabs save responses with the same `version` -> second gets 409.
2. `guardian_b` reads/writes `guardian_a`'s assessment -> 404. `provider_b` (other org) -> 404.
3. Assigning to `guardian_b` (not linked) -> 422. Submitting twice -> 409.

### E-5: Docs (FR-6)

`docs/system-design.md` "Clinical contracts" section names each module and the authoritative-content rule.

## Definition of done

- [ ] All checks pass with evidence in `results.md`, including the regression diff (empty).
- [ ] A builder reviews results and manually merges the passing ticket branch.
