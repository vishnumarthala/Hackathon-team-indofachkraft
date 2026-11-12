# 037: Google Meet - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, set a test `TOKEN_ENCRYPTION_KEY`, `npm install`, `npm run db:migrate`.
- Google APIs mocked (HTTP mock of `oauth2.googleapis.com` and `www.googleapis.com/calendar/v3`). A
  live OAuth + Meet check with a test Google account is a manual human smoke test.
- Data: 030 setup with a video service. Start: `DEMO_MODE=true npm run dev -- -p <port>` and
  `npm run -s outbox:run`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/google-meet.test.ts --reporter=verbose` exits 0: token encryption round-trip
  and tamper detection; OAuth `state` mismatch rejected; `meet.create` retried 3x after timeouts creates
  exactly one event (extended-property lookup); reschedule patches, cancel deletes; `invalid_grant` ->
  `expired` + notification; event summary/description contain no child name.

## Acceptance checks

### E-1: Connect and create (FR-2, FR-3, FR-5)

Connect (mocked) as `provider_a`; book a video slot as `guardian_a` -> `meet_status = 'created'`,
`meet_url` stored; both see `Join video call` only inside the time window (time-travel).

### E-1a: Google account and guest privacy (FR-3, FR-5a)

A phone-only guardian trying to hold a video slot gets 422 `Link your Google account to book a video
consultation` and the page shows `Connect Google`; an in-clinic slot books normally. After linking Google
the video hold succeeds. The mocked `events.insert` request has no `attendees` and `sendUpdates=none`.

### E-2: Failure path (FR-4)

Disconnect, book again -> `failed`; provider pastes a Meet URL -> `manual`; guardian sees it.
Non-Meet URL -> 400.

### E-3: Authz and secrecy (NFR-1)

`provider_b` cannot read `provider_a`'s connection or set a manual link on their appointment (404).
Browser responses and logs contain no refresh token.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
