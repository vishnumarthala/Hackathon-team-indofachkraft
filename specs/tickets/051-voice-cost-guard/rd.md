# 051: Voice cost guard (no anonymous voice, per-user quotas, platform budget)

**Status:** done
**Mode:** solo
**Runs:** alongside (048 and 049 change the same voice pages afterwards)

## Summary

Every voice minute costs money: ElevenLabs Conversational AI is roughly US$0.08–0.12 per minute depending on
the plan, so an 8-minute call costs about ₹55–80. Three voice agents can be started today by **anyone,
without signing in**:

1. the live intake-agent demo on the landing page (`POST /api/demo/voice-token`)
2. the voice check-in on `/screen`
3. the voice booking widget on `/find`

Their only protection is an **in-memory per-IP limit**. On Vercel each server instance keeps its own count,
and IPs can be rotated, so a script or a curious crowd could burn the monthly credit in hours.

This ticket closes that gap without hurting real parents:

- **Tapping is free and open to everyone.** Anonymous visitors can still check in by tapping and search
  by tapping.
- **Voice needs a free sign-in.** Google or phone code.
- **Per-user quotas.** Each signed-in user gets a small voice allowance, counted in the database.
- **Hard daily and monthly platform budget.** When the budget is spent, voice switches off and tapping
  keeps working.
- **Every minute is recorded.** Admins can see the spend.

Source: product owner concern 2026-11-13 ("aren't we wasting our credits because people might misuse this").

## Functional requirements

- **FR-1 – Sign-in before voice.** Starting any voice session (screen, booking, follow-up, the landing live
  demo) requires a signed-in user.
  - Anonymous visitors see the tap option as the primary action ("Start free check-in"). The voice
    option reads "Prefer to talk? Sign in to use voice (free)", and after sign-in they return to the same
    step (`next=`).
  - Server routes return 401 `{ error: "sign_in_required" }` before contacting ElevenLabs.
  - Appointment intake calls (035) and Child Development intake links stay as they are: they are already
    bound to a signed, expiring token and limited per appointment.
- **FR-2 – Landing demo.** For anonymous visitors, `Hear the AI intake call` plays the **recorded
  sample** (no ElevenLabs call).
  - The live demo is only for signed-in **provider** accounts and for leads who booked a demo
    (`pilot_signups` with a verified email). It is limited to 1 live demo per user per day.
  - `POST /api/demo/voice-token` enforces this.
- **FR-3 – Voice usage ledger.** Migration `<ts>_voice_usage.sql`: `voice_usage(id, user_id, agent check
  in ('screen','booking','followup','intake_demo'), started_at, ended_at null, reserved_seconds,
  actual_seconds null, conversation_id null, status check in ('started','ended','expired','blocked'))`.
  - Indexes are on `(user_id, agent, started_at)` and `(started_at)`.
  - Register it in the 041 privacy registry with 180-day retention.
  - The table never stores child data or transcripts.
- **FR-4 – Quotas per user** (env-configurable, defaults below). They are checked in one SQL function
  `voice_session_start(user, agent, reserved_seconds)`, which is atomic (no race between parallel
  starts) and returns `ok | quota_day | quota_month | budget | concurrent`.
  - `screen`: 2 per day, 4 per 30 days.
  - `booking`: 3 per day, 10 per 30 days.
  - `followup`: 5 per day, 30 per 30 days.
  - `intake_demo`: 1 per day.
  - Only **one** active voice session per user at a time.
  - When a limit is hit, the UI says, for example, "You've used today's voice check-ins. You can finish
    by tapping, or talk again tomorrow." The tap path is always offered.
- **FR-5 – Platform budget.** `VOICE_DAILY_MINUTES_CAP` (default 300) and `VOICE_MONTHLY_MINUTES_CAP`
  (default 4000) are compared with the sum of reserved and actual minutes.
  - When either is reached, every voice start returns 503 `{ error: "voice_paused" }` and the UI falls
    back to tapping ("Voice is resting right now – you can continue by tapping").
  - Platform admins get one outbox alert per day at 80% and at 100%.
- **FR-6 – Shorter calls.** The maximum length drops to 6 minutes for screen (was 8), 4 for booking (was
  6) and 10 for follow-up (was 15). These are the reserved seconds.
  - The client already ends calls at the maximum. It now also ends a call after 30 seconds without
    speech from the user, with the message "We ended the call because it went quiet. You can continue by
    tapping."
  - The agent docs set ElevenLabs' own max duration and silence timeout to the same values.
- **FR-7 – End and reconcile.** The client reports the end (`POST /api/voice/usage/:id/end` with the
  duration, which is clamped to reserved seconds). Sessions still `started` at reserved + 2 minutes are
  marked `expired` with actual = reserved (a cron job in the existing outbox or booking schedule). When a
  conversation id is known and ElevenLabs is configured, a job fetches the real duration; in `DEMO_MODE`
  it is skipped.
- **FR-8 – Bot check on cheap-to-abuse endpoints.** When `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
  are set, voice starts and `POST /api/auth/phone/send` (SMS pumping) need a valid Cloudflare Turnstile
  token. When they are unset, the check is off (local and demo).
  - Add `challenges.cloudflare.com` to the Content Security Policy (CSP) only on the routes that render
    it (sign-in, screen, find). It is an anti-abuse service, not analytics, which matches decision 3 of
    2026-11-12.
- **FR-9 – Database-backed rate limits.** Replace the per-instance in-memory limiters for **session
  starts** (screen, booking, demo) with the database checks above. The per-IP in-memory limiters can
  stay as a cheap first filter.
- **FR-10 – Admin visibility.** `/admin/ops` gets a "Voice usage" card: minutes today and this month per
  agent, estimated cost (`VOICE_COST_PER_MINUTE_USD`, default 0.10, shown in USD and INR via
  `USD_INR_RATE`, default 84), the top 10 users by minutes (user id and role only), and blocked starts.
  `/admin/ops` can also change the caps at runtime, using a settings row that overrides the env values,
  with an audit event.

## Non-functional requirements

- **NFR-1** – No ElevenLabs API call happens before sign-in, quota and budget checks pass (tests
  assert the ElevenLabs client is not called).
- **NFR-2** – A quota check adds < 30 ms (single SQL call).
- **NFR-3** – Privacy: nothing about the child is added. The screen session stays anonymous with respect
  to the child; only the `voice_usage` row links the parent's account to "a voice check-in happened".
  Update the privacy notice text accordingly.

## Affected areas

- `supabase/migrations/<ts>_voice_usage.sql` (new); `lib/voice/usage.ts` (new); `app/api/voice/usage/**` (new)
- `app/api/demo/voice-token/route.ts`, `app/api/screen/sessions/**`, `app/api/agents/booking/**`,
  `app/api/agents/followup/**`, `lib/screen/**`, `lib/agents/booking/**`, `lib/followup/**`
- `components/screen/**`, `components/voice/**`, `components/followup/**`, landing hero/demo components
- `app/admin/ops/**`, `lib/privacy/registry.ts`, `lib/env.ts`, `.env.example`, `messages/{en,hi,te}.json`
- `docs/elevenlabs-*.md` (max duration + silence timeout), `docs/privacy/processors.md` (Turnstile)
- `tests/voice-usage-*.test.ts` (new)

## Out of scope

- Paid voice plans for parents. Voice for unauthenticated phone calls (there are none).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Anonymous voice | Not allowed; tapping stays free and anonymous | Credits are spent per minute; sign-in makes abuse costly |
| D-2 | Limits store | Postgres (atomic function) | In-memory limits are per instance on Vercel |
| D-3 | Budget behaviour | Fall back to tapping, never a dead end | The parent still finishes the check-in |
| D-4 | Landing demo | Recorded sample for everyone; live only for providers and demo leads | It's a sales tool, not a parent feature |
