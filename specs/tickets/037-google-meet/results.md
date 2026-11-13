# 037: Google Meet for video appointments - Results

Branch: `ticket/037-google-meet` (base: 017-030, 032, 038, 041 merged). Tested against the isolated local Supabase stack
of worker slot 4 (`dnmslot4`, all 25 migrations applied by `supabase db reset`), `DEMO_MODE=true`, dev server on port
3040 with `CRON_SECRET=test-3040` and a random test `TOKEN_ENCRYPTION_KEY`, own headless Chromium (playwright-core in
the git-ignored `.tmp/`, 375x812, Asia/Kolkata). No Google OAuth client exists locally: automated tests use the **live**
client against an HTTP mock of `oauth2.googleapis.com` / `www.googleapis.com/calendar/v3`; the browser run uses the
**demo** backend (in-process fake Google). Synthetic accounts (`seed:users --prefix e037`, `t037*` test users) and
synthetic providers/children only. Evidence: `evidence/acceptance.txt` (37 browser/DB checks, all PASS, plus hi/te 375 px and curl checks),
`evidence/google-meet-tests-verbose.txt`, screenshots `evidence/*.png`.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, `vitest run`, build) | PASS | exit 0; vitest 77 files, 1206 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl); every DB suite ran |
| `npx vitest run tests/google-meet.test.ts --reporter=verbose` | PASS | 19 passed (`evidence/google-meet-tests-verbose.txt`) |
| Token encryption round-trip and tamper detection | PASS | AES-256-GCM round-trip, plaintext absent from the blob, fresh IV; a flipped byte (version, IV, tag, ciphertext), another row's AAD, another key or a truncated blob -> `TokenDecryptError`; non-32-byte keys refused |
| OAuth `state` mismatch rejected | PASS | unit: wrong / missing state, another user, tampered or expired (10 min) cookie; route: forged state and provider A replaying provider B's cookie+state -> 303 `?error=state`, token endpoint never called, no row stored |
| `meet.create` retried 3x after timeouts creates exactly one event | PASS | attempt 1: insert reaches Google but times out; attempts 2-3: lookup times out (`events_list_timeout`, `pending`, back-off); attempt 4 finds the event by `privateExtendedProperty=dnm_appointment_id=<id>` -> `created`, 1 event, 1 insert call, `outbox_job_attempts.attempts = 4`; a further run does nothing |
| Reschedule patches, cancel deletes | PASS | reschedule: new appointment inherits link + event id, `meet.update` -> one `PATCH .../events/<id>?sendUpdates=none` with the new time and the property re-keyed to the new id, no new insert, no delete for the old half; cancel -> one `DELETE ...?sendUpdates=none`, event gone, `google_event_id` cleared. Cancel before the link existed: the create job removes the event a timed-out attempt had made |
| `invalid_grant` -> `expired` + notification | PASS | refresh 400 `invalid_grant` -> connection `expired`, job final at attempt 1 (`google_token_expired`), appointment `failed`; provider gets `Reconnect Google Calendar` (in-app + email, link `/dashboard/settings/integrations`) and `Add a video link` (`appointment.meet_failed`); reconnecting makes it `active` again |
| Event summary/description contain no child name | PASS | insert body: summary `DoctorNearMe video consultation`, description = app link + lobby hint, no child name, no guardian email; `requestId` and private property = appointment id |
| E-1 Connect and create (FR-2, FR-3, FR-5) | PASS | browser: `/dashboard/settings` -> `Google Calendar for video appointments` -> `Connect Google Calendar` -> (demo consent) -> `Google Calendar connected.` / `Connected as calendar.demo@example.test` (row `active`, 90-byte ciphertext, no plaintext); guardian_a books a video slot -> `meet.create` drained by `after()` -> `meet_status = created`, `meet_url = https://meet.google.com/zxu-msbm-zyd`; `appointment.meet_ready` in-app + email to guardian and provider (WhatsApp `skipped`). Time travel: before the window no `Join video call` and the URL is not in the page; start in 5 min -> guardian (`/family/appointments`) and provider (agenda) see `Join video call` (`href` = Meet URL, `rel="noopener noreferrer"`) + `Join with your Google account. The provider will admit you from the waiting room.`; 40 min after the end -> gone. Automated: same flow through the routes with the HTTP mock |
| E-1a Google account and guest privacy (FR-3, FR-5a) | PASS | phone-only guardian_a: booking page (video service) shows `Link your Google account to book a video consultation` + `Connect Google`, no slot picker; `POST /api/appointments/hold` -> 422 `{ error: "Link your Google account to book a video consultation", code: "google_account_required" }` (anonymous too); in-clinic slot books normally (`not_needed`); after linking Google the video hold + confirm succeed; unlinking between hold and confirm -> confirm 422. The mocked `events.insert` has no `attendees` and `sendUpdates=none` (+ `conferenceDataVersion=1`) |
| E-2 Failure path (FR-4) | PASS | `Disconnect` -> `Google Calendar disconnected.`, token revoked at Google (mock) and row deleted (audit `google_calendar.disconnected`); next booking -> `failed` (`google_not_connected`); guardian sees `Your provider will share the video link soon.`; provider sees `We could not create a Google Meet link.` + `Add a video link`; `https://zoom.us/j/123456` -> 400 with `Paste a Google Meet link (https://meet.google.com/...).`; a Meet URL -> `manual`, guardian sees `Join video call` with it (in the window); in-clinic appointment -> 409 |
| E-3 Authz and secrecy (NFR-1) | PASS | provider_b: `GET /api/integrations/google/connection?profile_id=<A>` 404, `POST /api/appointments/<A's>/meet-link` 404 (link unchanged); guardians 403; anonymous connect/callback/demo-authorize 401. 51 browser responses (bodies + headers) and the 217-line dev log contain no Google refresh token; automated: no token in any route response, audit row or captured log line; the connection API returns email/scopes/status/dates only |
| i18n / 375 px | PASS | new `integrations` namespace + `booking.meet.*`, `booking.flow.google*`, `booking.errors.google_account_required`, privacy notice rows, in en/hi/te (Google product names kept); `messages/REVIEW.md` regenerated (2059 rows); integrations, settings, booking (video notice) and family appointments without horizontal scroll at 375 px in en/hi/te |
| Privacy registry (041) | PASS | category `google_meet` (`provider_google_connections`, `appointments.meet_url/google_event_id/meet_status`, `outbox_job_attempts`; processors Supabase + Google; export = Meet links of the guardian's own video bookings); processor `google` on `/privacy` + `docs/privacy/processors.md`; strict audit `google_calendar.connected` / `.disconnected` / `appointment.meet_link_set` (041 static test covers them) |

## Deviations

- **No Google credentials locally.** OAuth, token refresh/revoke and Calendar calls are behind `GoogleApi`
  (`lib/google/client.ts`). Tests exercise the real HTTPS client against an HTTP mock; the dev server uses a demo backend
  (`DEMO_MODE` without `GOOGLE_OAUTH_CLIENT_ID`): `GET /api/integrations/google/demo-authorize` stands in for Google's
  consent screen (one-time code bound to the PKCE challenge) and fake Meet links are generated in-process. A live OAuth +
  Meet check with a real test Google account remains a **manual human smoke test** (`docs/google-meet.md`).
- **Guardian Google linking in the browser run.** Google sign-in is off on local Supabase (019), so `linkIdentity` cannot
  complete locally; the acceptance run inserted the `auth.identities` row that `linkIdentity` creates (the server check
  reads exactly that table). Tests do the same (`tests/helpers/booking.ts` `linkGoogle`).
- **Outbox job topics.** 032's outbox only fans out notifications. `meet.create` / `meet.update` / `meet.delete` are a new
  kind of outbox topic run by the existing worker (`lib/notify/jobs.ts`, a 3-line hook in `fanOutEvent`), with attempts in
  a new `outbox_job_attempts` table and back-off via `deliver_after` (5 attempts: +1, +5, +15, +30 min). The 030 state
  machine is untouched: a trigger on `outbox_events` turns its `appointment.confirmed` / `.rescheduled` / `.cancelled`
  events for video appointments into the jobs in the same transaction (this also covers 031's payment confirmation and
  041's erasure cancellations).
- **Reschedule keeps the event.** 030's reschedule creates a new appointment row; it inherits the old one's link and event
  (before-insert trigger) and `meet.update` patches the event and re-keys its private property to the new id, so the
  guardian keeps the same link. Idempotency key = the appointment id (D-2) of the appointment that created the event.
- **Scopes `openid email`** are requested besides `calendar.events`, only to show which Google account is connected
  (`Connected as ...`); no other Google data is read.
- **Notifications never carry the Meet URL** (032 content rule: links point to the signed-in app page); D-5's "join link
  only inside DoctorNearMe and notifications" is met by `appointment.meet_ready` pointing to the appointment page, where
  `Join video call` appears in the join window. Extra provider notices `appointment.meet_failed` (`Add a video link`) and
  `google_calendar.reconnect_required` (FR-2's `Reconnect Google Calendar`).
- **Refresh tokens are decrypted** in the outbox worker and, to revoke them, in `disconnectGoogle` (server-side); never
  in a browser response, page, audit row, `last_error` or log (NFR-1).
- **`meet_status`** is null for video holds that are not confirmed yet (the check allows null); legacy confirmed video
  appointments are backfilled `failed` so providers can add a link. `revoked` is reserved (disconnect deletes the row).
- **Join window is rendered on the server** at request time (the URL never reaches the page before the window); a page
  left open needs a refresh to show the button.

## Notes

- **Migration** `20261113003700_google_meet.sql` (additive): `provider_google_connections` (RLS on, no browser grants),
  `appointments.meet_url/google_event_id/meet_status` (+ backfill, checks, before-insert defaults trigger),
  `outbox_job_attempts`, trigger `outbox_events_meet_jobs` (`meet_jobs_from_outbox()`).
- **New code:** `lib/google/{client,crypto,oauth,connections,meet,jobs,recipients}.ts`, `lib/notify/{jobs,job-types}.ts`,
  routes `app/api/integrations/google/{connect,callback,disconnect,connection,demo-authorize}`,
  `app/api/appointments/[id]/meet-link`, page `app/dashboard/settings/integrations`, `components/google/*`, templates
  `appointment_meet_ready`, `appointment_meet_failed`, `google_calendar_reconnect`, `tests/google-meet.test.ts`,
  `docs/google-meet.md`.
- **Shared files touched additively:** `lib/notify/worker.ts` (job hook), `lib/notify/topics.ts` (+3 topics),
  `lib/notify/templates/index.ts`, `lib/booking/hooks.ts` (FR-5a, + `checkConfirmPreconditions`), confirm / cancel /
  reschedule routes (confirm precondition + `drainMeetJobs`), `app/book/[profileId]/page.tsx` + `BookingFlow`
  (Google notice), `app/family/(portal)/appointments/page.tsx`, `app/dashboard/schedule/page.tsx` (`MeetPanel`),
  `app/dashboard/settings/page.tsx` (link), `app/privacy/page.tsx`, `lib/privacy/registry.ts` (`google` processor +
  category), `lib/audit/strict-actions.ts` (+3), `lib/env.ts`, `.env.example`, `messages/*`, `tests/notify-templates.test.ts`
  (topic list + samples), `tests/helpers/booking.ts` (`linkGoogle`, cleanup of meet events), `tests/booking-state-machine.test.ts`
  (its video booking links Google first), docs (`booking.md`, `notifications.md`, `system-design.md`, `privacy/*`).
- **Env vars (names only):** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`.
- **For 034 (voice booking):** call `checkHoldPreconditions()` before `holdSlot` and `checkConfirmPreconditions()` before
  confirming: video needs a guardian with a linked Google identity (422 `google_account_required`).
- **For 031 (payments):** nothing to do: `booking_enqueue_confirmed` emits `appointment.confirmed`, which queues
  `meet.create` for video appointments.
- **For later job-like work:** register a job topic in `lib/notify/jobs.ts` (see `docs/notifications.md`, "Job topics").
- **Human tasks (start now):** Google Cloud OAuth client, consent screen with the sensitive `calendar.events` scope,
  test users (max 100; 7-day tokens until verified) and the OAuth verification submission (weeks of lead time) -
  `docs/google-meet.md`; WhatsApp template `appointment_meet_ready` for Meta.
- The E2E data (`e037-*` accounts, their profiles, appointments) is left in the slot 4 database; test suites clean up
  after themselves.

## Merge with `main` (031 Razorpay test mode, 033 voice screen)

- `git merge main`. Conflicts resolved keeping both sides: `lib/notify/topics.ts`, `lib/notify/templates/index.ts`,
  `tests/notify-templates.test.ts` (031's `payment.refunded` + 037's three topics), `lib/audit/strict-actions.ts`
  (`payment.captured` + 037's three), `lib/privacy/registry.ts` (`Processor` includes `razorpay` and `google`),
  `app/privacy/page.tsx` (collect `screen`, `videoCalls`, `payments`; processors `razorpay`, `google`),
  `app/dashboard/schedule/page.tsx` (payment labels + Meet panel), `messages/{en,hi,te}.json` (deep-merged, no value
  clashes; `messages/REVIEW.md` regenerated with `npx tsx scripts/i18n-review.ts`, 2216 rows), `docs/notifications.md`,
  `docs/privacy/processors.md`, `docs/system-design.md`. `lib/booking/hooks.ts`, `lib/csp.ts`, `lib/env.ts`, `.env.example`,
  `vercel.json`, `tests/no-tracking.test.ts` merged automatically.
- **Paid video appointments (031):** verified by a new test in `tests/google-meet.test.ts`: online video service -> hold
  -> confirm (`pending_payment`, no Meet job, `meet_status` null) -> payment order -> demo checkout -> `POST
  /api/payments/verify` -> `confirmed` + `captured`; the capture's `appointment.confirmed` (030
  `booking_enqueue_confirmed`) queues `meet.create` in the same transaction -> job -> `created`, one event, no attendees.
  The verify route now also calls `drainMeetJobs()` (one additive line); webhook captures are picked up by the cron.
- Test cleanup: `tests/helpers/booking.ts` deletes an appointment's `payments` before the appointment (031 blocks
  appointment deletes); `tests/google-meet.test.ts` purges its payment outbox/audit rows.
- After `dnm-db.sh 4 <worktree> reset` (all 27 migrations): `npm run lint` exit 0, `npm run typecheck` exit 0,
  `npx vitest run` 81 files, 1310 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live
  no-tracking crawl; every DB suite ran, incl. 031's `payments-flow`), `npm run build` exit 0,
  `npx vitest run tests/google-meet.test.ts` 20 passed.
- For 034: `checkHoldPreconditions()` / `checkConfirmPreconditions()` in `lib/booking/hooks.ts` are unchanged by the merge.
