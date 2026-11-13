# Google Meet for video appointments (ticket 037)

Providers connect **their own** Google account (free `@gmail.com` or Google Workspace). When a video appointment is
confirmed, DoctorNearMe creates a Google Calendar event with a Google Meet conference **on the provider's calendar** and
shows `Join video call` to the guardian and the provider inside DoctorNearMe. The guardian is **never** added as a
calendar guest (no attendees, `sendUpdates=none`): they open the link from DoctorNearMe, join signed in to their own
Google account and the provider admits them from the Meet waiting room. A Google account is therefore **mandatory for
the guardian of a video appointment** (product decision 2026-11-12). The AI scribe is not available on Meet calls
(risk 3, `docs/scribe.md`).

Code: `lib/google/**` (client, crypto, OAuth, connections, jobs, Meet helpers, recipients), `lib/notify/jobs.ts` +
`lib/notify/job-types.ts` (outbox job topics), `app/api/integrations/google/**`, `app/api/appointments/[id]/meet-link`,
`app/dashboard/settings/integrations`, `components/google/**`, `lib/booking/hooks.ts` (FR-5a).
Migration: `supabase/migrations/20261113003700_google_meet.sql`. Tests: `tests/google-meet.test.ts`.

## Flow

```
provider: /dashboard/settings/integrations -> Connect Google Calendar
  GET /api/integrations/google/connect        state + PKCE verifier sealed (AES-256-GCM) in an httpOnly cookie
  -> accounts.google.com consent (calendar.events + openid email, access_type=offline, prompt=consent, S256)
  -> GET /api/integrations/google/callback    state == sealed state AND same session user, code + verifier exchanged,
                                              refresh token encrypted -> provider_google_connections (audit, strict)
guardian (with a linked Google identity): hold + confirm a video slot
  booking_confirm (030, unchanged) enqueues appointment.confirmed
  -> trigger meet_jobs_from_outbox: meet.create (same transaction), appointments.meet_status = 'pending'
  -> outbox worker runs the job: refresh access token, look up event by private property, else events.insert
  -> appointments.meet_url / google_event_id / meet_status = 'created' + appointment.meet_ready (in-app, email, WhatsApp)
reschedule (030) -> appointment.rescheduled -> meet.update (events.patch: new time, same link, re-keyed to the new id)
cancel (030)     -> appointment.cancelled   -> meet.delete (events.delete)
```

## Data model

| Table / column | What |
|---|---|
| `provider_google_connections` | `provider_profile_id` (pk, cascade), `google_email`, `refresh_token_encrypted bytea`, `scopes text[]`, `connected_at`, `last_refreshed_at`, `status` `active` / `expired` / `revoked`, `connected_by`. RLS on, **no grants to `anon`/`authenticated`** (browsers never read it, not even the owner); the server reads it with the service role. `revoked` is reserved (disconnect deletes the row). |
| `appointments.meet_url` | `https://meet.google.com/<code>` (check constraint) |
| `appointments.google_event_id` | the event on the provider's primary calendar |
| `appointments.meet_status` | `not_needed` (in-clinic, set by a before-insert trigger), null (video hold not yet confirmed), `pending` (job queued), `created`, `failed` (after retries / not connected), `manual` (pasted by the provider). `created`/`manual` require a URL. Backfill: in-clinic -> `not_needed`, already-confirmed video -> `failed` (no calendar was connected before). A rescheduled video appointment inherits its predecessor's link, event id and status. |
| `outbox_job_attempts` | `event_id` (pk, cascade from `outbox_events`), `attempts`, `last_error` (one line, a code, no token), `updated_at` |

Token encryption (`lib/google/crypto.ts`): AES-256-GCM, key `TOKEN_ENCRYPTION_KEY` (32 bytes, base64), blob
`version || iv(12) || tag(16) || ciphertext`, AAD `google-refresh-token:v1:<provider_profile_id>` (a token copied to
another row does not decrypt). Any changed byte fails with `TokenDecryptError`. Rotating the key makes stored tokens
unreadable: the jobs then fail with `google_token_unreadable` and providers reconnect.

## Outbox job topics (`meet.create`, `meet.update`, `meet.delete`)

032's outbox fans events out to notification recipients. 037 adds **job topics**: `lib/notify/worker.ts` hands an event
whose topic is registered in `lib/notify/jobs.ts` to `runJob()` instead of fanning it out. The job runs inside the
fan-out transaction while the event row is locked (`for update skip locked`), so two workers never run it at once.

- A failed attempt records `outbox_job_attempts` and moves the event's `deliver_after` (1 min, 5 min, 15 min, 30 min);
  the event stays `pending`. Success or a final failure marks it `fanned_out`. 5 attempts in total.
- `JobError(code, permanent)` skips the remaining retries (not connected, `invalid_grant`, unreadable token, a 4xx
  from Google other than rate limits).
- `onFailure` runs in its own savepoint after the failed attempt rolled back (writes that must survive: `expired`
  connection + reconnect notice, `meet_status = 'failed'` + `appointment.meet_failed`).
- Dedup keys `meet:<appointment id>:create|update|delete` (outside `appt:<id>:`, so `booking_cancel`'s
  `outbox_cancel` never drops a job). The confirm / reschedule / cancel routes call `drainMeetJobs(id)` so the job runs
  right after the response (`after()`); the every-minute cron (`/api/cron/outbox`, locally `npm run -s outbox:run`)
  is the fallback.

Idempotency (D-2, rule 12): before inserting, `meet.create` lists events with
`privateExtendedProperty=dnm_appointment_id=<appointment id>`; the insert sets `conferenceData.createRequest.requestId =
<appointment id>` and that private property. A timed-out insert that did reach Google is found by the next attempt, so
retries never create a second event (`tests/google-meet.test.ts`: 3 timeouts, then success, exactly one event). If the
conference is still being created (`hangoutLink` missing) the job reads the event back once, otherwise retries.
A create job for an appointment that is no longer confirmed deletes any event an earlier attempt made.

Event body (FR-3, D-5): summary `DoctorNearMe video consultation`, description = the app link
(`<APP_URL>/dashboard/schedule`) + "admit the family from the waiting room", start/end in the clinic/provider time zone,
`visibility: private`, **no `attendees`**, `sendUpdates=none` on insert/patch/delete. No child name, no guardian email.

## Notifications

| Topic | When | Recipients (re-checked at fan-out) | Channels | Template |
|---|---|---|---|---|
| `appointment.meet_ready` | link created by `meet.create` or pasted by the provider (dedup `appt:<id>:meet_ready`, aggregate type `appointment_meet`) | booking guardian + profile provider while confirmed with a link | in-app, email, WhatsApp | `appointment_meet_ready` (points to the appointment page; the Meet URL itself is never in a message) |
| `appointment.meet_failed` | final failure (dedup `appt:<id>:meet_failed`) | profile provider while confirmed and still `failed` | in-app, email | `appointment_meet_failed` (`Add a video link`) |
| `google_calendar.reconnect_required` | `invalid_grant` on refresh (dedup `google:<profile>:expired:<connected_at>`) | profile provider while the connection is still `expired` | in-app, email | `google_calendar_reconnect` (`Reconnect Google Calendar`, links to the integrations page) |

## FR-5a: Google account required for video

`lib/booking/hooks.ts`: `checkHoldPreconditions()` (called by `POST /api/appointments/hold`) and
`checkConfirmPreconditions()` (called by `POST /api/appointments/:id/confirm` for a hold the caller owns) return 422
`{ error: "Link your Google account to book a video consultation", code: "google_account_required" }` for a `video`
service unless the signed-in guardian has a Google identity in `auth.identities` (019 `linkIdentity`, or a Google
sign-in). Anonymous video holds get the same 422 (sign in with Google first). In-clinic services are unaffected.
**034 (voice agent) must call both hooks too.** The booking page shows the text before slot selection with `Connect
Google` (`/family/settings`, 019's account page) or `Sign in` for anonymous visitors.

## Join window and manual links (FR-4, FR-5)

- `Join video call` (`components/google/MeetPanel.tsx`, server-rendered): guardian on `/family/appointments`, provider
  on the `/dashboard/schedule` agenda, from **10 minutes before the start until 30 minutes after the end**. The Meet URL
  is only sent to the browser inside that window. Guardian text: `Join with your Google account. The provider will
  admit you from the waiting room.`
- `pending` / `failed`: guardian sees `Your provider will share the video link soon.`; provider sees `Creating the
  Google Meet link…` or `We could not create a Google Meet link.` + `Add a video link`.
- `POST /api/appointments/:id/meet-link { url }`: provider side (profile owner or an org owner/admin, 030's rule);
  `https://meet.google.com/<code>` only (normalised, query dropped), else 400; other providers' appointments 404;
  not a confirmed video appointment in `failed`/`manual` 409. Sets `manual`, notifies once (`appointment.meet_ready`),
  strict audit `appointment.meet_link_set`.

## APIs

| Method + path | Who | Result |
|---|---|---|
| `GET /api/integrations/google/connect` | provider with a profile | 303 to Google (or the demo consent stand-in), sets `dnm_google_oauth` (httpOnly, `Path=/api/integrations/google`, 10 min) |
| `GET /api/integrations/google/callback?code&state` | the same provider | 303 `/dashboard/settings/integrations?connected=1`, or `?error=state|denied|exchange|no_refresh_token|scope|unavailable` (nothing stored) |
| `POST /api/integrations/google/disconnect` | provider | 200 `{ disconnected: true, revoked }` (token revoked at Google, row deleted, strict audit `google_calendar.disconnected`); 404 when not connected |
| `GET /api/integrations/google/connection[?profile_id=]` | provider | 200 `{ available, connection: { google_email, scopes, status, connected_at, last_refreshed_at } \| null }`; another profile id 404 |
| `GET /api/integrations/google/demo-authorize` | provider, demo backend only | 303 back to the callback with a one-time code bound to the PKCE challenge; 404 otherwise |
| `POST /api/appointments/:id/meet-link` | appointment's provider side | see above |

Strict audit (`lib/audit/strict-actions.ts`): `google_calendar.connected`, `google_calendar.disconnected`,
`appointment.meet_link_set`. Details never contain tokens or email addresses.

## Backends and environment

| Variable | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | both set -> **live** backend (real Google over HTTPS) |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`); required to connect (also in demo) |
| `DEMO_MODE=true` without a client | **demo** backend: an in-process fake Google (instant consent redirect, fake `https://meet.google.com/xxx-xxxx-xxx` links, nothing leaves the machine). The integrations page says so. |
| neither | **off**: `Connect Google Calendar` is unavailable; every video appointment ends `failed` and the provider pastes a link |

Redirect URI: `<NEXT_PUBLIC_APP_URL>/api/integrations/google/callback`. Google calls (`lib/google/client.ts`) time out
after 10 s; 401/429/5xx and rate-limit 403s are retried, other 4xx are permanent. NFR-1: refresh tokens are decrypted
only on the server (the outbox worker; `disconnectGoogle` to revoke), never logged, never in an API response, a page,
an audit row or `last_error` (logs carry ids and error codes; `tests/google-meet.test.ts` captures every log line).

## Google Cloud setup (human task, plan §6, risk 4)

1. Google Cloud console -> new project `DoctorNearMe` (or the existing one) -> **APIs & Services -> Library -> Google
   Calendar API -> Enable**.
2. **OAuth consent screen** (Google Auth Platform -> Branding / Audience / Data access): user type **External**; app
   name `DoctorNearMe`, support email, logo, app home page, **privacy policy URL** (`<APP_URL>/privacy`), terms URL,
   authorised domain = the production domain (verified in Google Search Console). Scopes: `openid`, `.../auth/userinfo.email`
   and `https://www.googleapis.com/auth/calendar.events` (**sensitive**).
3. **Credentials -> Create OAuth client ID -> Web application**: authorised redirect URIs
   `https://<app-domain>/api/integrations/google/callback` and, for local tests with a real account,
   `http://localhost:3000/api/integrations/google/callback`. Put the client id/secret in Vercel (Production) as
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, plus `TOKEN_ENCRYPTION_KEY`.
4. While the app is in **Testing**: add each pilot provider's Google account under **Audience -> Test users (max
   100)**. Refresh tokens of apps in Testing (and of unverified apps) **expire after 7 days**: the next Meet job gets
   `invalid_grant`, the connection becomes `expired` and the provider is told `Reconnect Google Calendar`.
5. **Publish** and submit for **verification** of the sensitive scope as early as possible: Google asks for the
   verified domain, the privacy policy describing Calendar use, a scope justification ("create a Google Calendar event
   with a Meet link for the provider's own video appointments; no attendees are added; events are deleted when the
   appointment is cancelled") and a **demo video** of the consent flow and the feature. Lead time is typically
   **several weeks** (reviews can bounce back with questions); until approved, keep to <= 100 test users (NFR-2).
   Calendar-only sensitive scopes do not need the paid CASA security assessment required for restricted scopes.
6. Google Workspace providers: their admin must allow third-party apps to access Calendar (Admin console -> Security ->
   API controls) and allow external participants in Meet, otherwise families cannot be admitted.
7. **Manual smoke test** with a real test account (not automated): connect, book a video slot with a guardian that
   signed in with Google, check the event in Google Calendar (no guests, no notification email), join from both sides,
   admit from the lobby, reschedule (event moves, same link), cancel (event removed), disconnect (app removed from
   <https://myaccount.google.com/permissions>).

## Limitations and follow-ups

- Guardians without a Google account cannot book video (decision D-4); built-in WebRTC is out of scope.
- A failed `meet.update` keeps the old time on the provider's calendar (the link keeps working); a failed
  `meet.delete` leaves the event (admins see `outbox_job_attempts.last_error`).
- Meet links are not time-bound by Google: anyone with the link could knock; the provider admits only the family.
