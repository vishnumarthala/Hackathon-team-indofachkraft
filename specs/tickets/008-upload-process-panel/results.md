# 008: Upload and process panel, speaker swap - Results

Branch: ticket/008-upload-process-panel (based on int/c-frontend 017b3c1, then `origin/main` 6940370 merged in so 006 is present)
Worktree: C:\Users\wicon_user\Desktop\Hackathon-team-indofachkraft\.claude\worktrees\agent-a3c42b6f0b7ade2b3
Port: 3011 (3001 was already held by a dev server from the main checkout, which I did not touch)
Run prefix: t3001-140439. Fixtures: `.tmp/ct-fx-3001` (fresh copy after the 006 merge).

## Checks
| Check | Result | Evidence |
|-------|--------|----------|
| lint | PASS | `npm run lint` exit 0 - evidence/gates-final.log, lint.log |
| typecheck | PASS | `npm run typecheck` exit 0 - evidence/gates-final.log |
| test | PASS except 1 known failure | 193 passed, 12 skipped (DB-gated), 1 failed: `tests/fixtures.test.ts` Scribe determinism (CRLF vs LF on Windows, ticket 002, pre-existing, not touched) - evidence/gates-final.log, test.log |
| build | PASS | `npm run build` exit 0 (run after the last code change) - evidence/gates-final.log |
| E-1 | PASS | evidence/E-1.png. Button disabled before file+consent; 40 `[data-item]`; `recording.consent` count 1. Warm run 4.4 s to 8 s click-to-review. A cold first run in dev mode took > 27 s (evidence/E-1-cold.png): Turbopack compiles routes on first hit (POST sessions 9.2 s, transcribe 12 s). Not reproducible once warm; see notes. |
| E-2 | PASS | evidence/E-2.png. `upload:waiting,transcribe:waiting,extract:waiting` |
| E-3 | PASS | evidence/E-3.png, E-3-before.log, E-3-after.log, E-3-step4.log, E-3-step5.log. speaker_map exchanged, `extraction.completed` runs +1, `recording.speakers_swapped` 1, `therapist_voice` facts 0, 40 items on the reloaded page, transcript labels swapped |
| E-3 (failed re-extraction) | PASS | evidence/E-3-cleared-after-reload.png, E-3-retry-success.png. With `gemini/extract.json` removed: Swap speakers -> page shows the error `Extraction failed`, `Retry`, no ratings; after a page reload it still shows Retry and no ratings (state is derived on the server); after restoring the fixture, Retry loads 40 items |
| E-4 | PASS | evidence/E-4.log. confirm 200, then 409 `Speakers can't be swapped after items are confirmed`; edited voice-note item -> same 409; unknown id -> `{"error":"Session not found"}` 404; `{}` and `{"swap":false}` -> 400 |
| E-5 | PASS | evidence/E-5.png, E-5-large.png, E-5-type.png. `File too large (max 50 MB)`, `Unsupported audio type`, recording count unchanged |
| E-6 | PASS | evidence/E-6a.png, E-6b.png, E-6-transcribe-failed.png, E-6-extract-failed.png, E-6-final.png. `upload:done,transcribe:failed,extract:waiting` with `Transcription failed` + Retry; then `upload:done,transcribe:done,extract:failed` with `Extraction failed`; final Retry lands on the review page with 40 items; `status='created'` recordings 0 |
| E-7 | PASS | evidence/E-7.log: `clean` |
| E-3 automated coverage | PASS | `tests/speakers.test.ts` (pure rules + fake-transaction: lock order, every column cleared, 409s write nothing), `tests/swap-flow.test.ts` (failed re-extraction -> cleared + error + retry, retry only re-runs extraction, 409 changes nothing, lost response reloads), `tests/upload-flow.test.ts`, and `tests/speakers.db.test.ts` (real Postgres, 7 tests: full invalidation, swap waits for a committing manual decision / extraction claim and then 409s, swap racing real `updateFact` and `bulkUpdate` ends in a serial order, `needsReextraction`). evidence/speakers-db-tests.log |

## Attempts
- Attempt 1 (before 006 was merged): built everything; API checks passed, extract-dependent checks could not run.
- Coordinator announced 006 merged: merged `origin/main` into the branch, reran everything incl. E-1, E-3, E-6 in full - all pass.
- Reviewer round: 3 MAJOR findings fixed. (1) the cleared/Retry state was lost on reload and the button could swap back: `needsReextraction()` (latest `recording.speakers_swapped` audit newer than latest `extraction.completed`) is computed in the review page and passed to `ReviewScreen`; (2) a lost swap response put stale ratings back on screen: now only 404/409 keep the page, anything else reloads; (3) missing automated coverage: added `swap-flow` and DB integration tests. Also fixed: transcript labels now swap client-side right after the swap succeeds; the `db()` client is shared with `lib/facts.ts` instead of duplicated.

## Changes
- `app/cases/[id]/sessions/new/page.tsx` - New session page (case 404 via `getCase`).
- `components/session/UploadPanel.tsx`, `components/session/uploadFlow.ts` - form, three-step list, resumable flow (create session / upload / transcribe / extract, retry from the failed step, one recording per attempt), client validation.
- `lib/supabase-browser.ts` - browser client (public URL + anon/publishable key only).
- `app/api/sessions/[id]/speakers/route.ts`, `lib/speakers.ts`, `lib/speaker-swap.ts` - PATCH swap, one transaction that locks the recording row first (same order as `updateFact`, `bulkUpdate`, extraction claim), 409 rules, full invalidation, audit `recording.speakers_swapped`; pure rules in `lib/speaker-swap.ts` (shared with the browser). `needsReextraction` helper.
- `components/session/SwapSpeakersButton.tsx`, `components/session/swapFlow.ts` - the button, swap -> extract -> reload state machine.
- `components/session/ReviewScreen.tsx`, `components/session/AudioTranscript.tsx`, `app/cases/[id]/sessions/[recordingId]/page.tsx` - button in the transcript header; while a swap/re-extraction is running or has failed, the score, red-flag banner and form are replaced by a notice (no stale ratings); the page passes `needsReextraction`.
- `lib/facts.ts` - one word: `db()` is now exported so `lib/speakers.ts` reuses the same Postgres client (not in "Don't touch").
- `tests/speakers.test.ts`, `tests/swap-flow.test.ts`, `tests/upload-flow.test.ts`, `tests/speakers.db.test.ts` - new.
- No migration was added (the transaction runs from the route), so nobody needs to run `npm run db:push` for this ticket.

## Notes for the router
- Port: 3001 is occupied by a foreign dev server (main checkout), so all runs used 3011. Nothing else was killed.
- `tests/speakers.db.test.ts` is skipped in plain `npm test`, like `tests/extraction.db.test.ts`: vitest sets `NODE_ENV=test`, which stops `@next/env` loading `.env.local`. Run it with `NODE_ENV=development npx vitest run tests/speakers.db.test.ts` (7 passed).
- NFR-1 (< 15 s): met on a warm dev server (4-8 s). A cold dev server compiling routes on first use took > 27 s once; a production build does not have this compile cost.
- `lib/supabase-browser.ts` also reads `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as an alias of the anon key (same convention as `lib/env.ts`; the team's `.env.local` only defines the publishable name). Both are public keys.
- Known limit: if "create session" succeeds on the server but its response is lost in the browser, a retry creates a second recording and leaves the first in status `created` (no delete API exists; the eval's E-6 scenario does not trigger it).
- While swap/re-extraction is in the `cleared` state the therapist cannot rate items manually until extraction succeeds (Retry); this follows "never display invalidated ratings as current".
- Testing deviations: `agent-browser eval` is blocked in the tester sandbox, so `get attr data-state` / `get count` were used for the same data; `agent-browser upload` needed absolute paths (a relative path produced a 0-byte file and wedged the tab; not an app issue).
- Don't-touch check: no change to `app/api/facts/**`, `app/api/sessions/[id]/bulk/**`, `app/api/cases/[id]/sessions/**`, `lib/transcript.ts`, `lib/extraction.ts`, `lib/scoring.ts`, transcribe/extract route behaviour (the `lib/extraction.ts` and `refer` route diffs against 017b3c1 come from the merged 006/012, not this ticket).
- `package-lock.json` / `package.json` not committed (npm install noise reverted).
