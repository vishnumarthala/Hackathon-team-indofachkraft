# 013: Ask the case - Results

**Branch:** `ticket/013-ask-the-case` (base `int/b-backend` at `ae7fb70`)
**Database:** shared Supabase cloud project (no local Docker), schema already applied; no migration added.
Dev server: `DEMO_MODE=true NEXT_PUBLIC_APP_URL=http://localhost:3002 npm run dev -- -p 3002`, env loaded
through the main checkout's `.tmp/with-env.mjs` wrapper. Case C = `e9726c3a-d36f-40d9-8571-ff9403f977d5`
(`seed:demo -- --new --confirmed`) with referrals K = `JA0p8hMv…` (E-1 step 5, E-3) and a fresh
K3 = `I0PLHNJh…` (E-1 re-run with audio). The canonical case was not touched.

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | `evidence/gates.log` (exit 0) |
| `npm run typecheck` | PASS | `evidence/gates.log` (exit 0) |
| `npm test` | PASS | `evidence/gates.log`: `npm test` 16 files passed, 1 skipped (DB tests skip without env), exit 0; with the env wrapper all DB tests run: `npx vitest run --exclude tests/env.test.ts` 16 files, 199 tests, exit 0 (see deviation about `tests/env.test.ts`) |
| `npm run build` | PASS | `evidence/gates.log` (exit 0; `ƒ /api/cases/[id]/ask`, `ƒ /specialist/[token]`) |
| Extended `tests/ask.test.ts` (truncation, missing audio, concurrency at 50, release on Gemini failure) | PASS | `evidence/E-2-E-4-vitest.log`: citations removed by the context cut are dropped; `isPlayable` is false without audio and after the signed URL expiry; 8 concurrent requests at 47 stored -> exactly `[200,200,200,429,429,429,429,429]` and 50 rows; at 49 stored, a slow failing generation holds the last slot (concurrent request gets 429), the 502 releases it, the next question gets 200, then 429 |
| E-1 Ask from the specialist page | PASS | `evidence/E-1.png`, `evidence/E-1.log`, `evidence/E-1-db.json`: suggestion fills `When did speech regress?`; button showed `Asking…`; answer in 868 ms (< 5 s); body contains `Ask the case`, the fixture answer and chip `Session 1 · 01:00`; DB `[{"question":"When did speech regress?","found":true,"n":1,"label":"Session 1 · 01:00"}]`; with audio attached the chip click loads the signed URL into the page's `<audio>` for the session recording (without audio the chip is disabled); `?` shows the API error `Invalid request: Question must be at least 3 characters`; after reload the earlier question and answer are listed |
| E-2 Citation rules | PASS | `evidence/E-2-E-4-vitest.log`: 30 tests incl. valid fact id, unknown fact id dropped, `1:s<k>` and `intake:t<k>` labels, found-without-citations fallback, context cut order; `grep -c "Not documented in this case." prompts/ask.md` -> `1` (`evidence/gates.log`) |
| E-3 Access, validation and limit | PASS | `evidence/E-3.log`: step 1 `{"error":"Not found"} 404`; step 2 `400` with `details.question`; step 3 (node loop instead of the bash loop) 49×200 + 1×429 (K already had the E-1 question), then `{"error":"Question limit reached for this referral"} 429`, 50 rows, 0 pending; step 4 after `status='revoked'` `{"error":"Not found"} 404` |
| E-4 Gemini failure | PASS | `evidence/E-2-E-4-vitest.log`: route test with `generateJson` throwing `GeminiError` -> 502 `{"error":"The question could not be answered"}`, question count and `case.question_asked` audit count unchanged |
| Copy rules (`scripts/dev/check-copy.mjs` on the changed files) | PASS | prints `clean` |
| Client imports (`scripts/dev/check-client-imports.mjs`) | PASS | prints `clean` (`evidence/gates.log`) |
| Don't touch | PASS | `git diff --name-only ae7fb70 HEAD`: only the new ask route, `lib/ask/*`, `prompts/ask.md`, `components/referral/AskTheCase.tsx`, `app/specialist/[token]/page.tsx`, `tests/ask.test.ts` and this ticket's specs/BOARD row |

## Deviations

- Cloud instead of local Supabase; no `.env.local` in the worktree (wrapper instead). `agent-browser` is
  not installed: the browser steps of E-1 ran with Playwright (same actions: click the suggestion and
  `Ask` by role/name, read body text, full-page screenshot). The E-3 bash loop ran as a `node -e` loop.
- `tests/env.test.ts > throws a clear message for a missing required var` fails only under the env
  wrapper (pre-existing, not touched here): the wrapper also sets the `SUPABASE_SECRET_KEY` alias, so
  stubbing `SUPABASE_SERVICE_ROLE_KEY` away does not throw. Plain `npm test` passes; all other suites
  including the DB tests pass with the wrapper.
- Atomic limit without a migration: `lib/ask/questions.ts` (extra file in `lib/ask/`, not listed in
  Affected areas) uses the `postgres` package. In one transaction it locks the referral row
  (`select … for update`, also re-checking `revoked`), counts `case_questions` and inserts a
  reservation row (`answer = ''`; stored answers are never empty). Generation runs outside the lock;
  success fills the row, a Gemini failure deletes it (release). Reservations are hidden from the page
  and reservations older than 5 minutes (crashed requests) are cleared on the next reservation.
- Validation order: non-JSON / missing `share_token` -> 400; then the token check (404) runs before the
  question rules (400), so callers without a valid link learn nothing else.
- `found: false` answers are always stored and returned as `Not documented in this case.` without
  citations (the model's text is not kept). Fact ids are also accepted with the `fact:` prefix shown in
  the prompt.
- Context details not fixed by the rd: ISAA quotes are included when the fact has evidence; only the
  latest intake call (by `created_at`) and the latest recording per session number are used (segment
  ids would collide otherwise); recordings without segments are skipped; within a group lines are cut
  from the end; brief, intake answers and ISAA facts are cut only after all transcript lines (never
  needed in practice). An ISAA fact without evidence resolves to its session at 0 s with label
  `Session <n> · ISAA item <k>`.
- Citation chips are always buttons named by their label; they are disabled when the recording has no
  audio or the page's signed URLs are older than 55 minutes (they expire after 1 hour), so an expired
  URL is never treated as playable.
- For the audio part of E-1, `demo/audio/sample-short.wav` (10 s) was attached to case C's session
  (own case only), so the chip at 01:00 seeks to the end of that short file.
