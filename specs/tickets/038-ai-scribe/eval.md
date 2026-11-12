# 038: AI scribe - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Data: org A case for a consented child (all 020 features granted) with an active IEP plan (025) of 2
  goals; providers: an SLP (`provider_a`) and a verified paediatrician (`provider_rx`, 028).
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-<port> npm run dev -- -p <port>`. Synthetic
  role-play audio fixtures only (`npm run fixtures:scribe`).

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/scribe.test.ts tests/regression-child-dev.test.ts --reporter=verbose` exits 0:
  template routing by provider type; Zod validation of each fixture; citations point to existing
  segments; idempotent re-run keeps finalized notes; Rx draft only for prescribers; consent withdrawal
  between transcription and scribe aborts with `consent_withdrawn`; ISAA regression unchanged.

## Acceptance checks

### E-1: Therapy note + goal progress (FR-2, FR-4, FR-5)

As `provider_a`, upload a synthetic in-clinic session with `Session type` `Therapy session note`,
transcribe, run scribe: draft note with citations; 2 goal suggestions with quotes. Accept one -> a
`goal_progress` row `ai_suggested_confirmed`; guardian chart shows it. Reject the other -> no progress row.

### E-2: Medical consult with Rx draft (FR-4)

As `provider_rx`, same flow with `Medical consult note` -> `rx_draft` report exists and links to 039.
As `provider_a` (non-prescriber) the same audio produces no `rx_draft`.

### E-3: Guards (FR-3, NFR-1)

Upload for a video appointment -> 422 message. Without `ai_extraction` consent -> 422 before Gemini is
called. Guardian sees nothing until the note is finalized with `visible_to_guardian`.

### E-4: Authz negatives

`provider_b` (other org) calls `/api/sessions/:id/scribe` -> 404; accepting a goal suggestion for
another org's case -> 404.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
