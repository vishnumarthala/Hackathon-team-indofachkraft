# 034: Voice booking agent (web widget on /find) - Results

Branch: `ticket/034-voice-booking-agent` (base: 017-030, 032, 033, 038, 041 merged). Tested against the isolated local
Supabase stack of worker slot 7 (`dnmslot7`, all migrations incl. `20261113003400_booking_agent.sql` applied by
`supabase db reset`), `DEMO_MODE=true`, dev server on port 3070 with `ELEVENLABS_TOOL_SECRET=test-3070`, own headless
Chromium (playwright-core in a scratch folder, removed afterwards) at 375 px in `Asia/Kolkata`. Synthetic accounts
(`seed:users --prefix e034`), a synthetic Banjara Hills provider with a free in-clinic service, and `t034*` test users
only. No ElevenLabs key or agent exists locally: the live call is a manual human smoke test
(`docs/elevenlabs-booking-agent.md` section 10). Evidence: `evidence/acceptance.txt`,
`evidence/booking-agent-tests-verbose.txt`, screenshots `evidence/*.png`.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, `vitest run`, build) | PASS | exit 0; vitest 79 files, 1251 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl); every DB suite ran |
| `npx vitest run tests/booking-agent-tools.test.ts --reporter=verbose` | PASS | 20 tests (`evidence/booking-agent-tests-verbose.txt`): secret missing / wrong / unset on the server -> 401; unknown, expired (30 min) and ended session -> 401; `child_name` / `phone` / `dob` keys -> 400, non-object / non-JSON body -> 400; 21st tool call -> 429 (invalid payloads count); second hold releases the first (`cancelled`, `hold_released`); `slot_taken` -> `{ held: false, reason: "slot_taken" }`; off-grid -> `slot_unavailable`; result limits 5 providers (7 bookable in the area) and 6 slots; `part_of_day` in the clinic's zone; session 5/IP/hour -> 429; live mode 503 without agent/secret, mocked ElevenLabs token otherwise |
| FR-1 agent guide | PASS | `docs/elevenlabs-booking-agent.md`: name `DoctorNearMe Booking Assistant`, English only, private (conversation token), 360 s, `{{booking_session}}` (+ `{{today}}`), server tools `search_providers` / `get_slots` / `hold_slot` with `X-Agent-Secret`, client tool `record_red_flag`, prompt rules (area, specialty, language, mode, day/time, age band only; never names, phone, DOB; 033's 108/112 message; sign in and confirm on screen); a test checks the guide's key rules |
| FR-2 session | PASS | `POST /api/agents/booking/session` 201 `{ booking_session (32 random bytes), conversation_token, expires_at, dynamic_variables }`; httpOnly `dnm_booking_session` cookie (path `/api/agents/booking`) and 030's `dnm_booking` cookie; DB keeps only `sha256` of the token; 5 per IP per hour |
| FR-3 tools | PASS | shared secret (constant-time) + per-conversation session (valid 30 min, not ended, 20 calls counted atomically in SQL) + strict schema; `search_providers` geocodes server-side (029 table locally) and returns `{ profile_id, name, type, locality, distance_km, modes, languages }`; `get_slots` max 6; `hold_slot` -> 030 `booking_hold` -> `{ held: true, expires_at, confirm_url }`; one hold per session |
| FR-4 widget | PASS | `/find` -> `Book by voice` -> disclosure `You will talk to an AI assistant in English. It will not ask for your child's name.` -> `Start` -> captions -> card `Dr Asha Rao (synthetic) - 14 Nov 2026, 9:00 am IST - held for 10 minutes`, `Time left: 9:59`, `Sign in and confirm` -> `/book/<profileId>?appointment=<id>` (`evidence/find-*.png`) |
| FR-5 audit | PASS | one `booking_agent.hold_created` row per hold, actor `ai`, role `ai`, no user, `details = { session_hash }` only (strict audit in the hold's transaction); logs carry tool, status and duration only |
| NFR-1 latency | PASS | local p95 over 12 calls each: search_providers 23 ms, get_slots 20 ms, hold_slot 9 ms (test asserts < 1500 ms); curl search 0.06 s |
| NFR-2 no PII | PASS | strict schemas (`Unrecognized key: "child_name"` -> 400), a 7+ digit run in `locality_text` -> 400, no free-text fields besides the place |
| NFR-3 DEMO_MODE | PASS | scripted English conversation (`lib/agents/booking/demo-script.ts`) through `POST /api/agents/booking/demo/:tool` (cookie-bound, 404 outside DEMO_MODE) into the same handlers; tested in vitest and in the browser |
| E-1 scripted conversation to hold | PASS | browser: search -> 1 provider -> 3 morning times -> hold; card with provider, time and countdown; `appointments` row `held`, `hold_owner_session` = `sha256("booking-session:" + dnm_booking cookie)` (030's hash of the cookie value), expires in 599 s |
| E-2 confirm requires sign-in | PASS | `Sign in and confirm` -> `/book/...?appointment=` shows `We are holding ...` -> phone OTP (`guardian_a`, demo code) returns to `/book/...?hold=` -> child -> `Confirm booking` -> `Your appointment is booked.`, row `confirmed` with guardian + child; no confirm tool (`/api/agents/booking/tools/confirm` 404, a test asserts the three tool folders and no confirm/attach call in agent code); direct `POST /api/appointments/:id/confirm` without a session -> 401 |
| E-3 hold ownership | PASS | a second browser opening the confirm URL sees no hold; signed in as `guardian_b` its confirm -> 404 `not_found` (also in vitest) |
| E-4 safety and PII | PASS | guide has the red-flag rule and fixed message and the no-PII rules; `child_name` -> 400; audit details only `{ session_hash }` |
| Degrade to /find | PASS | `DEMO_MODE=false` without `ELEVENLABS_BOOKING_AGENT_ID`/`ELEVENLABS_TOOL_SECRET`: `/find` has no widget and the normal search; session 503, tools 401, demo route 404; widget start/connect failures show `Voice booking is not available right now. Please use the search below.` and leave the page as is |
| i18n / 375 px | PASS | new `voiceBooking` namespace in en/hi/te (27 keys), `messages/REVIEW.md` regenerated; no horizontal scroll at 375 px in en/hi/te (`evidence/find-disclosure-{hi,te}-375.png`); the conversation itself is English (D-3) |
| CSP / allowlist (041) | PASS | `lib/csp.ts` `FAMILY_CSP_EXCEPTIONS["/find"]` = ElevenLabs API + LiveKit `connect-src`; `THIRD_PARTY_ALLOWLIST` entry `ElevenLabs SDK (voice booking)` for `/find` (ticket 034); `tests/no-tracking.test.ts` updated |

## Deviations

- **Hold owner = the browser's 030 booking session, not the agent token.** FR-2 says the session hash is "used as
  `hold_owner_session`". The agent's `booking_session` is visible to ElevenLabs (dynamic variable, tool payloads), so it
  must not be an ownership credential. The session route therefore stores the browser's `dnm_booking` cookie hash
  (`owner_session_hash`) and holds are owned by it; the agent token's hash only authenticates tool calls and is kept in
  the httpOnly `dnm_booking_session` cookie so only this browser can read/end the session. E-1's "`hold_owner_session` =
  sha256 of the cookie value" holds for the `dnm_booking` cookie (030's `hashBookingSession`), and the unchanged 030
  confirm flow attaches the hold after sign-in.
- **`?appointment=`** (FR-4) is accepted by 030's `/book/[profileId]` page as an alias of `?hold=`; after sign-in the
  030 flow continues with `?hold=`.
- **Extra fields:** `search_providers` results also carry `modes` and `languages` (public profile data the agent needs
  to ask in-clinic vs video); `get_slots` returns `service_id`, `local_time` and `time_zone` per slot (hold_slot needs
  the service). Each tool result has a `message` telling the agent what to do next. The session also gets a
  `{{today}}` variable so the agent can turn "Saturday" into `date_from`.
- **Ended sessions:** besides expiry, a session ends when the widget reports a red flag (`record_red_flag` client
  tool) or the call ends (`DELETE /api/agents/booking/session`); later tool calls get 401.
- **Rate limits** are in-memory per instance (same as 029/030/033); the 20-call budget is in SQL and survives
  instances.
- **`/find` CSP:** `/find` has no nonce CSP today (029 loads Google Maps there), so the approved ElevenLabs exception is
  declared but only takes effect if `/find` moves under the strict policy.
- **Live agent not exercised** (no ElevenLabs key/agent locally): token minting is covered with a mocked ElevenLabs
  boundary; the live call and red-flag behaviour are in the manual smoke test of the guide.

## Notes

- **Migration** `20261113003400_booking_agent.sql` (additive): `booking_agent_sessions` (`token_hash` unique,
  `owner_session_hash`, `demo`, `expires_at` = +30 min, `ended_at`, `tool_calls`, `hold_appointment_id` -> appointments
  `on delete set null`); RLS on, no policies, no grants for anon/authenticated. Hashes and counters only (not a privacy
  registry category); rows are purged 1 day after expiry when new sessions start.
- **Code:** `lib/agents/booking/{constants,schemas,session,rate-limit,handler,tools,demo-script}.ts`,
  `app/api/agents/booking/{session,tools/*,demo/[tool]}`, `components/voice/{BookingWidget,LiveBookingCall}.tsx`
  (the ElevenLabs SDK is loaded only when a live call starts), `/find` page.
- **Env:** `ELEVENLABS_BOOKING_AGENT_ID`, `ELEVENLABS_TOOL_SECRET` (optional; `lib/env.ts`, `.env.example`).
- **Docs:** `docs/elevenlabs-booking-agent.md` (new, dashboard setup + smoke test), `docs/system-design.md` (env, API
  table, ElevenLabs section, new section 13b), `docs/booking.md` (034 extension point), `docs/privacy/processors.md`.
- **For later tickets:** 037/042 hold rules in `lib/booking/hooks.ts` `checkHoldPreconditions()` also apply to agent
  holds (`userId: null`); a refusal becomes `{ held: false, reason: <code> }`. Agent tools reuse 029's `getGeocoder()` /
  `searchProviders()` and 030's `getSlots()` / `holdSlot()`; new agent tools go through `handleToolCall()`.

## Merge with main (031 payments, 037 Google Meet)

- **Merged `main` twice** (031 Razorpay test mode, then 037 Google Meet). Conflicts resolved keeping both sides:
  `lib/csp.ts` (`/find` ElevenLabs + `/book/*/pay/*` Razorpay exceptions), `tests/no-tracking.test.ts` (allowlist
  names/routes for `/find` and the payment page), `docs/booking.md`, `messages/{en,hi,te}.json` (main's catalogues +
  `voiceBooking`), `messages/REVIEW.md` regenerated (`npx tsx scripts/i18n-review.ts`, 2245 rows). Test cleanup deletes
  this suite's `payments` (and their events/outbox/audit) before appointments (031 `on delete restrict`).
- **031 online payment:** `get_slots` and `hold_slot` results, the widget status and card carry `payment_mode` +
  `fee_inr`; for online services the agent/demo says the parent pays online after confirming and the card shows
  `After you confirm, you pay ₹500 online to complete the booking.` Confirm moves the agent's hold to `pending_payment`
  and 030's page continues to `/book/<profileId>/pay/<appointmentId>`. Vitest: agent hold (online, ₹600) -> guardian
  confirm 200 `pending_payment` -> `payment-order` 200 `amount_paise 60000`. Browser (375 px): voice hold -> `Sign in and
  confirm` -> OTP -> child -> `Continue to payment` -> `/book/<id>/pay/<id>` `Pay for your appointment`, row
  `pending_payment` (15 min) (`evidence/acceptance.txt`, `evidence/find-hold-card-online-375.png`,
  `evidence/pay-from-voice-375.png`).
- **037 Google Meet:** `checkHoldPreconditions()` refuses video holds without a Google identity, and agent holds are
  anonymous, so `hold_slot` relays it as 200 `{ held: false, reason: "google_account_required", booking_url:
  "/book/<profileId>", message }` (offer an in-clinic time or book on the page after signing in with Google); nothing is
  held or audited. `get_slots` for video warns the agent up front; the demo script says the refusal. Tests added.
- **i18n typing:** with the merged catalogue (2245 keys) `createTranslator()` hit TS2589 ("type instantiation is
  excessively deep") in `lib/i18n/translate.ts`; the inner function is now typed with `string` keys and cast once to
  `TFunction<N>` (call sites keep full key checking; no runtime change).
- **Post-merge checks** (slot 7 reset with all migrations incl. 031/037, env loaded): see the table below.

| Post-merge check | Result | Evidence |
|-------|--------|----------|
| `$H 7 <worktree> reset` | PASS | all migrations from the merged tree (incl. 031 payments, 037 Meet, 034 booking agent) |
| `npm run lint` / `npm run typecheck` / `npm run build` | PASS | exit 0 |
| `npx vitest run` | PASS | 82 files, 1333 passed, 11 skipped (same opt-in skips); every DB suite ran. A first run had one failure in 041's `privacy-export-deletion` (export notification already drained by a concurrent outbox worker in another suite); the file passes alone (5/5) and the full rerun is green; unrelated to 034 |
| `npx vitest run tests/booking-agent-tools.test.ts` | PASS | 23 passed (20 + online payment -> `pending_payment` -> payment order; video hold -> `google_account_required`; demo script relays the refusal) |
