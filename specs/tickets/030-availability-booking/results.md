# 030: Availability and atomic one-off booking - Results

Branch: `ticket/030-availability-booking` (base: 017-025, 028, 029, 032, 041 merged). Tested against the isolated local
Supabase stack of worker slot 5 (`dnmslot5`, all 21 migrations applied by `supabase db reset`, `btree_gist` installed
into `extensions`), `DEMO_MODE=true`, dev server on port 3050 with `CRON_SECRET=test-3050`, own headless Chromium
(playwright-core in a scratch folder, removed afterwards) at 375 px. Synthetic accounts (`seed:users --prefix e030`,
`t030*` test users), synthetic clinics, children and providers only. Evidence files: `evidence/acceptance.txt`,
`evidence/booking-tests-verbose.txt`, screenshots `evidence/*.png`.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, `vitest run`, build) | PASS | exit 0; vitest 72 files, 1090 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl); every DB suite ran |
| `npx vitest run tests/booking-slots.test.ts tests/booking-state-machine.test.ts tests/booking-concurrency.test.ts --reporter=verbose` | PASS | 3 files, 45 tests (`evidence/booking-tests-verbose.txt`) |
| Slots (FR-2) | PASS | weekly rules (Mon-Sat 10-13 IST -> 6 slots, Sunday none), 45-minute grid, mode/location matching, `valid_from/valid_to`, whole-day and partial `unavailable`, other-location/video-only blocks ignored, `extra` hours, buffers on both sides, back-to-back half-open, 2 h lead time, 14-day horizon, IST across midnight UTC (00:00 IST = 18:30Z previous day, rendered `12:00 am IST` on the IST date), `24:00` rule end, DST-safe expansion in the rule's zone (New York EST/EDT); DB test: every generated slot passes the SQL `booking_slot_valid`, an off-grid time does not |
| State machine (FR-3/FR-4) | PASS | hold 201 / replay 200 same id / mismatched replay 422; one active hold per owner (older `cancelled` `hold_released`); taken 409 `This slot was just taken. Please pick another time.`; too soon / too far / off-grid 422; confirm: anonymous 401, other guardian 404, unlinked child 422, then `confirmed` with snapshot, history `held -> confirmed`, outbox `confirmed` + `r24` + `r2` with `deliver_after` = start - 24 h / - 2 h, double confirm 409; online -> `pending_payment` 15 min, no notification; anonymous hold (httpOnly cookie, only the SHA-256 stored) attached after sign-in, another browser 404; providers cannot hold (403); rate limit 429; reschedule (new confirmed + old cancelled `rescheduled`, reminders moved, same calendar aggregate), reschedule into a taken slot 409 with the original untouched; guardian cancel > 2 h 200 / within 2 h 409 / again 409; provider cancel within 2 h 200 + guardian notified; other guardian / other provider / anonymous 404/404/401; complete before start 409, after start 200, again 409, `no_show`, cancelled/held cannot complete 409, held cannot be rescheduled 409 |
| Concurrency (NFR-1) | PASS | real DB, one connection per attempt: **50 simultaneous holds -> 1 held, 49 `slot_taken`**; 10 x 30-min + 10 x 45-min overlapping holds -> 1 success, 19 `slot_taken`; two reschedules into one slot -> 1 success, loser still `confirmed` at its original time; `[10:00,10:30)` + `[10:30,11:00)` both succeed; 5 parallel raw inserts bypassing the functions -> 1 row, the rest `23P01`/`40P01` (constraint alone); a hold racing the cron on a stale hold -> stale row `expired`, exactly one new hold |
| Expiry (FR-4/FR-5) | PASS | stale hold expired in-transaction by the next hold (no cron); cron without secret 401, with secret `{"expired":1}`, row `expired` + history `held -> expired (system)`; confirm 410 `Your hold expired. Please pick the time again.`; slot offered again; `vercel.json` has `/api/cron/booking` every minute |
| Notifications (FR-6) | PASS | fan-out: guardian + provider in-app + email (`.ics` REQUEST, UID `appointment-<origin id>@doctornearme`), WhatsApp `skipped whatsapp_not_configured`; cancel -> `CANCEL` invite; templates en/hi/te, no child name or clinical terms (032's template test loops over the new topics) |
| E-1 book in-clinic free (FR-2, FR-3, FR-7) | PASS | anonymous `/p/e030-dr-a` -> `Book` -> Speech assessment -> 14 Nov -> `10:30 am IST` -> `Continue` -> `We are holding 14 November 2026, 10:30 am IST for you.` / `Time left: 9:59` -> `Sign in` (phone OTP) returns to `/book/<id>?hold=<id>` -> `For which child?` -> disclosure `Booking shares e030 Asha (synthetic)'s name and age with Dr Asha Rao (synthetic) (e030 Centre A Banjara Hills).` -> `Confirm booking` -> `Your appointment is booked.`; row `confirmed` with `service_snapshot`, events `held (anonymous) -> confirmed (guardian)`; outbox confirmation fanned out at once (`after()`): guardian/provider email `sent` + in-app `sent`, WhatsApp `skipped`; reminders pending at 2026-11-13 05:00Z (24 h) and 2026-11-14 03:00Z (2 h); email `.ics` attached (`acceptance.txt`) |
| E-2 conflict and expiry (FR-4, FR-5) | PASS | guardian_b same slot -> 409 FR-4 message; 10:30 missing from the API list and the UI after refresh; hold 11:30 -> expiry in the past -> cron `{"expired":1}` -> `expired`; confirm -> 410 message; 11:30 offered again |
| E-3 cancel / reschedule (FR-3) | PASS | UI `Reschedule` to 11:00 -> `Your appointment was moved.`; new `confirmed` with `rescheduled_from`, old `cancelled` (`rescheduled`); old `r24`/`r2` `cancelled`, new ones pending; guardian cancel within 2 h (time travel) -> 409 `too_late`; provider cancel -> 200, guardian in-app + email `Appointment cancelled` |
| E-4 provider schedule (FR-8) | PASS | `/dashboard/schedule` -> `Block a date` 14 Nov (whole day) -> slots for 14 Nov `[]`; the confirmed 12:00 appointment stays `confirmed` and the agenda shows it with `Outside your hours now (blocked or changed). Contact the family or cancel.` (child name + age); `Mark completed` before start -> `You can mark this after the appointment starts.` (409); after time travel -> `completed`; services editor + weekly hours + date changes work through the UI; `offers_video`/`offers_in_clinic` follow active services |
| E-5 authz negatives | PASS | guardian_b confirm / cancel guardian_a's appointment -> 404 / 404; guardian confirms with a child not linked to them -> 422; provider_b delete rule / deactivate service of provider_a -> 404 / 404, add hours at provider_a's clinic -> 400 (`location_id`), cancel -> 404 (nothing changed); anonymous confirm -> 401 |
| NFR-2 time zones | PASS | London viewer: `4:30 am GMT+0 your time · 10:00 am IST at the clinic`; video service shows only the viewer's time; `Times are shown in your time zone (Europe/London).` |
| NFR-3 i18n / 375 px | PASS | new `booking` namespace (151 keys) + privacy-notice rows in en/hi/te, `messages/REVIEW.md` regenerated (1764 rows), key test passes; `/book`, `/p`, `/find`, `/dashboard/schedule`, `/family/appointments` have no horizontal scroll at 375 px in en/hi/te (fixed a fieldset min-width bug the check found) |
| NFR-4 privacy registry | PASS | `appointments` registered: export = the requesting guardian's own bookings of the child (another guardian gets `[]`); erasure (`everything`) cancels future appointments (provider notified) and detaches the child (`booking_erase_child`); privacy notice lists appointments (collect + retention, "pending legal review") |
| No tracking on child pages (041) | PASS | `/book/*` gets the family CSP; live crawl (`NO_TRACKING_BASE_URL`) 13 passed, 21 pages incl. `/family/appointments` and `/family/appointments/<id>/reschedule` (the crawl now creates a synthetic appointment for its guardian) |

## Deviations

- **Reminder topic names.** 032's `outbox_events_topic_check` allows no digits and 032's migration sorts after this
  ticket's (`...3000` < `...3200`), so it cannot be relaxed from here. FR-6's `appointment.reminder_24h` /
  `appointment.reminder_2h` are `appointment.reminder_day_before` / `appointment.reminder_two_hours`; dedup keys
  (`appt:<id>:r24`, `appt:<id>:r2`) and template names (`appointment_reminder_24h`, `appointment_reminder_2h`) are as
  specified.
- **`availability_overrides.location_id`** (not in FR-1): `extra` in-clinic hours need a location, and a block can be
  limited to one clinic. Null = every location.
- **Notification payloads** carry small display values (provider name, start/end, mode, time zone, location text) besides
  the id, because templates render without database access; never the child (032's strict schema rejects extra keys).
- **WhatsApp** keeps 032's one-parameter Meta format (the app link); the date/time/place are in-app and in the email.
  Templates to submit are listed in `docs/notifications.md`.
- **Advisory lock.** On top of the exclusion constraint the SQL functions serialise writes per provider: buffers are
  checked consistently and concurrent exclusion checks cannot deadlock (raw concurrent inserts can end in `40P01`).
- **`Continue to payment`** is shown for `online` services and moves the booking to `pending_payment`; the checkout
  itself is 031. Demo-profile bookings are not yet special (042: `demo_ack` / `is_demo` via `lib/booking/hooks.ts`).
- **Who may act on the provider side:** the profile's provider or an active owner/admin of the appointment's
  organisation (front desk). Schedule editing is the profile owner's only.

## Notes

- **Migration** `20261113003000_booking.sql` (additive): `btree_gist`, `services`, `availability_rules`,
  `availability_overrides`, `appointments` (exclusion constraint, half-open check), `appointment_events` (append-only
  trigger; deletes only by cascade), triggers deriving `offers_video`/`offers_in_clinic` once a profile has services,
  RLS + read policies, SQL functions `booking_hold/attach/confirm/cancel/reschedule/complete/expire_stale/
  enqueue_confirmed/erase_child` (+ helpers), service role only.
- **Helpers:** `lib/booking/{slots,time,store,errors,schemas,session,authz,display,calendar,hooks,rate-limit,provider-routes}.ts`,
  `components/booking/*`. Docs: `docs/booking.md` (data model, state machine, APIs, extension points),
  `docs/system-design.md`, `docs/notifications.md`, `docs/privacy/retention.md`, `docs/providers.md`, `docs/maps.md`.
- **For 031:** `pending_payment` holds 15 min (`hold_expires_at`), expired by the cron / next hold; on payment move to
  `confirmed` and call `booking_enqueue_confirmed(id)` in the same transaction; `/family/appointments/**` already has the
  Razorpay allowlist entry (041).
- **For 034:** `GET /api/public/providers/:id/slots` and `holdSlot(input, { sessionHash: hashBookingSession(id) })`;
  confirmation needs a signed-in guardian.
- **For 035:** `services.intake_kind`, `appointments.case_id`, `service_snapshot.intake_kind`.
- **For 036/037/042:** appointment `completed` status for ratings; `checkHoldPreconditions()` for the Google-account
  check on video holds and the demo acknowledgement; add `is_demo` with a default.
- **No new env vars** (`CRON_SECRET` from 032 is reused).
- **Shared files touched additively:** `lib/notify/{topics,recipients}.ts`, `lib/notify/templates/index.ts` (+6
  templates), `lib/privacy/registry.ts`, `lib/auth-access.ts` (two public API paths, guardians may return to `/book/`
  after sign-in), `lib/csp.ts` (`/book/` gets the family CSP), `app/p/[slug]/page.tsx` and
  `components/directory/ResultList.tsx` (`Book`), `app/dashboard/layout.tsx` (`Schedule` link),
  `app/family/(portal)/appointments/page.tsx` (replaces 019's placeholder), `app/family/(portal)/children/new/page.tsx` +
  `AddChildForm` (`next` back to the booking), `app/privacy/page.tsx`, `messages/*.json`, `messages/REVIEW.md`,
  `vercel.json`, `tests/notify-templates.test.ts` (samples), `tests/no-tracking.test.ts` (crawl appointment).
- **Open questions (product/legal):** cancellation window (2 h) and no-show policy per org; retention period for
  appointment records (shown as pending legal review).
- The E2E data (`e030-*` accounts, `e030` clinics, their appointments) is left in the slot 5 database; test suites clean
  up after themselves.
