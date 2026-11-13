# Availability and atomic booking (ticket 030)

Providers publish **services** and simple **weekly hours** with **date overrides**; guardians book one-off video or
in-clinic appointments for a child. Double booking is impossible by construction (design rule 10) and every state
change is one SQL function (one transaction). Payment state lives in 031, not here (rule 12).

Code: `lib/booking/**`, `app/api/appointments/**`, `app/api/public/providers/[profileId]/slots`,
`app/api/provider/{services,availability}/**`, `app/api/cron/booking`, `app/book/[profileId]`,
`app/family/(portal)/appointments/**`, `app/dashboard/schedule`, `components/booking/**`.
Migration: `supabase/migrations/20261113003000_booking.sql`.

## Data model

| Table | What |
|---|---|
| `services` | `provider_profile_id`, `org_id`, `location_id` (required for `in_clinic`; FK `(location_id, org_id)` keeps the org equal to the location's org), `name` (1-80), `mode` `in_clinic`/`video`, `duration_min` 15/20/30/45/60/90, `fee_inr` 0-100000 (`free` -> 0), `payment_mode` `online`/`at_clinic`/`free`, `buffer_min` 0-30 (break **after** the appointment), `intake_kind` `child_dev`/`generic`/`none` (035), `active`. |
| `availability_rules` | Weekly hours: `weekday` 0 = **Monday** ... 6 = Sunday, `start_time`/`end_time` (`24:00` allowed), `mode` `in_clinic`/`video`/`both` (`in_clinic`/`both` need a location), `valid_from`, `valid_to`. Wall-clock in the location's `time_zone` (028), video-only rules in the profile's `time_zone`. |
| `availability_overrides` | Per date: `unavailable` (no times = whole day; optional `location_id`/`mode` narrow it, null = everything) or `extra` hours (times + mode, location unless video). Same time-zone rule. `note` is provider-only. |
| `appointments` | `slot tstzrange` **half-open** `[start, end)` (check), `status` `held` / `pending_payment` / `confirmed` / `cancelled` / `expired` / `completed` / `no_show`, `service_snapshot` (rule 11: name, duration, mode, fee, payment mode, buffer, intake kind, provider name, time zone, location `{ id, name, address, lat, lng, time_zone }` or null), `child_id`, `guardian_user_id`, `case_id` (035), hold owner (`hold_owner_user_id` or `hold_owner_session` = SHA-256 hex of an anonymous booking-session id), `hold_expires_at`, `cancelled_by`, `cancel_reason`, `rescheduled_from`, `origin_appointment_id` (first appointment of a reschedule chain: the calendar UID), `idempotency_key` (unique, namespaced by owner). |
| `appointment_events` | Append-only state history (`from_status`, `to_status`, `actor_user_id`, `actor_kind` guardian/provider/system/anonymous, `reason`). Updates and direct deletes raise; rows go only with their appointment (cascade). |

**Exclusion constraint:** `exclude using gist (provider_profile_id with =, slot with &&) where (status in ('held',
'pending_payment', 'confirmed'))` (`btree_gist` in schema `extensions`). One provider identity (028's
`provider_profiles.id`) has one calendar across organisations.

Consultation modes: once a profile has any service, `offers_video` / `offers_in_clinic` (029) are derived from its
active services by triggers (`services_refresh_modes`, `provider_profiles_derive_modes`); profiles without services
(seeded listings) keep the manual flags.

RLS is on for all five tables (providers read their own services/hours/appointments, guardians their own
appointments); the server uses the service role and gates every route itself.

## State machine (SQL, `security definer`, service role only)

```
             booking_hold            booking_confirm (free / at_clinic)
   (none) ───────────────► held ─────────────────────────────────────► confirmed ──► completed / no_show
                            │  \        booking_confirm (online)          │  ▲          (booking_complete,
                            │   └──────────────────► pending_payment ─────┘  │           after the start)
                            │                         │   (031 pays: booking_enqueue_confirmed)
          hold_expires_at < now() (next hold / cron)  │
                            ▼                         ▼
                         expired  ◄──────────────── expired
   held / pending_payment / confirmed ── booking_cancel ──► cancelled
   confirmed ── booking_reschedule ──► cancelled (old, reason `rescheduled`) + new confirmed (rescheduled_from)
```

| Function | Rules |
|---|---|
| `booking_hold(service, start, owner_user \| owner_session, idempotency_key)` | Same owner + key -> the same appointment (`replay`, HTTP 200); a different service/start with the same key -> `idempotency_mismatch`. Service active, profile verified + listed. Takes a per-provider advisory lock, expires that provider's stale holds, checks lead time (>= 2 h), horizon (< 14 days), the rules/overrides (`booking_slot_valid`) and buffers (`booking_conflicts`), releases the owner's older hold (one active hold per owner), inserts `held` for 10 minutes. Exclusion violation or buffer collision -> `slot_taken`. |
| `booking_attach(id, owner_user, owner_session, guardian, child)` | The hold's owner (user id, or the session hash for an anonymous hold) -> the signed-in guardian; the child must be actively linked to them (`child_not_linked`). |
| `booking_confirm(id, guardian)` | Owned, unexpired hold. `free`/`at_clinic` -> `confirmed` + outbox events; `online` -> `pending_payment` with `hold_expires_at = now() + 15 min` (031 completes it and calls `booking_enqueue_confirmed`). |
| `booking_cancel(id, actor, kind, reason)` | Guardian: their own, confirmed ones up to 2 h before the start. Provider side (profile owner or an active owner/admin of the appointment's org): any time before the start. Cancels unsent notifications of the appointment (`outbox_cancel('appt:<id>:')`) and enqueues `appointment.cancelled` for confirmed ones. |
| `booking_reschedule(id, new_start, actor, kind)` | Confirmed only; same checks as a hold for the new time (with the snapshot's duration/mode/location). Cancels the old and inserts the new one in one sub-transaction; `slot_taken` leaves the old appointment untouched. Old reminders cancelled, new ones scheduled, `appointment.rescheduled` enqueued. |
| `booking_complete(id, provider, completed \| no_show)` | Provider side, confirmed, only after the start (`not_started`). |
| `booking_expire_stale(profile?, limit)` | `held`/`pending_payment` past `hold_expires_at` -> `expired` (+ history), `for update skip locked`. Used by holds (in-transaction) and the cron. |
| `booking_erase_child(child)` | Privacy erasure (041): future blocking appointments -> cancelled (system, provider notified), then the child is detached from every appointment. |

Errors are raised with the code as the message; `lib/booking/errors.ts` maps them: `slot_taken` 409 `This slot was
just taken. Please pick another time.`, `hold_expired` 410 `Your hold expired. Please pick the time again.`,
`invalid_transition` / `too_late` / `not_started` 409, `not_found` 404 (also for someone else's appointment),
`child_not_linked` / `slot_unavailable` / `too_soon` / `too_far` / `idempotency_mismatch` 422. Bodies are
`{ error, code }`.

**Concurrency (NFR-1).** The exclusion constraint is the hard guarantee. The functions additionally serialise writes
per provider with `pg_advisory_xact_lock(hashtextextended('booking:<profile>', 0))` so buffer checks see each other and
concurrent exclusion checks cannot deadlock (Postgres may abort concurrent raw inserts with `40P01` instead of
`23P01`; through the functions callers only ever see `slot_taken`). `tests/booking-concurrency.test.ts` runs 50
parallel holds on 50 connections (1 held, 49 `slot_taken`), overlapping 30/45-minute services, two reschedules into
one slot (loser keeps its appointment), back-to-back half-open slots, raw inserts against the constraint, and a hold
racing the cron.

## Slots (FR-2)

`lib/booking/slots.ts` (pure) mirrors `booking_slot_valid` + `booking_conflicts`: per local date, windows from weekly
rules (weekday, validity, mode/location) and `extra` overrides; candidates step by the service duration from the
window start and must end inside it; a candidate touching an `unavailable` override, starting less than 2 h from
now or 14 days or more ahead, or colliding with a blocking appointment (each side's buffer added after its end) is
dropped. Rules are expanded in their own time zone with `Intl` (`lib/booking/time.ts`, DST-safe, never the
server's zone). Held / pending appointments block only while their hold is unexpired. A DB test checks that every
generated slot is accepted by the SQL check.

## APIs

| Method + path | Who | Body / query | Success / errors |
|---|---|---|---|
| `GET /api/public/providers/:profileId/slots?service_id=&from=YYYY-MM-DD&days=7` | public (120/min per IP) | `from` = local date in the service's zone (default today), `days` 1-14 | 200 `{ slots: [{ start, end }], from, days, time_zone, duration_min }` (UTC ISO); 404 unknown/unlisted profile or inactive service; 400 |
| `POST /api/appointments/hold` | guardian or anonymous (30 per 10 min per IP) | `{ service_id, start, idempotency_key }` | 201 `{ appointment_id, hold_expires_at, status }`; 200 replay; 409 taken; 403 signed-in non-guardian; 422 (037: video without a linked Google account) |
| `POST /api/appointments/:id/confirm` | guardian | `{ child_id }` | 200 `{ appointment }` (`confirmed` or `pending_payment`); 401; 404; 410; 422 (037: video without Google) |
| `POST /api/appointments/:id/meet-link` (037) | provider side | `{ url }` (`https://meet.google.com/...`) | 200 `{ meet_url, meet_status: "manual" }`; 400 not a Meet link; 404; 409 (see `docs/google-meet.md`) |
| `POST /api/appointments/:id/cancel` | booking guardian or provider side | `{ reason? }` | 200 `{ appointment }`; 409 |
| `POST /api/appointments/:id/reschedule` | booking guardian or provider side | `{ start }` | 200 `{ appointment, rescheduled_from }`; 409 |
| `POST /api/appointments/:id/complete` | provider side | `{ status: "completed" \| "no_show" }` | 200; 409 before the start |
| `GET /api/appointments/:id/ics` | booking guardian or provider side | - | `text/calendar` (same UID as the email invites) |
| `GET\|POST /api/cron/booking` | `Authorization: Bearer <CRON_SECRET>` (Vercel cron, every minute) | - | 200 `{ expired }`; 401 |
| `GET\|POST /api/provider/services`, `PATCH /api/provider/services/:id` | provider (own profile) | see `lib/booking/schemas.ts` | 201/200; 400 field errors; other providers' ids 404 |
| `GET\|POST /api/provider/availability/rules`, `DELETE .../rules/:id`, `GET\|POST /api/provider/availability/overrides`, `DELETE .../overrides/:id` | provider (own profile) | `{ weekday, start_time, end_time, mode, location_id? }`, `{ date, kind, start_time?, end_time?, mode?, location_id?, note? }` | 201/200; 400; 404 |

Anonymous holds: the hold route sets an httpOnly `dnm_booking` cookie (random 32 bytes, 1 day); only its SHA-256 is
stored. `/api/appointments/hold` and the slots route are public in `lib/auth-access.ts`; every other booking route
needs a session. `postSignInPath` lets guardians return to `/book/<profileId>?hold=<id>` after sign-in.

## UI

- `/p/<slug>` and `/find` result cards: `Book` -> `/book/<profileId>` (the profile page shows it when the provider
  has an active service; cards when the profile offers a mode).
- `/book/<profileId>` (public, family CSP, `noindex`): service, date strip, times (viewer's zone; in-clinic slots in a
  different zone also show `... at the clinic`, NFR-2), `Continue` -> 10-minute countdown -> `Sign in` (phone OTP /
  Google, returns with `?hold=`) -> `For which child?` (+ `Add a child`, which returns to the hold) -> disclosure
  `Booking shares <child>'s name and age with <provider (location)>` -> `Confirm booking` (`Continue to payment` for
  online services; 031 adds the checkout).
- `/family/appointments`: upcoming / past, `Add to calendar`, `Reschedule` (`/family/appointments/:id/reschedule`),
  `Cancel` (up to 2 h before the start). Video appointments (037): `Join video call` from 10 minutes before the start
  until 30 minutes after the end, or `Your provider will share the video link soon.`
- `/dashboard/schedule` (link in the provider header): agenda (day/week in the profile's zone, child name and age,
  status, a warning on confirmed appointments that no longer fit the hours, `Mark completed`, `No-show`, `Cancel`),
  services editor, weekly hours (`Add hours`), date changes (`Block a date`, `Add extra hours`). Video appointments
  (037): Meet link state, `Join video call` in the join window, `Add a video link` when the automatic link failed.

## Notifications (FR-6)

Enqueued by the SQL functions in the same transaction (topics in `lib/notify/topics.ts`, templates
`lib/notify/templates/appointment*.ts`). Payload: `appointment_id`, `starts_at`, `ends_at`, `provider_name`, `mode`,
`time_zone`, `location` (+ `cancelled_by`) - never the child. Dedup keys share the prefix `appt:<id>:`.

| Topic | Dedup key / when | Recipients (re-checked at fan-out) | `.ics` |
|---|---|---|---|
| `appointment.confirmed` | `appt:<id>:confirmed`, now | guardian + provider, while confirmed | REQUEST |
| `appointment.reminder_day_before` (FR-6 `reminder_24h`) | `appt:<id>:r24`, `deliver_after = start - 24 h` (only if still in the future) | guardian, while confirmed | - |
| `appointment.reminder_two_hours` (FR-6 `reminder_2h`) | `appt:<id>:r2`, `start - 2 h` | guardian, while confirmed | - |
| `appointment.cancelled` | `appt:<id>:cancelled` | guardian + provider | CANCEL |
| `appointment.rescheduled` | `appt:<new id>:rescheduled` | guardian + provider | REQUEST |

The outbox's topic check (032) allows no digits, hence the reminder topic names. Events use the chain's first
appointment as `aggregate_id`, so the calendar UID (`appointment-<origin id>@doctornearme`) and SEQUENCE update the
same calendar entry across reschedules.

## Extension points

- **031 payments (done, `docs/payments.md`):** `pending_payment` holds expire after 15 minutes (cron + next hold);
  `payment_apply_captured` moves the appointment to `confirmed` and calls `booking_enqueue_confirmed(id)` in the same
  transaction (late payments: same row re-confirmed if the slot is still free, else refund). Triggers on `appointments`
  refund paid cancellations (provider/system always, guardian >= 24 h before) and move the payment with a reschedule.
  `Continue to payment` opens `/book/<profileId>/pay/<appointmentId>`; `/family/appointments` keeps expired bookings
  whose late payment is being refunded.
- **034 voice agent (done):** `lib/agents/booking/tools.ts` calls `getSlots()` and `holdSlot(input, { sessionHash })`
  where the owner is the **browser's** booking session (`dnm_booking` cookie hash, stored per agent session), not the
  agent's token, so the normal confirm flow attaches the hold after sign-in. `/book/<profileId>?appointment=<id>` is an
  alias of `?hold=`. Confirmation still needs a signed-in guardian; for online services that confirm leads to 031's
  payment page like any other hold. 037's video rule refuses agent holds (no Google identity) as `{ held: false,
  reason: "google_account_required" }`. See `docs/elevenlabs-booking-agent.md` and
  `docs/system-design.md` section 13b.
- **035 intake:** built - see "Appointment -> case -> intake (035)" below.
- **037 Meet (done) / 042 demo safeguard:** `lib/booking/hooks.ts` `checkHoldPreconditions()` runs before every hold and
  `checkConfirmPreconditions()` before confirming an owned hold. 037: a `video` service needs a signed-in guardian with a
  linked Google identity, else 422 `{ error: "Link your Google account to book a video consultation", code:
  "google_account_required" }` (anonymous video holds too); the booking page shows that text with `Connect Google` /
  `Sign in` before slot selection. 042: `demo_ack` for `is_synthetic` profiles, plus an `is_demo` column. Meet links
  themselves are created from the state machine's own outbox events (no change to the SQL functions): see
  `docs/google-meet.md`.

## Appointment -> case -> intake (035)

Design rules 6 and 11. Code: `lib/booking/case-link.ts`, `lib/intake/attempts.ts`, `lib/intake/attempt-token.ts`,
`lib/intake/appointment-process.ts`, `lib/intake/generic.ts`, `lib/notify/consumers.ts`, `app/intake/a/[token]`,
`app/api/intake/a/[token]/{start,complete}`, `app/api/dev/simulate-intake/a/[token]`. Migrations
`20261113003500_appointment_intake.sql` and `20261113013500_appointment_intake_report_kind.sql`.

- **Case (FR-2).** When `appointment.confirmed` (or `.rescheduled`) is fanned out, the outbox consumer
  `appointment.link_case` (`lib/notify/consumers.ts`, inside the fan-out transaction, before the template renders)
  calls `appointment_link_case(id)`: the newest case of the appointment's org for the child (cases have no closed
  state yet, so every case counts as open), else a new one (`child_alias` = child display name, `parent_alias` = the
  guardian's display name or `Parent`, `language` = the guardian's `preferred_locale` (en/hi/te, else en),
  `therapist_name` = provider name, `created_by` = the provider when an active member, so 022's trigger makes them
  lead); the provider's user joins `case_assignments` (member, or lead when there is none); `appointments.case_id` is
  set; audit `appointment.case_linked`. Idempotent by appointment (row lock + advisory lock per org/child): re-running
  returns `existing`. Reschedules copy `case_id`. A provider profile without a user, or a user who is not an active
  member of the org, is not assigned (org owners/admins still see the case).
- **Intake attempt (FR-3).** `services.intake_kind` (frozen in `service_snapshot.intake_kind`) `child_dev` / `generic`
  -> `appointment_issue_intake(id, attempt_id, token_hash)`: needs a confirmed future appointment with a case and
  `ai_intake_call` consent (`child_consent_state`, live child); one active (`issued`/`started`) attempt per appointment
  (partial unique index); `expires_at` = appointment start. Results `issued` / `existing` / `consent_needed` /
  `completed` / `not_applicable`. The token is `base64url(HMAC-SHA256(INTAKE_LINK_SECRET, attempt id))` (43 chars);
  only its SHA-256 is stored (`intake_attempts.token_hash`), and the server re-derives the link when it renders the
  confirmation or `/family/appointments`. Default intake kind of a new service by provider type (D-4,
  `lib/booking/intake-defaults.ts`): `generic` for physiotherapist and pediatrician, `child_dev` for every other type.
- **Confirmation text.** The consumer stores `intake` in the event payload (`{ status: "link", attempt_id, agent_kind }`
  or `{ status: "consent_needed", agent_kind }`; ids only). Guardian copies (in-app + email) of
  `appointment.confirmed` / `.rescheduled` then end with `Before your visit, please take a short voice call with our AI
  assistant: <APP_URL>/intake/a/<token>` or `Allow the AI intake call in your DoctorNearMe app to prepare for this
  visit.`; WhatsApp confirmations use `appointment_confirmed_intake` ({{1}} app link, {{2}} call link) or
  `appointment_confirmed_allow_intake`. Providers never get the link.
- **Consent later.** A trigger on `consent_records` enqueues `consent.granted` (consumer-only topic, dedup
  `consent:<record>:granted`) when an `ai_intake_call` grant can issue a link for an upcoming confirmed appointment;
  its consumer issues the attempts and enqueues `appointment.intake_link` (guardian, in-app + email + WhatsApp, dedup
  `appt:<id>:intake_link:<attempt>`). Withdrawal revokes the child's open attempts (`consent_withdrawn`).
- **Lifecycle (FR-4).** Trigger `appointments_intake_status_changed`: cancelled (except `rescheduled`), expired,
  no-show -> attempts `revoked` (`appointment_cancelled` / ...). Trigger `appointments_intake_rescheduled`: the active
  attempt moves to the new appointment with the new start as expiry (same token). `booking_erase_child` cancels, so
  erasure revokes too.
- **Intake page (FR-4).** `/intake/a/<token>` reuses the 009 call UI (`IntakeCall` with `apiBase`, `simulatePath`,
  `languageSelect`): Child Development -> language select en/hi/te + existing agent; generic -> English only, no
  language select, `ELEVENLABS_GENERIC_INTAKE_AGENT_ID`. `POST /api/intake/a/<token>/start` re-checks the link
  (410 `This link has expired` after the start / when revoked, 409 when already complete) and consent (422), marks the
  attempt `started` and sends `intake_attempt_id` (never the case id; the Child Development agent's required
  `case_id` variable gets the placeholder `appointment-intake`).
- **Completion (FR-5).** Webhook (calls with `dynamic_variables.intake_attempt_id`), `POST /api/intake/a/<token>/complete`
  and the demo simulator use `processAppointmentPostCall`: agent id must be the attempt kind's agent; a conversation
  already stored for another appointment is never attached (403 on the completion endpoint); duplicate ->
  `{ received: true, duplicate: true }`; consent re-checked before storing and again before Gemini; the link must be
  active (a started call may be delivered up to 2 h after the start). One transaction: `intake_call` recording with
  `appointment_id`, attempt `completed` + `conversation_id` (unique), Child Development case-sheet facts + case status,
  audit `intake.received`. Then Child Development -> 010's `pre_session_brief` (with `reports.appointment_id`);
  generic -> `generic_intake_brief` (`prompts/generic-intake.md`, `schemas/generic-intake.json`, fixture
  `demo/fixtures/gemini/generic-intake.json`) whose medicines/allergies are compared with the 021 health profile by
  the server (`health_check`: `in_profile` / `not_in_profile` / `profile_not_recorded`, plus profile entries not
  mentioned). Agent setup: `docs/elevenlabs-generic-intake-agent.md`.
- **Views (FR-6).** `/dashboard/schedule` agenda rows show `Intake: not started` / `Intake: completed` with
  `Open brief` -> `/cases/<case>/brief#appointment-<id>`; the case Brief tab lists `Appointment intake calls` (brief
  Markdown per appointment); `/family/appointments` shows the call button, the consent hint (+ link to the child's
  permissions) or `Intake call done`. The case-level Child Development Brief skips generic calls; the case-level link
  (009) only counts recordings without an appointment as "complete".

## Open questions (product / legal)

- Cancellation window (2 h) and no-show policy per org; `GUARDIAN_CANCEL_WINDOW_MINUTES` and the SQL constant.
- Retention of appointment records (041 registry entry `appointments`, pending legal review).
