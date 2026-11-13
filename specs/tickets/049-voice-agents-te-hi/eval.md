# 049: Telugu and Hindi voice agents - Evaluation

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/agents-*-locale.test.ts --reporter=verbose` exits 0, covering:
  - The token request carries the locale.
  - The first message and safety text match `messages/{hi,te}.json` exactly.
  - A disabled language shows the FR-4 choice and never starts an English call silently.
  - The te/hi scripted fixtures produce the same tool calls as English.

## Acceptance checks

### E-1: Telugu screen call (FR-1, FR-2)

Switch the UI to Telugu, open `/screen` and start voice in `DEMO_MODE`. The first message is in Telugu,
and a red flag produces the Telugu 108/112 message.

### E-2: Fallback (FR-4)

With `ELEVENLABS_BOOKING_LANGUAGES=en` and the UI in Telugu, the voice booking widget offers "Voice in
English" or "Tap in Telugu".
