# Notifications (ticket 032)

Every user-facing notification (messages, shared documents, published plans, later bookings, reminders,
payments, Meet links) goes through one **transactional outbox**. The domain write and its outbox event commit
in the same transaction; a scheduler fans the event out into per-recipient, per-channel deliveries and sends
them with retries, back-off, de-duplication and scheduled send times.

```
domain write + outbox_enqueue()  ──commit──►  outbox_events (pending, deliver_after)
                                                    │  fan-out (cron / after() / outbox:run)
                                                    ▼  recipients re-checked, template rendered
                                          notifications (one row per recipient x channel)
                                             in_app ─► sent at fan-out (bell, /notifications)
                                             email  ─► Resend (+ .ics, Idempotency-Key)
                                             whatsapp ─► Meta Cloud API template (skipped until configured)
```

Code: `lib/notify/**`. Migration: `supabase/migrations/20261113003200_outbox.sql`.

## Data model

| Table | Purpose |
|-------|---------|
| `outbox_events` | `id bigint`, `topic`, `aggregate_type`, `aggregate_id uuid`, `payload jsonb` (ids only, max 8 KB), `dedup_key text unique`, `deliver_after`, `status` `pending` / `fanned_out` / `cancelled`, `fanned_out_at` |
| `notifications` | one row per `(event_id, recipient_user_id, channel)` (unique). `status` `pending` / `sending` / `sent` / `failed` / `dead` / `skipped` / `cancelled`, `attempts`, `next_attempt_at`, `locked_until` (lease), `last_error` (max 500 chars, no payload), `provider_message_id`, rendered `title` / `body` / `link`, `read_at` (in-app), `sent_at`, `last_attempt_at` |
| `notification_preferences` | `(user_id, channel)` with `channel` `email` / `whatsapp`, `enabled`. No row = default: **email on, WhatsApp off** (WhatsApp is opt-in, as Meta requires for business-initiated messages). In-app cannot be disabled |

RLS is on for all three. Browsers (later Realtime) can read only their own in-app rows and their own
preferences; everything else goes through the service role on the server.

SQL functions (service role only):

| Function | Use |
|----------|-----|
| `outbox_enqueue(topic, aggregate_type, aggregate_id, payload, dedup_key, deliver_after)` | returns the event id, or the existing id when the dedup key is taken (`on conflict do nothing`) |
| `outbox_cancel(dedup_key_prefix)` | pending events with that key prefix -> `cancelled`, plus every `pending`/`failed` notification of matching events. Returns the number of events cancelled. `%` and `_` in the prefix are literal |
| `outbox_has_due_work()` | the cron's cheap first check (indexed `exists`) |
| `outbox_claim_events(batch, event_ids?)` | due events, `for update skip locked` (held until the fan-out transaction ends) |
| `notifications_claim(batch, lease_seconds, event_ids?, max_attempts)` | due email/WhatsApp rows -> `sending`, `attempts + 1`, `locked_until = now + lease`; expired leases are claimable again |
| `notification_complete(id, lease, status, provider_message_id, error, next_attempt_at)` | records an outcome only while the caller still holds that lease; `dead` writes audit `notification.dead` in the same transaction |
| `notification_retry(id, admin)` | admin `Retry`: `dead` -> `pending`, audit `notification.retried` |

## Producing events (the transaction rule)

**The event must commit with the domain write.** Pick one of:

1. **TypeScript with a real transaction** (preferred): use the shared pool in `lib/pg.ts`.

   ```ts
   import { pg } from "@/lib/pg";
   import { drainSoon, enqueue } from "@/lib/notify/outbox";

   const sql = await pg();
   const eventId = await sql.begin(async (tx) => {
     const [doc] = await tx`insert into documents ... returning id, child_id`;
     return enqueue(tx, {
       topic: "document.shared_with_guardian",
       aggregateType: "document",
       aggregateId: doc.id,
       payload: { document_id: doc.id, child_id: doc.child_id },
       dedupKey: `document.shared:${doc.id}`,
     });
   });
   drainSoon([eventId]); // deliver right after this response (Next.js after())
   ```

2. **SQL security-definer functions** (multi-step writes, e.g. booking): call it inside the function, which is
   already one transaction.

   ```sql
   perform public.outbox_enqueue('appointment.confirmed', 'appointment', v_appt.id,
     jsonb_build_object('appointment_id', v_appt.id), 'appt:' || v_appt.id || ':confirmed', now());
   perform public.outbox_enqueue('appointment.reminder_24h', 'appointment', v_appt.id,
     jsonb_build_object('appointment_id', v_appt.id), 'appt:' || v_appt.id || ':r24',
     v_appt.starts_at - interval '24 hours');
   ```

   Triggers work too: 022's `sharing.granted` (trigger on `sharing_grants`) and 028's provider decisions (`provider.verified` / `.rejected` / `.suspended` / `.claimed`)
   are enqueued by triggers on `credential_submissions` and `provider_profiles` in the deciding transaction;
   the TypeScript caller only calls `drainSoon()`.

3. **Service-role JS code without a transaction** (supabase-js writes): `await enqueueEvent({...})` right after
   the write succeeded. It validates the payload, calls `outbox_enqueue` through RPC and schedules
   `drainSoon` (pass `{ drain: false }` to skip). The dedup key makes retrying the whole action safe. Use this
   only when the write itself cannot move into `sql.begin` or a SQL function.

Rules:

- **Dedup keys** are unique per logical event: `<entity>:<id>[:<suffix>]`, e.g. `message:<id>`,
  `appt:<id>:r24`. Group keys you may want to cancel under one prefix (`appt:<id>:`), then
  `cancelEvents("appt:<id>:")` / `outbox_cancel('appt:<id>:')`.
- **Scheduled** events: `deliverAfter` / `deliver_after`. Nothing is fanned out before that time.
- **Payloads carry ids** (and small non-clinical values). Each topic has a strict zod schema; unknown keys
  (names, notes, scores) are rejected at enqueue.
- `drainSoon(eventIds?)` never throws and never delays the response; outside a request (scripts, tests) it
  does nothing and the cron delivers instead.

## Adding a topic

1. **Template**: `lib/notify/templates/<template>.ts` with `defineTemplate({ name, strings: { en, hi, te },
   link(ctx), ics?(ctx), whatsapp? })`; register it in `lib/notify/templates/index.ts`. `strings` hold
   `title` + `body` per locale; `link(ctx)` returns an **app path** (guardians and providers can get different
   pages via `ctx.role`); `ics(ctx)` returns `{ method, start, end, summary, ... }` for calendar invites;
   `whatsapp: false` when there is no approved Meta template (in-app + email only).
2. **Topic**: add an entry to `TOPICS` in `lib/notify/topics.ts`: strict `payload` schema, `channels`,
   `template`, and `recipients(payload, { sql, event })`. Recipients run **at fan-out time inside the fan-out
   transaction** and must re-check access (helpers in `lib/notify/recipients.ts`: `activeGuardians`,
   `childAccessFilter`, `caseProviders`, `orgMembers`, `activeGrantRecipients`, `profileOwner`). Users who lost access get no row.
3. **Emit** it as above. Add a test that renders the template in en/hi/te (`tests/notify-templates.test.ts`
   loops over every topic: add a sample payload there).
4. **WhatsApp**: if the template has WhatsApp, add it to the Meta list below and submit it.

### Content rule (D-5, DPDP minimisation)

Email and WhatsApp never carry clinical content (no answers, scores, conditions, report text, message
bodies, document titles) and never a child's name. Default wording is "your child". A template may use a
child's **first name** only if its ticket says so explicitly. Links always point to the signed-in app page.
`tests/notify-templates.test.ts` checks every template in every locale against a deny list (`autism`,
`ISAA`, `diagnos`, `score`) and a sample child name. Hindi and Telugu template text is a first draft by the
worker that built 032 and needs native review with the rest of `messages/REVIEW.md` before the pilot.

## Topics registered by 032

| Topic | Recipients (re-checked at fan-out) | Channels | Template |
|-------|------------------------------------|----------|----------|
| `test.ping` (dev / DEMO_MODE only) | the user `aggregate_id` | in-app, email, WhatsApp | `test_ping` (optional `ics_start` adds an invite) |
| `message.created` (027, enqueued by `create_message_thread` / `send_thread_message` in the sending transaction, `deliver_after` = +2 min, aggregate = the thread, payload `{ message_id }`) | the child's active guardians, the case's assigned care team and anyone who started or wrote in the thread, still with access, minus the sender and anyone who read the thread at or after the message; nobody once the message is deleted (`docs/messaging.md`) | in-app, email, WhatsApp | `message_created` (links to `/family/messages/<thread>` or `/dashboard/messages/<thread>`) |
| `document.shared_with_guardian` (023, enqueued by `complete_document` / `set_document_visibility` in the same transaction) | active guardians of the child, only while the document is still a ready, guardian-visible provider upload of that child | in-app, email | `document_shared` |
| `iep.published` (025, enqueued by `publishPlan` in the publishing transaction, dedup `iep:<plan id>:v<published version>`) | active guardians of the child | in-app, email, WhatsApp | `iep_published` (links to `/family/children/<id>/plan`) |
| `home_program.published` (026, enqueued by `publishProgram` in the publishing transaction, dedup `home_program:<program id>:v<published version>`) | active guardians of the child | in-app, email, WhatsApp | `home_program_published` (links to `/family/children/<id>/home-program`) |
| `assessment.assigned` (024, enqueued by `createAssessment`) | the assigned guardian only, while the questionnaire is open and their link active | in-app, email, WhatsApp | `assessment_assigned` |
| `assessment.red_flag` (024) | providers who can access the case under 022's rule (org owners/admins + assigned care team; optionally only `recipient_user_ids`) | in-app, email | `assessment_red_flag` |
| `assessment.submitted` (024, enqueued by `submitAssessment`) | providers who can access the case under 022's rule | in-app, email | `assessment_submitted` |
| `sharing.granted` (022, enqueued by a trigger on `sharing_grants` inside `create_sharing_grant`) | active owners/admins of the grantee org, only while the grant is in force (not revoked/expired, child live) and the granting guardian's link is active; org and child read from the grant row | in-app, email | `sharing_granted` (links to the grantee case's `Shared with us` tab) |
| `provider.verified` / `.rejected` / `.suspended` / `.claimed` (028) | the provider bound to the profile | in-app, email | `provider_*` |
| `prescription.signed` / `prescription.voided` (039, enqueued by `signPrescription` / `voidPrescription` in the same transaction, dedup `prescription:<id>:signed` / `:void`) | active guardians of the live child, while the prescription is still in that state and its latest published version is guardian-visible | in-app, email | `prescription_signed` / `prescription_voided` (generic text, no medicine names; links to `/family/children/<id>/prescriptions`) |
| `privacy.export_ready` (041, enqueued with the export's `ready` update) | the requesting guardian, while still linked to the live child and the export is ready | in-app, email | `privacy_export_ready` (links to the child's Privacy page) |
| `privacy.deletion_requested` (041) | platform admins | in-app, email | `privacy_deletion_requested` |
| `appointment.confirmed` / `.reminder_day_before` / `.reminder_two_hours` / `.cancelled` / `.rescheduled` (030, enqueued by the booking SQL functions; dedup `appt:<id>:confirmed` / `:r24` / `:r2` / `:cancelled` / `:rescheduled`, cancelled with `outbox_cancel('appt:<id>:')`) | the booking guardian + the provider bound to the profile (reminders: guardian only), while the appointment is still in the matching status | in-app, email, WhatsApp | `appointment_*` (email `.ics` REQUEST / CANCEL; provider name, time in the clinic's zone, mode, place - never the child; see `docs/booking.md`) |
| `appointment.intake_link` (035, enqueued by the `consent.granted` consumer when a guardian allows the AI intake call after booking; aggregate = the intake attempt, dedup `appt:<id>:intake_link:<attempt>`; payload = 030's appointment values + `intake_attempt_id`) | the booking guardian, while the appointment is confirmed and the attempt still active | in-app, email, WhatsApp | `appointment_intake_link` (in-app/email carry `<APP_URL>/intake/a/<token>`, re-derived from the attempt id; WhatsApp {{1}} = `/family/appointments`) |
| `appointment.meet_ready` (037, enqueued by the `meet.create` job or a manual link; dedup `appt:<id>:meet_ready`) | booking guardian + profile provider while the appointment is confirmed and has a link | in-app, email, WhatsApp | `appointment_meet_ready` (app page only, never the Meet URL) |
| `appointment.meet_failed` (037, final `meet.create` failure) | profile provider while still `failed` | in-app, email | `appointment_meet_failed` (`Add a video link`) |
| `google_calendar.reconnect_required` (037, `invalid_grant` on refresh) | profile provider while the connection is `expired` | in-app, email | `google_calendar_reconnect` |
| `payment.refunded` (031, enqueued by `payment_mark_refunded` in the refunding transaction, dedup `payment:<id>:refunded`, payload `{ payment_id, appointment_id, reason }`) | the booking guardian, while the payment is refunded | in-app, email | `payment_refunded` (`Your payment was refunded because the time was no longer available.` for late payments; links to `/family/appointments`; see `docs/payments.md`) |
| `privacy.deletion_completed` / `privacy.deletion_rejected` (041) | the requesting guardian (account only: the erasure revokes the link) | in-app, email | `privacy_deletion_completed` / `privacy_deletion_rejected` (reason shown in the app only) |

Later tickets register their own (030 done: `appointment.*` with `.ics`; 031 payments; 037 done: Meet links). Topic names
allow no digits (`outbox_events_topic_check`), so 030's 24 h / 2 h reminders are `appointment.reminder_day_before` /
`appointment.reminder_two_hours`.

## Consumers (035)

Some events also drive domain work. `lib/notify/consumers.ts` maps a topic to consumers that run in the fan-out
transaction **before** recipients and templates (`runConsumers` in `fanOutEvent`). A consumer may return an enriched
payload (ids and small non-clinical values only); the worker stores it on the event, so later email/WhatsApp
renders use the same values. A throwing consumer rolls back the event's savepoint: the event stays `pending` and is
retried by the next run, so consumers must be idempotent.

| Topic | Consumer | Work |
|-------|----------|------|
| `appointment.confirmed`, `appointment.rescheduled` | `appointment.link_case` | appointment -> org case + provider assignment + intake attempt; adds `intake` (`{ status: "link", attempt_id, agent_kind }` or `{ status: "consent_needed", agent_kind }`) so the guardian's confirmation carries the call link or the consent hint |
| `consent.granted` (consumer-only, enqueued by a trigger on `consent_records` for `ai_intake_call` grants that can serve an upcoming appointment) | `appointment.intake_on_consent` | issues the missing intake attempts and enqueues `appointment.intake_link` |

## Job topics (037)

Some events run server work instead of notifying anyone. Register a **job topic** in `lib/notify/jobs.ts`
(`JobDefinition` from `lib/notify/job-types.ts`: strict `payload`, `maxAttempts`, `retryDelaysMs`, `run`, optional
`onFailure`); the worker (`fanOutEvent`) hands those events to `runJob()` inside the fan-out transaction while the event
row is locked. Attempts and the last error code are kept in `outbox_job_attempts`; a failed attempt moves
`deliver_after` (back-off) and keeps the event `pending`; success or a final failure marks it `fanned_out`. Throw
`JobError(code, true)` to stop retrying. Job topics are not in `TOPICS` (no recipients, no template) and are enqueued
from SQL. In use: `meet.create`, `meet.update`, `meet.delete` (037), enqueued by the `meet_jobs_from_outbox` trigger
when the booking functions insert `appointment.confirmed` / `.rescheduled` / `.cancelled` for a video appointment
(dedup `meet:<id>:create|update|delete`). See `docs/google-meet.md`.

## Delivery

| Channel | Adapter | Outcomes |
|---------|---------|----------|
| `in_app` | written as `sent` at fan-out | bell `Notifications, <n> unread`, `/notifications` |
| `email` | `lib/notify/email.ts` -> `lib/email.ts` (Resend) | `skipped` `opted_out` (preference off) / `no_email` (no address, or the hidden `*.invalid` login address of phone-only accounts); `sent` with the Resend id; `DEMO_MODE` keeps the existing behaviour (nothing sent, `sent` with provider id `demo`). Sends `Idempotency-Key: notification:<id>`. `.ics` attachment `invite.ics` (`text/calendar; method=REQUEST`), `UID` = `<aggregate_type>-<aggregate_id>@doctornearme` (stable per aggregate), `SEQUENCE` = number of earlier events for the same aggregate |
| `whatsapp` | `lib/notify/whatsapp.ts` (`POST https://graph.facebook.com/<WHATSAPP_API_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages`, template + body params) | `skipped` `whatsapp_not_configured` (no token / phone number id, or `DEMO_MODE`), `opted_out`, `no_phone` (no verified phone, 019); `sent` with the `wamid` |

**Retries (FR-5).** A transient failure -> `failed` with `next_attempt_at` after 1 min, 5 min, 30 min, 2 h,
12 h; the attempt after the 12 h retry (6 attempts in total) -> `dead` + audit `notification.dead`.
Permanent errors -> `dead` at once: Resend 400/403/422 (invalid address, sender not allowed), Meta codes for
undeliverable / not on WhatsApp / user opted out / template missing, paused or parameter mismatch
(`lib/notify/whatsapp.ts`). A skipped row is final (not retried). The domain action never fails because of a
notification.

**Leases (NFR-2).** Workers claim rows with `for update skip locked` and a 120 s lease; a crashed worker's
rows become claimable when the lease expires (counts as an attempt). An outcome is written only with the
lease that claimed the row, so a slow worker cannot overwrite a newer attempt. Sends are at-least-once; the
Resend idempotency key turns a repeated email into one delivery. In-app rows cannot be duplicated (unique
constraint).

**Logs (NFR-3)** carry ids and counts only. `last_error` is one line, at most 500 characters, with email
addresses and phone numbers redacted, and never contains payload or message text.

## Scheduler (FR-4, D-3)

- **Vercel cron, every minute** (`vercel.json`): `GET /api/cron/outbox` with
  `Authorization: Bearer <CRON_SECRET>` (Vercel sends it when `CRON_SECRET` is set in the project; the team
  has Vercel Pro, which allows per-minute crons). `POST` works the same for manual runs. Without the header
  -> 401; without `CRON_SECRET` every request is refused. Response `{ fanned_out, sent, failed, skipped }`.
  The route first runs `outbox_has_due_work()` and returns in a few milliseconds when nothing is due; when
  work is due it keeps claiming batches of 50 for up to 20 s.
- **Immediate drain**: producers of instant events call `drainSoon([eventId])`, which uses Next.js `after()`
  to fan out and send that event's notifications right after the response. Cron handles scheduled events,
  retries and anything `after()` missed.
- **Locally**: there is no Vercel cron. Run `npm run -s outbox:run` (loops every 10 s; `--once`,
  `--interval <s>`, `--duration <s>`), or curl the route:
  `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/outbox`.
  `--mock-log <file>` (local testing only) replaces email/WhatsApp delivery with a line per delivery in
  `<file>`.
- **Free fallback** if the hosting plan changes (documented, not built): Supabase `pg_cron` + `pg_net` calling
  the same route every minute, with the secret in Vault:

  ```sql
  create extension if not exists pg_cron;
  create extension if not exists pg_net;
  select vault.create_secret('<CRON_SECRET>', 'cron_secret');
  select cron.schedule('outbox-every-minute', '* * * * *', $$
    select net.http_post(
      url := 'https://<app-domain>/api/cron/outbox',
      headers := jsonb_build_object('Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')))
  $$);
  ```

## UI and APIs

| Surface | Who | Notes |
|---------|-----|-------|
| Bell in the family header and the provider (`/dashboard`) header | signed-in user | `aria-label` `Notifications, <n> unread`, links to the role's list |
| `/notifications` | signed-in user | redirects to `/family/notifications` (guardians) or `/dashboard/notifications` |
| `GET /api/notifications?cursor=` | signed-in user | 200 `{ items: [{ id, title, body, link, created_at, read_at }], next_cursor, unread }`, own `in_app` rows only, 20 per page |
| `POST /api/notifications/read` | signed-in user | `{ ids: uuid[] }` or `{ all: true }` -> 200 `{ updated, unread }`; other users' ids match nothing |
| `/family/settings`, `/dashboard/settings` -> `Notifications` | signed-in user | `Email` / `WhatsApp` switches |
| `GET` / `PUT /api/notification-preferences` | signed-in user | `{ email: boolean, whatsapp: boolean }` -> 200 `{ preferences }`; audit `notification.preferences_updated` |
| `/admin/notifications` | platform admin (others are redirected home) | counts by channel/status, outbox event counts, last 50 `failed`/`dead` with error (no message text), `Retry` for `dead` |
| `POST /api/admin/notifications/:id/retry` | platform admin (403 otherwise) | `dead` -> `pending`, 404 for anything else |

## WhatsApp templates to submit to Meta (human task, plan §6)

Prerequisites: Meta Business verification, a WhatsApp Business Account, a sender phone number
(`WHATSAPP_PHONE_NUMBER_ID`) and a permanent system-user token (`WHATSAPP_TOKEN`) with
`whatsapp_business_messaging`. Submit each template in **English (`en`), Hindi (`hi`) and Telugu (`te`)**,
category **`UTILITY`**, one body parameter `{{1}}` = the full app link (sample:
`https://<app-domain>/family/messages`). Use the template's `strings` (`lib/notify/templates/<name>.ts`)
for the text; for example:

| Template name | Category | Params | English body |
|---------------|----------|--------|--------------|
| `message_created` | UTILITY | `{{1}}` app link | You have a new message on DoctorNearMe. Open: {{1}} |
| `document_shared` (not used yet: 023 sends in-app + email only) | UTILITY | `{{1}}` app link | Your child's care team shared a document with you. Open: {{1}} |
| `iep_published` | UTILITY | `{{1}}` app link | Your child's therapist shared a new plan. Open: {{1}} |
| `home_program_published` | UTILITY | `{{1}}` app link | Your child's care team shared new activities to do at home. Open: {{1}} |
| `assessment_assigned` | UTILITY | `{{1}}` app link | Your child's care team sent you a questionnaire to fill in. Open: {{1}} |
| `test_ping` (optional, ops check) | UTILITY | `{{1}}` app link | Notifications are working for your DoctorNearMe account. Open: {{1}} |
| `appointment_confirmed` (030) | UTILITY | `{{1}}` app link | Your DoctorNearMe appointment is confirmed. Details: {{1}} |
| `appointment_reminder_24h` (030) | UTILITY | `{{1}}` app link | Reminder: you have a DoctorNearMe appointment tomorrow. Details: {{1}} |
| `appointment_reminder_2h` (030) | UTILITY | `{{1}}` app link | Your DoctorNearMe appointment starts in 2 hours. Details: {{1}} |
| `appointment_cancelled` (030) | UTILITY | `{{1}}` app link | Your DoctorNearMe appointment was cancelled. Details: {{1}} |
| `appointment_rescheduled` (030) | UTILITY | `{{1}}` app link | Your DoctorNearMe appointment was moved to a new time. Details: {{1}} |
| `appointment_confirmed_intake` (035: confirmation with an intake call link) | UTILITY | `{{1}}` app link, `{{2}}` intake call link | Your DoctorNearMe appointment is confirmed. Details: {{1}} Before your visit, please take a short voice call with our AI assistant: {{2}} |
| `appointment_confirmed_allow_intake` (035: the child has no AI intake consent yet) | UTILITY | `{{1}}` app link | Your DoctorNearMe appointment is confirmed. Details: {{1}} Allow the AI intake call in your DoctorNearMe app to prepare for this visit. |
| `appointment_intake_link` (035) | UTILITY | `{{1}}` app link | Prepare for your DoctorNearMe visit: take the short AI intake call. Open: {{1}} |
| `appointment_meet_ready` (037) | UTILITY | `{{1}}` app link | The video call link for your DoctorNearMe appointment is ready. Join from: {{1}} |

030 added `appointment_*` and 037 `appointment_meet_ready` (rows above); each later ticket adds its rows here. The
template name sent to Meta is the DoctorNearMe template name; the language code is the recipient's UI
locale. Until a template is approved, set nothing: deliveries stay `skipped` (`whatsapp_not_configured`).

## Environment

| Variable | Notes |
|----------|-------|
| `CRON_SECRET` | required for any cron run; set it in Vercel (Production) and in `.env.local` for local curl |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | optional; both needed (and `DEMO_MODE` off) before WhatsApp is attempted |
| `WHATSAPP_API_VERSION` | default `v21.0` |
| `DATABASE_URL` | the worker and inbox use the Postgres pool (`lib/pg.ts`), like `lib/facts.ts` |

## Tests

`tests/outbox.test.ts` (database: transactions, dedup, cancel, schedule, access re-check, two-connection
claims, lease expiry, retry schedule, 200 notifications with two concurrent workers, APIs, cron auth, 028
triggers), `tests/notify-adapters.test.ts` (WhatsApp request/skip/error classes, email `.ics` + Resend
`Idempotency-Key` through the real SDK with `fetch` mocked, retry policy), `tests/notify-templates.test.ts`
(every template x locale x role, content rule).
