# 037: Google Meet for video appointments

**Status:** draft
**Mode:** solo
**Runs:** waits for 030: creates Meet links for confirmed video appointments

## Summary

Providers connect their own (free @gmail or Workspace) Google account; when a video appointment is
confirmed, DoctorNearMe creates a Google Calendar event with a Meet conference on the provider's
calendar (the guardian is never added as a calendar guest), and shows `Join video call` to both inside DoctorNearMe. Creation is retry-safe through the
outbox. A Google account is mandatory for the guardian of a video appointment: they join signed in to Google and
are admitted from the Meet lobby by the provider. The AI
scribe is **not** available on Meet calls (risk 3).

## Functional requirements

- **FR-1** - Migration `<ts>_google_meet.sql`: `provider_google_connections(provider_profile_id pk,
  google_email, refresh_token_encrypted bytea, scopes text[], connected_at, last_refreshed_at, status
  text check in ('active','expired','revoked'))`; `appointments.meet_url text null`,
  `google_event_id text null`, `meet_status text check in ('not_needed','pending','created','failed',
  'manual')`.
- **FR-2** - OAuth: `/dashboard/settings/integrations` -> `Connect Google Calendar` -> Google OAuth (scope
  `https://www.googleapis.com/auth/calendar.events`, `access_type=offline`, `prompt=consent`, PKCE,
  `state` bound to the session) -> callback `/api/integrations/google/callback` stores the refresh token
  encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, 32 bytes base64). `Disconnect` revokes the token at
  Google and deletes it. `invalid_grant` on refresh -> `expired` + provider notified `Reconnect Google
  Calendar` (unverified apps get 7-day tokens - risk 4).
- **FR-3** - Outbox topic `meet.create` on `appointment.confirmed` for `mode = 'video'`: calls
  `events.insert` (`conferenceDataVersion=1`, `conferenceData.createRequest.requestId =
  <appointment_id>` for idempotency; `sendUpdates=none`; no attendees, so the guardian's email never reaches the provider's calendar; summary
  `DoctorNearMe video consultation` - no child name; description with the app link). Before inserting,
  looks up an existing event by `privateExtendedProperty=dnm_appointment_id=<id>` so retries never
  create duplicates. Stores `meet_url`/`google_event_id`, `meet_status = 'created'`, emits
  `appointment.meet_ready` (in-app, email, WhatsApp). Reschedule -> `events.patch`; cancel ->
  `events.delete`.
- **FR-4** - Failure after retries (or provider not connected) -> `meet_status = 'failed'`; provider sees
  `Add a video link` to paste a `https://meet.google.com/...` URL manually (`manual`); guardian sees
  `Your provider will share the video link soon.`
- **FR-5** - `Join video call` button for guardian (`/family/appointments`) and provider (agenda) from 10
  minutes before start until 30 minutes after end; guardian text: `Join with your Google account. The
  provider will admit you from the waiting room.`
- **FR-5a** - Google account required for video (product decision 2026-11-12). Holding or confirming an
  appointment for a `video` service (030 `hold`/`confirm`, and the 034 voice agent's confirm) checks that
  the guardian has a linked Google identity (019 `linkIdentity`). Without one: 422
  `{ error: "Link your Google account to book a video consultation" }`, and the booking page shows that text
  with a `Connect Google` button (019 account page) before slot selection. In-clinic services are unaffected.

## Non-functional requirements

- **NFR-1** - Refresh tokens never logged or sent to the browser; decrypted only in the worker.
- **NFR-2** - Google OAuth verification submission is a human task (plan §6); until verified, max 100
  test users.

## Affected areas

- `supabase/migrations/<ts>_google_meet.sql` (new); `lib/google/**` (new)
- `app/dashboard/settings/integrations/**`, `app/api/integrations/google/**` (new); agenda + `/family/appointments` (join button)
- `lib/booking/**` (FR-5a Google-identity check for video holds/confirms), booking page notice
- `lib/notify/topics.ts`, `.env.example` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`)
- `tests/google-meet.test.ts` (new)

## Don't touch

- Booking state machine (030), scribe (038), existing migrations, `BOARD.md`

## Out of scope

- Built-in WebRTC room, recording/transcribing Meet calls, Zoom, Workspace domain-wide delegation.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Video | Google Meet via provider's Google OAuth first | plan §2 "Video" |
| D-2 | Idempotency | `requestId` = appointment id + extended-property lookup | rule 12 "retry-safe Meet creation" |
| D-3 | Scribe on Meet | Not supported | plan §2 "Scribe capture"; risk 3 |
| D-4 | Guardian Google account | Mandatory for video appointments; no guest join | product owner 2026-11-12 |
| D-5 | Calendar guests | Guardian never added; join link only inside DoctorNearMe and notifications | grill: "accept sign-in, doctor admits from lobby"; plan privacy rule |

## Open questions

None.
