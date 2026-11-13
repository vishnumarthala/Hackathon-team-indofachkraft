# 030: Availability and atomic one-off booking

**Status:** done
**Mode:** solo
**Runs:** waits for 028, 032, 041: books against stable provider profiles/services (028); confirmations and reminders go through the outbox (032); real child data needs the privacy/audit baseline (041)

## Summary

Providers publish services and simple weekly availability with date overrides; guardians book one-off
video or in-clinic appointments for a child. Double booking is impossible by construction: a Postgres
exclusion constraint on (provider, half-open time range) over blocking statuses, holds with owner and
expiry, and a single SQL state machine for hold -> confirm -> cancel/reschedule/complete (rule 10, 11).
Payment state lives in 031, not here (rule 12).

## Functional requirements

- **FR-1** - Migration `<ts>_booking.sql`: `create extension if not exists btree_gist`;
  - `services(id, provider_profile_id, org_id, location_id null, name (1-80), mode text check in
    ('in_clinic','video'), duration_min int check in (15,20,30,45,60,90), fee_inr int 0-100000,
    payment_mode text check in ('online','at_clinic','free'), buffer_min int 0-30 default 0,
    intake_kind text check in ('child_dev','generic','none') (035), active, created_at)`; in-clinic needs `location_id`.
  - `availability_rules(id, provider_profile_id, org_id, location_id null, weekday int 0-6 (0 = Monday),
    start_time time, end_time time, mode text check in ('in_clinic','video','both'), valid_from date,
    valid_to date null)`; rule times are wall-clock times in the location's time zone
    (`practice_locations.time_zone`, default `Asia/Kolkata`; video-only rules use the provider's profile time zone).
  - `availability_overrides(id, provider_profile_id, date, kind text check in ('unavailable','extra'),
    start_time null, end_time null, mode null, note)` (`unavailable` with null times = whole day).
  - `appointments(id, provider_profile_id, org_id, service_id, service_snapshot jsonb not null
    ({ name, duration_min, mode, fee_inr, payment_mode, location: { name, address, lat, lng } | null }),
    child_id null, guardian_user_id null, case_id null (035), slot tstzrange not null check (lower(slot) <
    upper(slot) and lower_inc(slot) and not upper_inc(slot)), status text check in ('held','pending_payment',
    'confirmed','cancelled','expired','completed','no_show'), hold_owner_user_id null, hold_owner_session
    text null (sha256 of anonymous booking-session id, 034), hold_expires_at null, cancelled_by text null
    check in ('guardian','provider','system'), cancel_reason, rescheduled_from uuid null, idempotency_key
    text, created_at, updated_at, unique (idempotency_key))`;
    `exclude using gist (provider_profile_id with =, slot with &&) where (status in ('held',
    'pending_payment','confirmed'))`.
  - `appointment_events(id, appointment_id, from_status, to_status, actor_user_id, reason, created_at)`
    (state history, append-only).
- **FR-2** - Slot generation `lib/booking/slots.ts` (pure, tested): for a service and date range (max 14
  days ahead, min lead time 2 h), expand rules, apply overrides, step by `duration_min`, subtract
  blocking appointments (+ buffer), return `{ start, end }` as UTC ISO strings. Rules are expanded in the
  rule's own time zone (DST-safe via `Intl`), never the server's.
  `GET /api/public/providers/:profileId/slots?service_id=&from=YYYY-MM-DD&days=7` -> 200 `{ slots }`.
- **FR-3** - State machine as SQL functions (single transaction each, `security definer`, called only by
  the server):
  - `booking_hold(service_id, start_at, owner_user_id | owner_session, idempotency_key)`: first expires
    stale holds for that provider (`hold_expires_at < now()` -> `expired`), validates the slot against
    rules/overrides, inserts `held` with `hold_expires_at = now() + 10 min`; exclusion violation -> error
    `slot_taken`. Max 1 active hold per owner (older hold released).
  - `booking_attach(appointment_id, owner, guardian_user_id, child_id)`: anonymous hold -> signed-in
    guardian (session hash must match); child must be actively linked to the guardian.
  - `booking_confirm(appointment_id, guardian_user_id)`: hold owned and unexpired; `payment_mode` `free`
    or `at_clinic` -> `confirmed`; `online` -> `pending_payment` with `hold_expires_at = now() + 15 min`
    (031 completes it). Enqueues outbox events in the same transaction.
  - `booking_cancel(appointment_id, actor, reason)`: guardian up to 2 h before start; provider any time
    before start; `pending_payment`/`held` -> `cancelled`; cancels reminder events (`outbox_cancel`).
  - `booking_reschedule(appointment_id, new_start, actor)`: atomically creates the new `confirmed`
    appointment (same snapshot, `rescheduled_from`) and cancels the old one; fails with `slot_taken` without
    changing the old one.
  - `booking_complete(appointment_id, provider_user_id, status 'completed' | 'no_show')`: only after start.
  - Invalid transitions -> error `invalid_transition` (HTTP 409).
- **FR-4** - APIs (guardian routes use `requireGuardian`; provider routes check org membership + profile):
  `POST /api/appointments/hold` `{ service_id, start, idempotency_key }` -> 201 `{ appointment_id,
  hold_expires_at }`, 409 `{ error: "This slot was just taken. Please pick another time." }`;
  `POST /api/appointments/:id/confirm` `{ child_id }` -> 200 `{ appointment }`; `POST
  /api/appointments/:id/cancel` `{ reason? }`; `POST /api/appointments/:id/reschedule` `{ start }`;
  `POST /api/appointments/:id/complete` `{ status }`; expired hold -> 410 `{ error: "Your hold expired.
  Please pick the time again." }`. Same `idempotency_key` -> same appointment (200).
- **FR-5** - Hold cleanup worker: `POST /api/cron/booking` (`CRON_SECRET`, every minute) expires
  `held`/`pending_payment` past `hold_expires_at` (031 handles late payments) and records events.
- **FR-6** - Outbox topics + templates: `appointment.confirmed` (guardian + provider; email with `.ics`,
  WhatsApp template `appointment_confirmed`, in-app), `appointment.reminder_24h` and
  `appointment.reminder_2h` (enqueued with `deliver_after` and dedup keys `appt:<id>:r24`, `appt:<id>:r2`),
  `appointment.cancelled`, `appointment.rescheduled`. Content: provider name, date/time, mode, location
  - no child name in WhatsApp/email.
- **FR-7** - Guardian UI: `Book` on `/p/[slug]` -> `/book/[profileId]`: choose `Service`, date strip,
  time slots; `Continue` holds and shows a 10-minute countdown; sign-in if needed (hold attached after
  sign-in); choose `For which child?` (linked children + `Add a child`); disclosure `Booking shares
  <child>'s name and age with <provider/org>`; `Confirm booking` (or `Continue to payment`, 031).
  `/family/appointments`: upcoming/past, `Cancel`, `Reschedule`, `Add to calendar` (.ics).
- **FR-8** - Provider UI: `/dashboard/schedule`: weekly rule editor (`Add hours`: weekday, from, to, mode,
  location), overrides (`Block a date`, `Add extra hours`), services editor, agenda (day/week list) with
  status, `Mark completed`, `No-show`, `Cancel`. 028 `offers_video`/`offers_in_clinic` updated from active services.

## Non-functional requirements

- **NFR-1** - Concurrency: 50 parallel hold attempts on one slot -> exactly one `held`; overlapping
  different-duration services cannot overlap; reschedule races leave a consistent state.
- **NFR-2** - Time: all storage `timestamptz`, ranges `[)`; UI shows slots in the viewer's time zone (018 `getTimeZone`); when it differs
  from an in-clinic location's zone, each slot also shows the clinic's local time (`4:00 PM your time · 8:30 PM at the clinic`).
- **NFR-3** - Translated (en/hi/te), 375 px booking flow.
- **NFR-4** - Register `appointments` in the 041 privacy registry (retention period per legal review, see Open questions).

## Affected areas

- `supabase/migrations/<ts>_booking.sql` (new); `lib/booking/**` (new)
- `app/api/public/providers/[profileId]/slots/route.ts`, `app/api/appointments/**`, `app/api/cron/booking/route.ts`,
  `app/api/provider/{services,availability}/**` (new)
- `app/book/[profileId]/**`, `app/family/appointments/**`, `app/dashboard/schedule/**` (new); `app/p/[slug]` (Book button)
- `lib/notify/topics.ts` + templates, `lib/privacy/registry.ts`, `vercel.json`, `messages/*.json`
- `tests/booking-slots.test.ts`, `tests/booking-state-machine.test.ts`, `tests/booking-concurrency.test.ts` (new)

## Don't touch

- Outbox internals (032), payments (031), case creation from appointments (035), existing migrations, `BOARD.md`

## Out of scope

- Recurring series, packages, waitlists, group sessions, provider-side manual booking for walk-ins
  (could be a follow-up), multi-provider centre calendars, Meet links (037).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Booking type | One-off only; video + in-clinic | plan §2 "Booking" |
| D-2 | Availability model | Weekly rules + date overrides | plan §2 "Availability / onboarding" |
| D-3 | Double-booking prevention | `btree_gist` exclusion on half-open `tstzrange` over blocking statuses | rule 10 |
| D-4 | Holds | Owned (user or anonymous session), 10 min, cleaned in-transaction + cron | rule 10; voice agent holds (034) |
| D-5 | Service snapshot | Copied into the appointment | rule 11 |
| D-6 | Payment | Separate table/state in 031 | rule 12 |

## Open questions

- Cancellation window (2 h) and no-show policy per org - product decision; configurable later.
- Retention period for appointment records (041 registry) - legal review.
