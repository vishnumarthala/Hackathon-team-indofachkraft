# 033: Voice developmental check-in (public screen) - Results

Branch: `ticket/033-voice-screen` (base includes 017-025, 028, 029, 032, 041). Tested against the isolated local
Supabase stack slot 7 (all 21 migrations applied by `dnm-db.sh 7 <worktree> reset`), `DEMO_MODE=true`, dev server on
port 3070, an isolated headless Chromium (`playwright-core` in the git-ignored `.tmp/`, own contexts and cookie jars,
not the shared browser). Accounts from `npm run -s seed:users -- --prefix e033`. Synthetic data only.

## Automated checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (slot 7 env) | PASS | 71 files, 1085 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the 041 live crawl); every DB suite ran |
| `npx vitest run tests/screen-flow.test.ts tests/screen-red-flags.test.ts --reporter=verbose` | PASS | 2 files, 55 passed: band computation for synthetic answer sets per age band (5 cases through the real routes and 024's scorer); every red-flag code (agent tool and form `yes`) stops the flow and `finish` has no band; session expiry (410 on answers, red flag, finish, resume); rate limit (5/hour, 6th 429, hashed key); `screen_sessions` has exactly the FR-5 columns and rejects free text (answers, conversation id, age band); save requires guardian link (404) and consent (422), anonymous 401, provider 403; strict audit fails closed |
| `NO_TRACKING_BASE_URL=http://localhost:3070 npx vitest run tests/no-tracking.test.ts` | PASS | 13 passed incl. the live crawl of every `/family/**` page (the child page now has `Check-ins`) |
| `npm run build` (no env loaded) | PASS | exit 0; `/screen`, `/api/screen/**`, `/api/family/screen-results` in the route list |

## Acceptance checks

Full log: `evidence/acceptance.txt` (40 PASS, 0 FAIL; script `evidence/acceptance.mjs`). Screenshots at 375 px in
`evidence/`.

| Check | Result | Evidence |
|-------|--------|----------|
| E-1 form mode | PASS | 375 px: both start buttons disabled until an age band is chosen **and** the box is ticked; `3-5 years`, `Answer by tapping instead`, 6 safety questions then 15 questions with a "some concerns" pattern -> `Some areas are worth discussing with a professional`, `This is a developmental check-in, not a diagnosis.`, per-domain text, `Find a specialist near you` with the four suggested types; choosing `Banjara Hills` lists two synthetic verified listings (029 `GET /api/public/providers`, 0.1 km); no `Book`; no horizontal scroll; 0 console errors, 0 third-party requests (`screen-intro-en-375.png`, `screen-form-safety-question-375.png`, `screen-result-some-concerns-375.png`) |
| E-2 red flag | PASS | regression question is first; `Yes` -> the page shows only `Please get help now. Call 108 ...` (rendered DOM has no result, no directory, no `Book`); reload keeps the urgent view; API `finish` -> `{ result_band: null, domains: [], red_flag: true, message }`, row `red_flag_codes = {skill_regression}` (`screen-red-flag-375.png`); vitest covers all 6 codes |
| E-3 voice (mocked) | PASS | vitest: the SDK's client tools (`screenClientTools`) call `record_answer` x 21 against the real routes, then `finish` -> result identical to the form for the same answers; conversation id stored. DEMO_MODE: API `{ demo: true }` (no token, `startAgentSession` not called); browser shows `Demo mode: no live voice call. Please answer by tapping.` and the form on the same session, 0 ElevenLabs requests (`screen-voice-demo-375.png`). Extra: with a stubbed token the bundled SDK starts under the `/screen` CSP (its LiveKit request is allowed, 0 CSP violations; the test aborts it) and the page falls back to tapping (`screen-voice-fallback-375.png`) |
| E-4.1 pre-consent data | PASS | `screen_sessions` columns are exactly `id, created_at, expires_at, age_band, mode, answers, result_band, red_flag_codes, conversation_id, saved_child_id, saved_by`; no IP; DB check constraint `screen_answers_valid()` rejects anything but item id -> scale value; no anon/authenticated grants |
| E-4.2 save | PASS | anonymous 401; `guardian_a` without `screen_result_save` -> 422 `Guardian consent required`; allow (020 consent API) -> 201 saved to own child (`saved_child_id`, `saved_by`); `guardian_a` -> `guardian_b`'s child 404. Browser (`guardian_b`): `Save this result to <child>` -> inline Allow dialog -> `Allow and save` -> saved; the child page lists it under `Check-ins` with date, age band and headline (`screen-save-allow-dialog-375.png`, `family-child-checkins-375.png`). Anonymous result: `Sign in to save` -> `/family/login?next=/screen`, result survives reload |
| E-5 agent guide | PASS | `docs/elevenlabs-screen-agent.md`: no-PII rules, red flags first, the fixed safety message (identical to the page, checked by a test), `record_answer` / `record_red_flag` with parameter tables, dynamic variables, 480 s limit, shortest retention / no audio, no data collection, `ELEVENLABS_SCREEN_AGENT_ID` |
| FR-2 translated chrome | PASS | `hi`: `विकास जाँच` (`screen-intro-hi-375.png`); te/hi catalogue parity and copy rules (`tests/i18n-keys.test.ts`) |
| NFR-1 no third-party scripts | PASS | `/screen` gets the strict nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`) with only the ElevenLabs API/LiveKit `connect-src`; 0 external `<script src>`; static module-graph scan of `/screen` (no `next/script`, injected scripts, tracker hosts) |

## Deviations

- **No live ElevenLabs agent or key.** The voice path is built behind the existing patterns (private agent,
  server-minted conversation token, `@elevenlabs/react` client tools) and tested with the SDK mocked at the boundary
  plus a stubbed-token browser run. The agent must be created by hand from `docs/elevenlabs-screen-agent.md`, then the
  manual smoke test in section 9 of that guide run once (human task). Until `ELEVENLABS_SCREEN_AGENT_ID` is set, the
  `Start voice check-in` button is disabled outside DEMO_MODE and the page offers the form.
- **Age bands.** The page bands map to 024's instrument bands: `18-36 months` -> `18-35m`, `3-5 years` -> `36-71m`,
  `6-9 years` and `10+ years` -> `72-215m`. Every 024 question applies to every band today, so all bands get the same
  15 questions (+ 6 safety questions); the filter is in place for future age-specific items.
- **Safety copy.** FR-7's message (`Please get help now. Call 108 ...`) is used on `/screen` and in the agent prompt;
  024's in-portal questionnaire keeps its own `urgent_copy` (not changed).
- **Domain levels** (`few_signs` / `some_signs` / `more_signs`) are draft thresholds at the same proportions as 024's
  total bands (10/45, 20/45), pending the clinical review named in the rd. Copy and bands also need clinician sign-off
  (NFR-2, human task).
- **Extra endpoint** `GET /api/screen/sessions/:id` lets the same browser tab resume (reload, or coming back from
  signing in to save). The browser stores only the session id (`sessionStorage`). Saved check-ins answer 404 on every
  anonymous endpoint (they are child data now).
- **Save window.** A check-in can be saved only while its session is valid (2 h, FR-4) and only when it has a band;
  red-flag and unfinished check-ins answer 409, expired 410, a check-in saved to another child 409 (same child: 200).
- **Optional `conversation_id`** on answers / red-flag / finish (voice only, opaque id, set once) so erasure can delete
  the ElevenLabs conversation of a saved check-in.
- **No audit rows for anonymous actions** (an audit row would attach a hashed IP to the session, FR-5). Saving is a
  strict action (`screen.result_saved`, `auditStrict` in the same transaction, listed in `lib/audit/strict-actions.ts`).
- **CSP.** `/screen` now gets the family nonce CSP (it is a page about a child) plus the ElevenLabs `connect-src`
  exception. No `script-src` exception is needed: the SDK is bundled; its audio worklets are created by bundled code,
  which `'strict-dynamic'` allows. The allowlist entry (`ElevenLabs SDK (developmental check-in)`, route `/screen`) was
  added and `tests/no-tracking.test.ts` updated to accept it.
- **`postSignInPath`** lets a guardian return to `/screen` after signing in (needed to save a result).
- **Voice robustness.** If the call does not connect within 20 s, or ends before every question is answered, the page
  continues with the form and keeps the answers; after a red flag or the last answer the agent has 20 s to say its
  closing line before the page ends the call; the page also enforces the 8-minute limit.

## Notes

- **Migration:** `supabase/migrations/20261113003300_screen.sql` (`screen_sessions`, `screen_answers_valid()`, RLS on,
  no browser grants).
- **New helpers:** `lib/screen/questions.ts` (age bands, `screenQuestions`, `agentQuestionList`, `domainLevel`,
  `URGENT_MESSAGE`, `SUGGESTED_PROVIDER_TYPES`, request schemas; client-safe), `lib/screen/store.ts` (server:
  `createScreenSession`, `recordAnswers`, `recordRedFlag`, `finishSession`, `getSessionView`, `saveScreenResult`,
  `listChildCheckins`), `lib/screen/client.ts` (browser: `startScreen`, `screenClientTools`, `saveToChild`,
  `allowScreenSave`), `lib/screen/rate-limit.ts`; components in `components/screen/`; test helper `tests/helpers/screen.ts`.
  `lib/elevenlabs/agent.ts` `startAgentSession(agentId?)` / `getConversationToken(agentId?)` now take an agent id
  (default: the intake agent) - 034/040 can reuse this for their agents.
- **Env:** `ELEVENLABS_SCREEN_AGENT_ID` (optional; `.env.example`, `lib/env.ts`, `docs/system-design.md`).
- **Privacy (041):** registry category `screen_results` (export = the child's Check-ins list; erasure deletes the rows,
  `all_ai_processing` drops the conversation id; ElevenLabs conversation ids go to the processor deletion log);
  retention step `unsaved_screen_sessions` (30 days); `/privacy` lists the check-in under "What we collect" and the
  30-day rule; `docs/privacy/{retention,processors}.md` updated.
- **For 034 (voice booking):** the check-in result page links to `/find` and `/p/<slug>` only; booking from the result
  is out of scope. 040 can add its ElevenLabs CSP exception next to `/screen` in `FAMILY_CSP_EXCEPTIONS`.
- **Shared files touched additively:** `lib/auth-access.ts` (public `/api/screen/`, guardian `next=/screen`),
  `lib/csp.ts`, `lib/privacy/{registry,retention,third-party-allowlist}.ts`, `lib/audit/strict-actions.ts`,
  `lib/consent/features.ts` (gate text), `messages/*.json` (new `screen` namespace, 2 `privacy.notice` keys),
  `messages/REVIEW.md` (regenerated), `app/privacy/page.tsx`, `app/page.tsx` (parent check-in CTA section),
  `components/landing/SiteNav.tsx` (nav link), `app/family/(portal)/children/[id]/page.tsx` (`Check-ins` section),
  `docs/system-design.md` (section 13a, env row, API rows), `docs/consent.md`, `tests/no-tracking.test.ts`.
- Hindi/Telugu strings are drafts (`messages/REVIEW.md` rows `pending`).
- The dev server logged a hydration warning about `caret-color` on inputs during the headless run; it comes from the
  screenshot tooling (same as noted in 024), not from the app.
- The acceptance data (`e033-*` accounts, synthetic children and two synthetic listings) is left in the slot 7 database.

## Merge with `main` (026 home program, 027 messaging, 038 AI scribe, 030 booking)

- `git merge main`. Conflicts resolved keeping both sides: `lib/csp.ts` (`needsFamilyCsp` = family || 030 booking ||
  033 `/screen`; 033's ElevenLabs `connect-src` exception kept), `lib/auth-access.ts` (`postSignInPath`: guardian may
  return to family, booking (030) and `/screen` paths), `lib/privacy/registry.ts` (`screen_results` + 038 `ai_scribe` +
  026 `home_programs` ...), `lib/audit/strict-actions.ts` (`screen.result_saved` + 038/026/027 actions),
  `app/privacy/page.tsx` (`COLLECT` with `scribe`, `screen`, `homeProgram`, `appointments`, `messages`),
  `app/family/(portal)/children/[id]/page.tsx` (026 `homeProgram` translator + 033 `Check-ins`), `messages/{en,hi,te}.json`
  (deep union, no value clashes), `messages/REVIEW.md` regenerated (`npx tsx scripts/i18n-review.ts`, 2109 rows).
  `tests/no-tracking.test.ts` (030's crawl changes + 033's `/screen` allowlist entry), `lib/privacy/third-party-allowlist.ts`,
  `lib/privacy/retention.ts`, `lib/consent/features.ts`, docs merged automatically. `lib/elevenlabs/agent.ts` had no conflict.
- **Test isolation fix:** the full suite became flaky (1 in ~3 runs) because 033's retention test ran the whole
  `runRetention()` concurrently with 041's retention suite and processed that suite's due audio first. The 033 step is
  now `purgeUnsavedScreenSessions(sql, now)` (called by `runRetention`, count key unchanged) and the 033 test ages and
  purges its rows inside one transaction; 5 consecutive full runs green afterwards.
- **Crawl fix (pre-existing on `main`):** the live no-tracking crawl requested `/family/messages/[threadId]` literally
  (027's page) and got 404; the crawl now creates a synthetic thread on the crawl guardian's case (removed with the case)
  and substitutes `[threadId]`.
- After `dnm-db.sh 7 <worktree> reset` (25 migrations): `npm run lint` exit 0, `npm run typecheck` exit 0,
  `npx vitest run` 78 files, 1231 passed, 11 skipped (the opt-in `CT_DB_TESTS` block + the live crawl; every DB suite ran),
  `npm run build` exit 0, the eval command 2 files, 55 passed, `NO_TRACKING_BASE_URL=http://localhost:3070 npx vitest run
  tests/no-tracking.test.ts` 13 passed (live crawl of every `/family/**` page incl. 026/027/030 pages); `/screen` 200 with
  the strict CSP and `POST /api/screen/sessions` (voice, DEMO_MODE) 201 against the merged dev server.
