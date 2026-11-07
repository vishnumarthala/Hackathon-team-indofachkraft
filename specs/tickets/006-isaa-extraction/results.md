# 006: ISAA extraction with Gemini - Results

**Branch:** `ticket/006-isaa-extraction` (base `int/b-backend`)
**Database:** shared Supabase cloud project (no local Docker), schema already applied. No migration added.
**Server:** `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-3001 npm run dev -- -p 3001` (port 3001, fixture copy in `.tmp/fx-3001`).

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | `evidence/gates.txt` (exit 0) |
| `npm run typecheck` | PASS | `evidence/gates.txt` (exit 0) |
| `npm test` | PASS | `evidence/gates.txt` (12 files, 131 tests, DB integration tests included) |
| `npm run build` | PASS | `evidence/gates.txt` (exit 0, route `ƒ /api/sessions/[id]/extract`) |
| Integration: rollback after upsert failure + concurrent extraction/therapist decisions | PASS | `evidence/db-integration.txt`: `tests/extraction.db.test.ts`, 5 tests (upsert check-constraint failure rolls back a re-extraction; failure after upsert leaves 0 facts, `transcribed`, case `booked`; decision made while the model runs is kept; therapist update racing the commit waits for the lock and wins; second concurrent extraction gets 409) |
| E-1 40 items, verified evidence, < 5 s | PASS | `evidence/e1-e2.txt`: `200 0.582245`; `40 true true 0 lost_speech,self_injury 2 true`; `[{"status":"extracted","case_status":"in_assessment","n":40}]`; step 5 `[]` |
| E-2 Voice notes override items | PASS | `evidence/e1-e2.txt`: items 5 and 24 `value 4, therapist_voice, confirmed, "Demo Therapist (voice note)"` |
| E-3 Post-processing and note parsing | PASS | `evidence/e3.txt`: 20 verbose Vitest tests pass (unknown segment, wrong quote, duplicate, missing items, digits/words, merge with Gemini notes); step 2 `[[24,3,"s3"]]` |
| E-4 Re-extraction keeps therapist decisions and first AI value | PASS | `evidence/e4-e5.txt`: `200`; item 1 `value 1, edited`; item 2 `ai_value 2` kept |
| E-5 Wrong state, running, unknown id | PASS | `evidence/e4-e5.txt`: `{"error":"Transcribe the session first"} 409`, `{"error":"Extraction already running"} 409`, `{"error":"Session not found"} 404` (also 404 for an intake recording id and a non-uuid) |
| E-6 Gemini failure leaves data untouched | PASS | `evidence/e6.txt`: `{"error":"Extraction failed","details":"Missing fixture gemini/extract.json"} 502`; `[{"status":"extracted","has_error":true,"n":40,"item5":"confirmed"}]`; audit `extraction.failed`; a re-run after restoring the fixture returns 200 and clears `error` |
| Server-only env (`check-env-usage.mjs DATABASE_URL lib scripts tests`) | PASS | prints `server only` |
| Client imports (`check-client-imports.mjs`) | PASS | prints `clean` |

## Deviations

- Cloud instead of local Supabase: eval paths `.tmp/ct-fx-<port>` became `.tmp/fx-3001`; every DB step ran
  against the shared cloud project with `npm run -s db:sql`. E-1/E-2 evidence comes from a second fresh
  `seed:demo -- --new --stage transcribed` case (re-run after a rationale tweak); E-4/E-5 used the first one.
- The route was compiled once with a 404 request before E-1 so the `< 5 s` timing measures the endpoint,
  not the first dev compile.
- Extra file `tests/extraction.db.test.ts` (eval.md asks for automated integration checks). It runs
  against `DATABASE_URL` (loaded by `@next/env`), creates its own synthetic cases (`t006-db-*`) and deletes
  only those; it is skipped when `DATABASE_URL` is unset or `SKIP_DB_TESTS=1`.
- Transactions use the `postgres` package with `DATABASE_URL` inside `lib/extraction.ts` (supabase-js has
  no transactions); no migration was needed. The connection is a lazily created module singleton
  (`max 3`, `prepare: false` for the pooler).
- `runExtraction` takes optional test dependencies (`sql`, `generate`, `now`, `hooks.beforeUpsert/afterUpsert`);
  the route always calls it with defaults.
- Voice-note rows for items Gemini left unrated get the rationale `Rated by the therapist in a voice note.`
  (FR-5 does not specify it); rated items keep Gemini's rationale and confidence.
- Items Gemini rated with an unknown segment or no quote get rationale `No direct evidence in this session.`
- An extra audit `extraction.failed` (`details: { error }`) is written on failure (best effort).
- If restoring the status after a failure itself fails, the route logs it and answers 500
  `{ error: "Extraction failed", details: "<message>; the failure could not be recorded: ..." }`.
- `node scripts/dev/check-copy.mjs prompts/extract.md` flags the line "You document; you never diagnose."
  This sentence is required verbatim by `docs/system-design.md` section 10 for every prompt; it is model
  instruction, not UI copy.
- `npm run build` prints a pre-existing Turbopack warning about `lib/demo.ts` (dynamic fixture path); not changed.

## Facts for other tickets (007, 008, 012)

- `POST /api/sessions/:id/extract` (no body). 200:
  `{ recording_id, facts: FactRow[40] (ordered by item number, confidence a number, confirmed_at/created_at ISO strings), red_flags: { type, segment_id, quote, note }[], therapist_notes_applied: number }`.
- Errors: 404 `{ error: "Session not found" }` (unknown/non-uuid id or `kind` not `session`); 409
  `{ error: "Transcribe the session first" }`; 409 `{ error: "Extraction already running" }`; 502
  `{ error: "Extraction failed", details }`; 500 `{ error: "Could not start extraction" }` if the DB is unreachable.
- Recording status: `transcribed|extracted` -> `extracting` -> `extracted` (error null) or back to the previous
  status with `error` set. `recordings.red_flags` = the kept red flags. Case `booked|intake_done` -> `in_assessment`.
- Audit: `extraction.completed` (actor `ai`, entity `recording`, `details { rated, verified, notes }`) and
  `extraction.failed` (`details { error }`).
- Re-extraction only rewrites `suggested` rows; `ai_value` keeps the first non-null AI value; confirmed/edited
  rows are never touched. 008's speaker swap must reset `ai_value` itself if it wants a fresh first suggestion.
- Voice notes: `source therapist_voice`, `status confirmed`, `confirmed_by "<therapist_name> (voice note)"`,
  evidence = the note segment (quote = note text, `verified: true`).
- Exported helpers in `lib/extraction.ts`: `postProcess`, `parseVoiceNotes`, `mergeVoiceNotes`,
  `computeFactWrites`, `normalizeText`, `buildExtractPrompt`, `runExtraction`.
- Route exports `runtime = "nodejs"`, `maxDuration = 300`, `dynamic = "force-dynamic"`.
