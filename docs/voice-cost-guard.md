# Voice cost guard (ticket 051)

Every ElevenLabs voice minute costs money (roughly US$0.08-0.12 per minute). This guard makes sure no voice minute is
spent before we know **who** is calling, that they have **quota** left and that the **platform budget** has room.
Tapping (the check-in form, search and booking on `/find`, typed follow-up questions) stays free and anonymous.

## Rules

| What | Rule |
|------|------|
| Sign-in | Every voice start (screen check-in, voice booking, follow-up, the landing live demo) needs a signed-in user: `401 { "error": "sign_in_required" }` otherwise. Anonymous visitors see `Prefer to talk? Sign in to use voice (free)`, which goes to `/family/login?next=/screen?voice=1` (or `/find?voice=1`) and comes back to the same step. |
| Landing demo | Anonymous visitors (and plain guardians) get only the recorded sample: the live tab is not rendered, so no `/api/demo/voice-token` request. Live: provider and platform-admin accounts, and demo leads (`pilot_signups`) signed in with the same **verified** email. Others: `403 { "error": "live_demo_not_allowed" }`. |
| Quotas (per user, env) | `screen` 2 per day / 4 per 30 days, `booking` 3 / 10, `followup` 5 / 30, `intake_demo` 1 per day. Day = calendar day in India; "30 days" = rolling. Refused: `429 { "error": "quota_day" }` / `"quota_month"`. |
| One call at a time | A user with an open voice call (any agent) gets `429 { "error": "concurrent" }`. |
| Platform budget | `VOICE_DAILY_MINUTES_CAP` (300) and `VOICE_MONTHLY_MINUTES_CAP` (4000), India calendar day / month, overridable in `/admin/ops`. A start is refused when used + its reservation would exceed a cap: `503 { "error": "voice_paused" }` for everyone. |
| Alerts | One outbox alert (`voice.budget_alert`, in-app + email, platform admins) per India day and level: 80% and 100%. |
| Call length | Reserved seconds = maximum call length: screen 6 min (was 8), booking 4 (was 6), follow-up 10 (was 15), landing demo 3. The client ends the call at the maximum and after **30 s without speech** from the user ("We ended the call because it went quiet. You can continue by tapping."). The ElevenLabs agents are set to the same max duration and silence timeout (`docs/elevenlabs-*.md`). |
| Bot check | With `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`, voice starts on `/screen` and `/find` and `POST /api/auth/phone/send` need a valid Cloudflare Turnstile token in `X-Turnstile-Token` (`400 { "error": "bot_check_failed" }`). Unset = no check (local, DEMO_MODE). |

Order of checks in every voice route (`lib/voice/gate.ts`, before any ElevenLabs call, NFR-1): per-IP in-memory
limiter (cheap first filter) -> agent configured (503) -> signed in (401) -> Turnstile (400, screen/booking only) ->
`voice_session_start` (one SQL call: budget, concurrent, daily quota, 30-day quota, reservation) -> ElevenLabs. If
ElevenLabs then fails, the reservation is deleted (`release()`), so the user loses nothing.

## Ledger: `voice_usage` (migration `20261113005100_voice_usage.sql`)

`id, user_id, agent, started_at, ended_at, reserved_seconds, actual_seconds, conversation_id, status
(started|ended|expired|blocked), blocked_reason, reconciled_at`. Account id and seconds only: nothing about the child,
no transcript (NFR-3). Indexes `(user_id, agent, started_at)` and `(started_at)`. RLS on, no browser grants.
Privacy registry key `voice_usage`, deleted after 180 days (retention step `voice_usage`) or with the account (cascade).

- **Start:** `public.voice_session_start(user, agent, reserved, day_limit, month_limit, daily_cap_s, monthly_cap_s)`
  returns `ok | quota_day | quota_month | budget | concurrent` plus the usage row id and the day/month totals. A
  transaction-scoped advisory lock serialises starts platform-wide, so parallel starts never overshoot a quota or the
  budget. Refusals are stored as `blocked` rows (admin visibility; they do not count as starts).
- **Budget arithmetic:** a `started` row counts its reserved seconds, an `ended` / `expired` row its actual seconds
  (`public.voice_usage_seconds`).
- **End:** the browser calls `POST /api/voice/usage/:id/end { duration_seconds, conversation_id? }` (own calls only,
  404 otherwise). The duration is clamped to the reserved seconds and to the time since the start (+5 s). Idempotent.
- **Expiry:** calls still `started` at reserved + 2 minutes become `expired` with actual = reserved. Done by every start
  and by the booking cron (`/api/cron/booking`, every minute).
- **Reconcile:** the same cron fetches the real `call_duration_secs` from ElevenLabs for ended calls with a
  conversation id (skipped in DEMO_MODE / without `ELEVENLABS_API_KEY`).
- **DEMO_MODE:** starts still count (so quotas and the budget can be tried locally). The screen check-in has no call in
  DEMO_MODE: the start is closed at once with 0 seconds and the page continues by tapping. The booking script and the
  follow-up demo panel report their elapsed time.

## Admin (`/admin/ops`, platform admins)

The **Voice usage** card shows minutes today and this month per agent, the estimated cost
(`VOICE_COST_PER_MINUTE_USD` [0.10] in USD and INR via `USD_INR_RATE` [84]), the top 10 users this month (user id and
role only), blocked starts (today / this month) and the caps in force. The cap form (`PUT /api/admin/voice-settings
{ daily_minutes_cap, monthly_minutes_cap }`, null = env value, 0 = voice paused) writes the `voice_settings` override and
its `voice.caps_updated` audit row in one transaction (strict action: fails closed with 503).

## For later tickets (048/049/050 change the same voice pages)

- Every new voice entry point must go through `voiceGate(req, agent, { turnstile })` and return `voice_usage_id` and
  `max_seconds`; the client must call `reportVoiceEnd()` (`lib/voice/client.ts`) when the call ends.
- Live call components use `useVoiceCallGuard()` (`components/voice/useVoiceCallGuard.ts`) for the 30-second silence
  rule and the connected seconds; refusals map to message keys with `voiceRefusal()` (`lib/voice/constants.ts`).
- Pages that render a voice start or a phone-code form on a strict-CSP route need the Turnstile CSP entry
  (`lib/csp.ts` `TURNSTILE`) and an allowlist route (`lib/privacy/third-party-allowlist.ts`); the widget is
  `useTurnstile(siteKey)` (`components/security/Turnstile.tsx`), the site key comes from `turnstileSiteKey()`.
- A new agent needs: its name in the `voice_usage.agent` check and `voice_session_start` (new migration), a quota in
  `lib/voice/config.ts`, a max length in `VOICE_MAX_SECONDS`, admin labels (`privacy.admin.ops.voiceAgents.*`).
- Tests that start voice sessions for other reasons: `stubGenerousVoiceLimits()` and `closeOpenVoiceCalls()`
  (`tests/helpers/voice.ts`).
