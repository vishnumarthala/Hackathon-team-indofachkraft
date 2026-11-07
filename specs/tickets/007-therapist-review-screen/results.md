# 007: Therapist review screen - Results

Branch: `ticket/007-therapist-review-screen` (from `int/c-frontend`, `origin/main` with 002 merged in),
merged into `int/c-frontend`. Port 3001, `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/ct-fx-3001`.
**Database:** shared Supabase cloud project. Seeded case `18999d96-de33-4b6e-bcc4-dff369c4dc66`,
session `a8c056c4-d9dc-438c-a10f-a11e0789ecdd` (`npm run -s seed:demo -- --new`).

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npm test` | PASS (007) | 119 tests; 118 pass. The one failure is 002's `tests/fixtures.test.ts` Scribe determinism test, Windows-only: git checks the JSON out with CRLF, the generator writes LF. Passes on Linux CI. Not touched by 007. |
| `npm run build` (`node scripts/dev/build-without-env.mjs`) | PASS | exit 0, `.env.local` restored |
| E-1 page, 40 items, transcript, score | PASS | `evidence/E-1.png`, `evidence/E-1-body.txt`: 0.77 s warm, 40 `[data-item]`, 36 `seg-s*` = 36 fixture segments, no audio -> 0 `<audio>` + "No audio uploaded..." text; all 13 required strings present |
| E-2 evidence button highlights segment | PASS | `evidence/E-2.png`: first `▶` -> exactly 1 `[data-active=true]` (`seg-s4`) |
| E-3 confirm and edit one item | PASS | `evidence/E-3.txt`, `evidence/E-3.png`: item 1 (4) confirmed, item 3 (3 -> 1) edited, both `Demo Therapist`; body shows `(provisional - 4 of 40 confirmed`; audits `fact.confirmed` suggested->confirmed, `fact.edited` suggested->edited |
| E-4 bulk actions reach a final score | PASS | `evidence/E-4.txt`, `evidence/E-4.png`: `ISAA total: 81 · Mild (70-106)`, no `provisional`; `[{"n":40}]`; `[{"n":2}]` |
| E-5 API errors | PASS | `evidence/E-5.txt`: 404 Fact not found, 422 Rate this item before confirming, 422 Only ISAA items can be rated here, 400, 404 Session not found |
| E-6 wrong case / unprocessed session | PASS | `evidence/E-6.txt`, `evidence/E-6.png`: 404; `This session is transcribed. Process it from the New session page.`; link `true` |
| E-7 status rule tests and wording | PASS | `evidence/E-7.txt`: 13 tests (confirm, edit, same-value edit, null confirm, both bulk actions); `clean` |
| `check-client-imports.mjs` | PASS | `clean` |

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
- Badge: `Voice note` while `source` is `therapist_voice` (voice notes are stored `confirmed`); if the
  therapist later edits such an item the badge shows `Edited`.
- Confirm dialog is an in-page `alertdialog` (no `window.confirm`), so `Yes` / `Cancel` are normal buttons.
- After a bulk action the page calls `router.refresh()` and adopts the fresh facts from the server.
- Bulk buttons are disabled when their count is 0.
- The seeded session has no audio file (`demo/audio/session-1.mp3` is not committed yet), so E-1 ran the
  transcript-only branch; the audio branch renders a standard `<audio controls>` with the signed URL.
- Test rows created in the shared database: three `--new` cases (E-1..E-5, E-6 C3) and one
  `--new --stage transcribed` case (E-6 C4), all with the seed's synthetic aliases.
