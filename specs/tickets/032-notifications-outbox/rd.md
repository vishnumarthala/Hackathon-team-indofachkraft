# 032: Notifications - transactional outbox, scheduler, email / in-app / WhatsApp adapters

**Status:** draft
**Mode:** solo
**Runs:** waits for 020: recipients are guardians/providers resolved through child links and case access

## Summary

Every user-facing notification (messages, shared documents, published plans, later bookings, reminders,
payments, Meet links) goes through one **transactional outbox**: the domain write and the outbox event
commit in the same transaction; a scheduler fans events out into per-recipient, per-channel deliveries
with retries, backoff, de-duplication and scheduled send times. Channels: in-app (always), email
(Resend, with `.ics` support for later appointment events) and WhatsApp (Meta Cloud API templates,
skipped until credentials and approved templates exist). This must exist before booking (rule 12).

## Functional requirements

- **FR-1** - Migration `<ts>_outbox.sql`:
  - `outbox_events(id bigint identity pk, topic text, aggregate_type text, aggregate_id uuid, payload jsonb,
    dedup_key text unique, deliver_after timestamptz default now(), status text check in
    ('pending','fanned_out','cancelled') default 'pending', created_at, fanned_out_at)`.
  - `notifications(id uuid pk, event_id -> outbox_events, recipient_user_id -> auth.users, channel text check in
    ('in_app','email','whatsapp'), template text, locale text, status text check in ('pending','sending',
    'sent','failed','dead','skipped','cancelled'), attempts int default 0, next_attempt_at, locked_until,
    last_error text, provider_message_id text, title text, body text, link text, read_at, sent_at,
    created_at, unique (event_id, recipient_user_id, channel))`.
  - `notification_preferences(user_id, channel ('email','whatsapp'), enabled boolean, updated_at,
    primary key (user_id, channel))` - in-app cannot be disabled.
  - SQL function `outbox_enqueue(topic, aggregate_type, aggregate_id, payload, dedup_key, deliver_after)`
    (returns the event id or the existing one on dedup conflict - `on conflict do nothing`), callable
    only by the service role; domain writes that emit events call it inside the same SQL function /
    `postgres` transaction (`lib/db` `sql.begin`).
  - SQL functions `outbox_claim_events(batch int)` and `notifications_claim(batch int, lease_seconds int)`
    using `for update skip locked`, setting `locked_until` (lease) so two workers never send the same row.
  - `outbox_cancel(dedup_key_prefix text)` marks pending events + their pending notifications `cancelled`
    (used by 030 to cancel reminders).
- **FR-2** - `lib/notify/topics.ts` registry: `topic -> { recipients(payload): Promise<userId[]>,
  channels: Channel[], template: string }`. Initial topics: `message.created` (027),
  `document.shared_with_guardian` (023), `iep.published`, `home_program.published`,
  `assessment.assigned`, `assessment.red_flag`, `sharing.granted`, `test.ping` (dev only). Recipient
  resolution re-checks access at fan-out time (e.g. guardian link still active, provider still assigned);
  recipients who lost access get no row.
- **FR-3** - Templates `lib/notify/templates/<template>.ts` per locale (en/hi/te via 018) returning
  `{ title, body, link, email?: { subject, text, html, ics? }, whatsapp?: { name, language, params } }`.
  Content rule: **no clinical content and no child full name** in email/WhatsApp; use first name at most
  only where the template says so (`Asha's therapist shared a new plan`) - default templates use
  `your child`. Links always point to the signed-in app page.
- **FR-4** - Workers (route handlers, protected by header `Authorization: Bearer <CRON_SECRET>`,
  otherwise 401): `POST /api/cron/outbox` fans out due events (`deliver_after <= now()`), then sends up to
  50 due notifications; returns 200 `{ fanned_out, sent, failed, skipped }`. Configured in `vercel.json`
  crons every minute (the team has Vercel Pro, which allows per-minute cron at no extra plan cost). Cost
  control: the route first runs one indexed `exists` query and returns in a few ms when nothing is due.
  Instant events (`appointment.confirmed`, `message.created`, ...) do not wait for cron: the producing
  route calls `drainSoon()` which uses Next.js `after()` to process that event's notifications right after
  the response; cron only handles scheduled reminders, retries and anything `after()` missed. Locally run
  `npm run -s outbox:run` (`scripts/outbox-run.ts`, loops every 10 s). Free fallback if the hosting plan
  changes: Supabase `pg_cron` + `pg_net` calling the same route every minute (documented, not built).
- **FR-5** - Retry policy: failures -> `failed`, `next_attempt_at` after 1 min, 5 min, 30 min, 2 h,
  12 h; after 5 attempts -> `dead` + audit `notification.dead`. Permanent errors (invalid address, opted
  out, template rejected) -> `dead` immediately. Sends are idempotent at the provider where possible
  (Resend `Idempotency-Key: notification:<id>`).
- **FR-6** - Channel adapters:
  - `in_app`: marked `sent` at fan-out.
  - `email` (`lib/notify/email.ts`, wraps `lib/email.ts`): adds optional `.ics` attachment
    (`text/calendar; method=REQUEST`, UID stable per aggregate, `SEQUENCE` increments); recipient address
    from `auth.users.email`; no address -> `skipped` (`no_email`). `DEMO_MODE` behaviour of `lib/email.ts` kept.
  - `whatsapp` (`lib/notify/whatsapp.ts`): `POST https://graph.facebook.com/v21.0/<WHATSAPP_PHONE_NUMBER_ID>/messages`
    with approved template name + params; recipient = verified phone (019); missing env
    (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`) or `DEMO_MODE` -> `skipped` with `last_error =
    'whatsapp_not_configured'`; user preference disabled -> `skipped` (`opted_out`).
- **FR-7** - In-app UI: bell in the provider and family headers with unread count (`aria-label`
  `Notifications, <n> unread`), `/notifications` list (title, body, time, link), `Mark all as read`.
  APIs: `GET /api/notifications?cursor=` -> 200 `{ items, next_cursor, unread }` (own rows only,
  `channel = 'in_app'`); `POST /api/notifications/read` `{ ids?: uuid[], all?: true }` -> 200.
- **FR-8** - Preferences: `/family/settings` and provider settings get `Notifications`: `Email` and
  `WhatsApp` toggles -> `PUT /api/notification-preferences` `{ email, whatsapp }` -> 200.
- **FR-9** - Admin ops page `/admin/notifications` (platform admin): counts by status/channel, last 50
  `failed`/`dead` with error (no body text), `Retry` button (resets `dead` -> `pending`, audit).
- **FR-10** - `docs/notifications.md`: how to add a topic + template, the transaction rule, WhatsApp
  template list to submit to Meta (names, categories `UTILITY`, params) - human task plan §6.

## Non-functional requirements

- **NFR-1** - Exactly-once **enqueue** (dedup key + same transaction); at-least-once **send** with
  provider idempotency keys; no duplicate in-app rows (unique constraint).
- **NFR-2** - A crashed worker's leased rows are retried after `locked_until`; two concurrent cron runs
  never send the same notification (test).
- **NFR-3** - No message bodies or health data in logs; `last_error` truncated to 500 chars without payload.
- **NFR-4** - Env vars in `.env.example`: `CRON_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_API_VERSION` (default `v21.0`).

## Affected areas

- `supabase/migrations/<ts>_outbox.sql` (new)
- `lib/notify/**` (new), `lib/email.ts` (add attachment + idempotency-key support only)
- `app/api/cron/outbox/route.ts`, `app/api/notifications/**`, `app/api/notification-preferences/route.ts` (new)
- `app/notifications/page.tsx`, bell component in provider/family headers, `app/admin/notifications/page.tsx` (new)
- `scripts/outbox-run.ts`, `package.json` (`outbox:run` script entry only), `vercel.json` (crons), `.env.example`
- `lib/auth-access.ts` (`/api/cron/*` public to proxy, secret-checked in handler)
- `docs/notifications.md` (new); `messages/*.json`
- `tests/outbox.test.ts`, `tests/notify-adapters.test.ts`, `tests/notify-templates.test.ts` (new)

## Don't touch

- Existing intake/referral email sending paths (they may migrate to the outbox later), existing
  migrations, `BOARD.md`

## Out of scope

- SMS channel (DLT pending), push notifications, digests, WhatsApp inbound messages/webhooks and
  delivery receipts, marketing messages.
- Appointment topics and reminders (030 registers them), payment topics (031), Meet (037).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Channels | In-app + Resend email (.ics) + Meta WhatsApp Cloud API | plan §2 "Notifications" |
| D-2 | Delivery pattern | Transactional outbox + scheduler + retries + dedup, before booking | rule 12 |
| D-3 | Scheduler | Vercel Pro cron every minute + `after()` immediate drain; `skip locked` leases | product owner 2026-11-12: cheapest option, Vercel Pro already paid |
| D-4 | WhatsApp before Meta approval | `skipped` with reason, never fails the domain action | risk 5 |
| D-5 | Content | No clinical content / full child names outside the app | DPDP minimisation |

## Open questions

None.
