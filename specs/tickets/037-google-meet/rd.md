# 037: Google Meet for video appointments

**Status:** draft
**Mode:** solo
**Runs:** waits for 030: creates Meet links for confirmed video appointments

## Summary

Providers connect their own (free @gmail or Workspace) Google account; when a video appointment is
confirmed, DoctorNearMe creates a Google Calendar event with a Meet conference on the provider's
calendar, invites the guardian, and shows `Join video call` to both. Creation is retry-safe through the
outbox. Patients join signed in to Google and are admitted from the Meet lobby by the provider. The AI
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
  <appointment_id>` for idempotency; `sendUpdates=all`; attendee = guardian email if known; summary
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
  provider will admit you from the waiting room.` Guardians without a Google account can join as
  guests (`Ask to join`).

## Non-functional requirements

- **NFR-1** - Refresh tokens never logged or sent to the browser; decrypted only in the worker.
- **NFR-2** - Google OAuth verification submission is a human task (plan §6); until verified, max 100
  test users.

## Affected areas

- `supabase/migrations/<ts>_google_meet.sql` (new); `lib/google/**` (new)
- `app/dashboard/settings/integrations/**`, `app/api/integrations/google/**` (new); agenda + `/family/appointments` (join button)
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

## Open questions

- Guardians who signed up by phone only have no Google email to invite - they join as guests; confirm
  this is acceptable for the pilot.
