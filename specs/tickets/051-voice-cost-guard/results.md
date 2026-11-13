# 051: Voice cost guard - Results

Branch: `ticket/051-voice-cost-guard`. Tested against the local Supabase stack of slot 2 (`supabase_db_dnmslot2`,
all migrations re-applied by the helper's `reset`, including `20261113005100_voice_usage.sql`), `DEMO_MODE=true`,
dev server on port 3020, headless Chromium (playwright-core) for the acceptance checks. Synthetic accounts and data
only; every test account is removed afterwards and the runtime cap override was restored to the env values.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (DB suites running) | PASS | 93 files, 1548 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` intake suite and the `NO_TRACKING_BASE_URL` live crawl) |
| `npm run build` | PASS | exit 0; new routes `/api/voice/usage/[id]/end`, `/api/admin/voice-settings` |
| `npx vitest run tests/voice-usage-*.test.ts --reporter=verbose` | PASS | 3 files, 36 tests (unit 13, db 14, routes 9) |
| Anonymous starts (screen, booking, demo) -> 401, ElevenLabs mock not called | PASS | `voice-usage-routes`: all three `{ error: "sign_in_required" }`, `startAgentSession` 0 calls; tap start still 201 and anonymous |
| 3rd screen voice start in a day -> `quota_day`; 30-day limit | PASS | `voice-usage-routes` (route + client mapping to `quotaDay`, ElevenLabs called exactly twice) and `voice-usage-db` (blocked row recorded, other agents unaffected; 4 starts in 30 days -> `quota_month`, a 31-day-old start no longer counts) |
| Two parallel starts by one user -> one `ok`, one `concurrent` | PASS | `voice-usage-db`; also across agents through the routes (booking open -> screen 429 `concurrent` until the end report) |
| 20 parallel starts by different users around the daily cap never exceed it | PASS | `voice-usage-db`: every accepted start saw a total within the cap, totals are distinct (serialised by the advisory lock); with no interference from other suites exactly 10 of 20 fit |
| Budget reached -> 503 `voice_paused` for everyone | PASS | `voice-usage-routes`: screen, booking and live demo for a provider and an admin, ElevenLabs not called, blocked rows `budget`; `voice-usage-db`: day and month caps |
| 80% alert queued once per day | PASS | `voice-usage-db`: two `queueBudgetAlert` calls -> one `voice.budget_alert` outbox event (dedup key per India day and level), separate single 100% event, recipients = platform admins only; routes: a budget refusal queues today's 100% alert |
| End clamped to reserved; expired session reconciles to reserved | PASS | `voice-usage-db` / routes: 99,999 s reported -> 240 (booking reserve); a just-started call cannot claim more than the elapsed time; other users' ids 404; `started` past reserved + 2 min -> `expired`, actual = reserved (function, start path and `/api/cron/booking`); ElevenLabs durations reconciled (97.4 s -> 97) and skipped in DEMO_MODE |
| Live demo: guardian 403; provider once per day | PASS | `voice-usage-routes`: guardian and unverified lead `403 live_demo_not_allowed`; provider 200 then `429 quota_day`; verified demo lead (`pilot_signups`, case-insensitive email) 200; ElevenLabs failure 502 without details and the reservation released |
| Turnstile on: missing/invalid token -> 400; off: no check | PASS | `voice-usage-routes`: screen voice, booking and `/api/auth/phone/send` -> `400 bot_check_failed` without / with a bad token, valid token passes; off -> no `siteverify` call. `voice-usage-unit`: secret, token and IP sent; network errors fail closed; CSP/allowlist only on `/family/login`, `/screen`, `/find` |
| Admin cap override audited | PASS | `voice-usage-db`: `PUT /api/admin/voice-settings` -> `voice.caps_updated` audit row (actor admin, before/after) in the same transaction; override beats env; `AUDIT_FAIL_ACTIONS` -> 503 and nothing changed; guardian 403, anonymous 401, bad bodies 400. Registered as a strict action (`tests/audit-hardening.test.ts`) |
| NFR-2 quota check < 30 ms | PASS | `voice-usage-db`: median of 15 single-call starts under 30 ms |
| E-1 anonymous parent | PASS | browser: `/` and `/screen` signed out; no voice button, `Start free check-in` tap path completed to the result; `Prefer to talk? Sign in to use voice (free)` -> `/family/login?next=%2Fscreen%3Fvoice%3D1`; phone code (DEMO test number) -> back on `/screen?voice=1` with "You are signed in ... start the voice check-in" and the voice button |
| E-2 quota message | PASS | browser, signed-in guardian: voice starts 201, 201 (DEMO notice, continues by tapping), third 429 with "You've used today's voice check-ins. You can finish by tapping, or talk again tomorrow.", tap button enabled, voice button disabled |
| E-3 budget | PASS | browser: provider ran the DEMO voice booking script on `/find` (3 s recorded); admin set the daily cap to 1 minute in `/admin/ops` (`Saved.`, 1 audit row); provider's voice start -> 503, "Voice is resting right now – you can continue by tapping", tap button enabled; Voice usage card: booking 0.1 min, total 0.1 min, `US$0.01 (₹0.42)`, blocked `2 / 2`, "In use: 1 per day, 4,000 per month"; caps then cleared back to the env values |
| E-4 landing demo | PASS | browser, signed out: `Hear the AI intake call` -> the recorded sample plays (currentTime > 0), no live tab or `Start demo call`, 0 requests to `/api/demo/voice-token` |

## Deviations

- **Sign-in page:** E-1 says `/login`; voice sign-in links go to `/family/login` (Google or phone code, decision
  "Google or phone code" in FR-1). `/login` is the clinicians' email/password page. `next` brings the parent back to
  `/screen?voice=1` or `/find?voice=1` (`postSignInPath` now also allows `/find` for guardians).
- **Turnstile scope:** required on voice starts for the screen check-in and voice booking (the public pages that render
  it, FR-8's CSP list) and on `POST /api/auth/phone/send`. The follow-up voice start (family portal, consent-gated,
  guardian-only) and the live demo (provider / verified lead, 1 per day) are not behind Turnstile, because their pages
  are not in FR-8's CSP list; they are covered by sign-in, quotas and the budget.
- **Real Turnstile and ElevenLabs:** no real keys locally. Turnstile `siteverify` and the ElevenLabs client are mocked
  at the boundary in tests; the widget loads only when both keys are set. The ElevenLabs dashboard settings (max
  duration, silence timeout) are documented, not applied (human step).
- **DEMO_MODE counts:** voice starts in DEMO_MODE (no ElevenLabs call) still count against quotas and the budget, so
  E-2/E-3 can be checked locally. The DEMO screen check-in closes its start at once with 0 seconds.
- **Extra column / table:** `voice_usage` also has `blocked_reason` and `reconciled_at`; caps live in a single-row
  `voice_settings` table. Platform day/month = India calendar day/month; the per-user "30 days" is rolling.
- **Budget rule:** a start is refused when used + its own reservation would exceed a cap (never overshoots), so the
  last few minutes of a cap may stay unused.

## Notes

- Ledger, gate and checklist for new voice entry points: `docs/voice-cost-guard.md`; system design 13d; env names in
  `.env.example` and `lib/env.ts` / `lib/voice/config.ts`.
- The per-IP in-memory limiters stay as a first filter (FR-9); repeated local browser runs hit `/screen`'s 5 per IP
  per hour (restart the dev server between runs).
- The landing live tab only renders when `ELEVENLABS_AGENT_ID` is set and the viewer is eligible (server-side).
- Tests that start voice sessions for other reasons use `tests/helpers/voice.ts` (`stubGenerousVoiceLimits`,
  `closeOpenVoiceCalls`); 033/034/040 suites were updated to start voice as a signed-in user.
- hi/te strings are drafts (`messages/REVIEW.md` regenerated, rows pending review).
