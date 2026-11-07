# 010: Intake completion and pre-session brief - Results

Branch: `ticket/010-intake-webhook-brief` (base `int/a-voice`, includes 001, 002, 004, 005, 009). Tested against
the shared Supabase cloud project (no local Docker stack), dev server on port 3002 with `DEMO_MODE=true
ELEVENLABS_WEBHOOK_SECRET=test-secret` and a per-run fixture copy in `.tmp/ct-fx-3002`, headless Chrome
(playwright-core installed outside the repo). Every test case was an `a010` case and was deleted afterwards
(no Storage objects were created). No migration was needed: the transaction uses the existing `postgres`
client on `DATABASE_URL` (as `lib/facts.ts` does) and the existing `recordings.external_id` unique constraint.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` | PASS | 246 tests passed, 10 DB tests skipped (see below); lint, typecheck, build OK. The one build warning (`lib/demo.ts` dynamic fs access) predates this ticket - `evidence/verify.txt` |
| `npx vitest run tests/intake.test.ts tests/intake-completion.test.ts --reporter=verbose` | PASS | 78 passed + 10 skipped without a database; with `CT_DB_TESTS=1` all 88 pass against isolated `a010` cases - `evidence/vitest-intake.txt`, `evidence/vitest-intake-db.txt` |
| E-1 signed webhook and persistence | PASS | 200; 1 intake recording (21 segments, duration from metadata), 15 `CASE_SHEET` facts (`parent_call`, `suggested`), 1 draft brief, case `intake_done`, `intake.received` (actor `parent`); `content_md` has the FR-4 headings and `Parent-reported` (DB test + curl against :3002) - `evidence/http-checks.txt` |
| E-1 bad signatures | PASS | missing, bad hex, old (31 min), future (+10 min), malformed, wrong scheme, wrong secret, tampered body, no secret configured -> 401 `Invalid signature`, zero rows written |
| E-1 ignored events | PASS | `post_call_audio` -> 200 `{ received: true, ignored: "post_call_audio" }`; unknown token -> 200 `ignored: "unknown token"` + `intake.unknown_token` audit with `case_id` null |
| E-1 duplicate delivery | PASS | 200 `{ received: true, duplicate: true }`, counts unchanged |
| E-1 rollback on fact insert failure | PASS | a real Postgres error (NUL character rejected by jsonb) in the fact insert -> 500; no recording, no facts, case stays `booked`, no receipt audit; re-delivering fixed data then succeeds (DB test) |
| E-1 brief failure | PASS | Gemini failure (mocked in DB test; renamed brief fixture in the browser run) -> 200 `brief: false`, recording + 15 facts kept, `intake.brief_failed` audited, no report |
| E-2 completion endpoint | PASS | mocked provider: `initiated`/`in-progress`/`processing` -> 202 `{ status: "processing" }` with no writes; `done` -> 200 and the same rows as the webhook; agent/token/conversation-id mismatch -> 403 with no writes; `failed`, unknown status, missing status, malformed transcript, provider HTTP error/non-JSON -> explicit 502 without saving; invalid body -> 400; unknown token -> 404; demo mode uses the fixture, no provider call |
| E-2 concurrent delivery | PASS | webhook + completion for the same conversation in parallel -> both 200 (one result, one `duplicate`), 1 recording, 15 facts, 1 receipt audit; 5 parallel deliveries -> 1 result + 4 duplicates, no duplicate facts (DB tests) |
| E-3 client completion lifecycle | PASS | fake timers: conversation id posted; 202 -> retry every 3 s, no overlap (slow request delays the next poll, `start()` ignored while busy); success -> thank-you text; 120 s timeout and 502/500/403/ignored/network errors -> actionable `Try again` text, never the thank-you; retry completes without a new call; cancel (unmount) clears timers and ignores in-flight answers. Component wiring: id from `onConnect` is posted after `onDisconnect` (SSR render with mocked SDK) |
| E-4 demo and therapist review | PASS | browser at 375 px: consent, Start, `Simulate completed call (demo)` in `#demo-actions` -> thank-you, no mic request, no external requests, case `intake_done` with 15 facts + brief. Brief tab: `h2` Pre-session brief, `Parent-reported` badge, summary, 2 red flags in red (`Lost speech: "..." at 00:57`), 5 numbered questions, 10-row table; `Mark brief reviewed` -> `Reviewed by a010 Dr Demo` (persists on reload, report `final`, `brief.reviewed` audit). Failed brief -> failure message; no intake -> empty section; review without brief -> 404; simulate with `DEMO_MODE=false` -> 404 `Not found` - `evidence/browser-checks.txt`, `evidence/*.png`, `evidence/simulate-non-demo.txt` |
| E-5 processor and document | PASS | unit tests: segment ids (`t9` skipped, ids keep the index), speakers, end times, whitespace/missing messages; 15 known fields, unknown keys ignored, null values; red flags with unknown `turn_id` dropped (also verified on saved content); Markdown headings, `- None reported`, escaped cells. `prompts/brief.md` contains the section 10 rule sentence, parent-reported labelling, 3-6 questions, `turn_id` citation and verbatim quotes |
| E-5 no provider key in client/responses | PASS | `check-env-usage` -> `server only` for `ELEVENLABS_API_KEY` and `ELEVENLABS_WEBHOOK_SECRET`; `check-client-imports` clean; 0 hits in `.next/static`; responses checked for the key in route tests and curl run - `evidence/key-checks.txt` |
| NFR-1 webhook < 10 s in demo mode | PASS | 749 ms end to end against the cloud DB |

## Deviations and decisions

- **DB integration tests are opt-in** (`CT_DB_TESTS=1`): they write `a010` cases to whatever `DATABASE_URL`
  points at (here the shared cloud project), so `npm run verify` skips them. They load `.env.local` and clean
  up their cases and `case_id`-null audit rows.
- **Files outside "Affected areas"**: `lib/queries/intake.ts` (added `getIntakeBrief`, `markBriefReviewed`) and
  `lib/elevenlabs/agent.ts` (added `getConversation` + `ProviderError`) - both 009 files the lead listed to
  extend; nothing in "Don't touch" changed. `tests/intake-call.test.ts` is unchanged and still passes.
- **Future timestamps** allow 60 s of clock skew (`FUTURE_SKEW_SEC`); anything further ahead is rejected.
- **Completion endpoint token check**: the agent ID is always verified; the `intake_token` is required for a
  `done` call and checked whenever it is reported, so a pending call whose token is not reported yet still
  gets 202.
- **Prompt field list**: the collected fields are sent as `<label>: <value>` lines exactly; a separate
  `label = field_id` list follows so the model can fill `parent_reported.field_id`.
- **Error codes**: webhook with invalid JSON/data -> 400, save failure -> 500; completion with done-but-invalid
  data -> 502, save failure -> 500.
- **Live UI wording**: while the completion request runs the page shows `Saving your answers… Please keep this
  page open.`; the thank-you message appears only after a successful completion.

## Bugs found during the run

- None in the product code. One browser-check assertion was wrong (Chrome reports the red colour as `lab(...)`,
  not `rgb(...)`) and was corrected in the check script.

## Not verified

- A live call with real ElevenLabs credentials (provider GET, `onConnect` conversation id, real disconnect
  timing) and a real signed webhook from ElevenLabs. The provider is mocked in automated tests, as eval.md
  requires; this smoke test needs the configured agent after merge.
- The `End call`/disconnect -> completion -> `Try again` flow was not click-tested in a browser (no live
  session in demo mode); it is covered by the poller and wiring tests.
