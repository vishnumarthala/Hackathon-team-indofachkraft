# 051: Voice cost guard - Evaluation

## Setup

- `DEMO_MODE=true` plus a fake `ELEVENLABS_*_AGENT_ID`, so routes reach the (mocked) ElevenLabs client.
  Synthetic guardian, provider and admin accounts.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/voice-usage-*.test.ts --reporter=verbose` exits 0, covering:
  - Anonymous starts for screen, booking and demo → 401, and the ElevenLabs mock is not called.
  - A guardian's 3rd screen voice start in one day → `quota_day`; the 30-day limit works too.
  - Two parallel starts by the same user → one `ok`, one `concurrent`.
  - 20 parallel starts by different users around the daily cap never exceed the cap.
  - The budget reached → 503 `voice_paused` for everyone.
  - The 80% alert is queued once per day.
  - End: the duration is clamped to reserved seconds; an expired session reconciles to reserved.
  - The live demo as a guardian → 403; as a provider, once per day.
  - Turnstile on: a missing or invalid token → 400. Turnstile off: no check.
  - The admin cap override is audited.

## Acceptance checks

### E-1: Anonymous parent (FR-1)

Signed out, open `/` and `/screen`. "Start free check-in" (tap) works end to end. "Prefer to talk? Sign
in…" leads to `/login`, and after sign-in it returns to the screen voice step.

### E-2: Quota message (FR-4)

As a guardian, do two voice check-ins. The third start shows the friendly quota message and the tap
option.

### E-3: Budget (FR-5, FR-10)

Set the cap to 1 minute in `/admin/ops`, then start a call: the start is refused with "Voice is resting",
the tap option is shown, and the Voice usage card shows the minutes and estimated cost.

### E-4: Landing demo (FR-2)

Signed out, `Hear the AI intake call` plays the recording, and the network log shows no
`/api/demo/voice-token` request.
