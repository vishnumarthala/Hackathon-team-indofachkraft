# 007: Therapist review screen - Results

Branch: `ticket/007-therapist-review-screen` (from `int/c-frontend` with `origin/main` merged). **Not merged yet.**

Code built before 002 (demo fixtures and seed) exists: the browser and DB checks need
`npm run seed:demo -- --new` and `demo/fixtures/roleplay-segments.json`, so they are PENDING.

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npm test` | PASS | 10 files, 91 tests (incl. 13 in `tests/facts.test.ts`) |
| `npm run build` (via `node scripts/dev/build-without-env.mjs`) | PASS | exit 0; `/api/facts/[id]`, `/api/sessions/[id]/bulk`, `/cases/[id]/sessions/[recordingId]` dynamic |
| E-7 step 1 `tests/facts.test.ts` | PASS | confirm, edit, same-value edit, null confirm, both bulk actions |
| E-7 step 2 `check-copy.mjs app/cases components/session` | PASS | `clean` |
| `check-client-imports.mjs` | PASS | `clean` |
| E-1 page, 40 items, transcript, score | PENDING 002 | needs seeded session |
| E-2 evidence button highlights segment | PENDING 002 | |
| E-3 confirm and edit one item | PENDING 002 | |
| E-4 bulk actions reach a final score | PENDING 002 | |
| E-5 API errors | PENDING 002 | needs seeded facts (null value, CASE_SHEET) |
| E-6 wrong case / unprocessed session | PENDING 002 | needs `--stage transcribed` |

## Changes

- `app/cases/[id]/sessions/[recordingId]/page.tsx` - server page; 404 for unknown/other-case/non-session
  recordings; non-`extracted` sessions show only the "Process it from the New session page" message.
- `components/session/ReviewScreen.tsx` - client state: facts, active segment, audio seek, red-flag banner,
  score/red flags/recommendation recomputed from current facts with `lib/scoring.ts`.
- `components/session/AudioTranscript.tsx`, `ScorePanel.tsx`, `IsaaForm.tsx`, `ItemRow.tsx`, `BulkActions.tsx`, `time.ts`.
- `app/api/facts/[id]/route.ts` (PATCH), `app/api/sessions/[id]/bulk/route.ts` (POST).
- `lib/facts.ts` - pure status rules (`applyFactAction`, `bulkTargets`, schemas) and DB helpers
  `updateFact` / `bulkUpdate`, each one `postgres` transaction: `select ... for update` on the recording
  (409 when `extracting`), fact update and `audit_events` insert together, score of all ISAA facts.
- `lib/queries/sessions.ts` - `getSessionReview(caseId, recordingId)` with a 1-hour signed audio URL.
- `tests/facts.test.ts`.

## Notes and decisions

- Fact and audit writes use `postgres` with `DATABASE_URL` (not supabase-js) so they share one
  transaction and the recording row lock; `prepare: false` so it also works through the Supabase pooler.
  The audit row is inserted inside the transaction instead of via `lib/audit.ts` (which cannot join it).
- Request body is validated before the id lookup: an unknown id with a valid body gives 404; an invalid
  body gives 400.
- Badge: `Voice note` while `source` is `therapist_voice` (006 stores voice notes as `confirmed`); if the
  therapist later edits such an item the badge shows `Edited`.
- Confirm dialog is an in-page `alertdialog` (no `window.confirm`), so `Yes` / `Cancel` are normal buttons.
- After a bulk action the page calls `router.refresh()` and adopts the fresh facts from the server.
- Bulk buttons are disabled when their count is 0.
