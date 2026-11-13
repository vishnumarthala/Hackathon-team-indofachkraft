# 043: Recurring therapy sessions (weekly series) - Results

Branch: `ticket/043-recurring-sessions` (worktree `dnm-worktrees/043`). Tested against the local Supabase stack in slot 6
(all 36 migrations applied by `dnm-db.sh 6 <worktree> reset`, incl. the new `20261113004300_appointment_series.sql`),
`DEMO_MODE=true`, dev server on port 3060, headless Chromium at 375 px (`timezoneId` Asia/Kolkata). Synthetic accounts
and data only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0. Vitest: 92 files, 1537 passed, 11 skipped (the opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl, as before; every DB suite ran). Build lists `/api/provider/series`, `/api/provider/series/[id]`, `[id]/{change,pause,end}`, `/api/provider/series/conflicts/[id]`; only the pre-existing `lib/demo.ts` tracing warning |
| `npx vitest run tests/series-*.test.ts --reporter=verbose` | PASS | 2 files, 25 passed (`tests/series-flow.test.ts` 16 DB tests through the route handlers, `tests/series-display.test.ts` 9 pure tests) |
| Mon/Wed/Fri -> 24 occurrences in 8 weeks | PASS | 24 `confirmed` rows, all 09:00 IST on Mon/Wed/Fri, 24 distinct occurrence dates; one frozen snapshot copied to every row |
| Materialize twice -> no duplicates | PASS | second run `created: 0`, still 24 rows (also: unique `(series_id, series_occurrence_date)`) |
| Clash with a one-off -> `slot_taken`, no appointment | PASS | one-off booked through 030's hold/confirm on Wed 15:00; series Mon/Wed 15:00 -> conflicts `[{ date: Wed, reason: slot_taken }]`, rows only for the other 3 dates; the one-off untouched |
| Blocked date -> `blocked_date` (and outside hours) | PASS | `unavailable` override 16:00-17:00 on a Monday -> `blocked_date`; Saturdays (hours Mon-Fri) -> `outside_hours`; `Skip this date` is final even after the block is removed |
| "This and future" splits and cancels only future untouched rows | PASS | Mon/Wed 11:00 changed to 13:00 from week 3: weeks 1-2 unchanged, 3 untouched rows cancelled (`series_changed`, by provider), the week-3 Wednesday already moved to 12:00 stays, new series has 4 rows at 13:00, old `ends_on` = day before; a later change past the end -> 400 |
| Pause cancels the range; past rows unchanged | PASS | Tue/Thu series, first session time-travelled into the past; pause weeks 1-2 -> 3 cancelled (`series_paused`), the past one still `confirmed`, later weeks untouched; second pause -> 409 `pause_exists`; re-materialize creates nothing in the window |
| Non-member provider 404; guardian cannot create (403) | PASS | other-org provider: create 404 (also with their own profile), `GET`/`change`/`pause`/`end`/conflict 404; guardian: create 403, pause/end 403, conflict 403; member assigned to the case but not owner/admin nor the profile's therapist: create 404; anonymous 401 |
| Concurrent materialize (2 workers) | PASS | 12 series, two connections in opposite order: 288 rows = 288 distinct occurrences, no errors, no conflicts |
| NFR-1: 200 series x 8 weeks < 10 s | PASS | 4800 sessions in 2.3-2.6 s (`materializeMany`, 4 at a time, one transaction per series) |
| FR-4 cron | PASS | `/api/cron/booking` without secret 401; with secret 200 `{ expired, series: { series, created, conflicts, failed: 0 } }` |
| FR-8 notifications | PASS | create: exactly one `series.created` (no child data in the payload), recipient = the linked guardian; one `appointment.reminder_day_before` for the next occurrence only (`start - 24 h`), no per-session confirmation; change/pause/end/skip/move: one `series.changed` each; per-session `appointment.cancelled` withdrawn in the same transaction; guardian's single cancellation keeps 030's message; series sessions completed -> 036 rate prompt withdrawn |
| "This session only" | PASS | provider moves a session through 030's reschedule route: new row keeps `series_id` (no occurrence date); guardian cancels one session through 030's cancel route (200); neither is re-created by the horizon |
| Privacy (041 registry) | PASS | `appointment_series` category (`appointment_series`, `series_conflicts`) before `appointments`; export lists the child's series without names; erasure cancels future sessions without messages and deletes the series |
| FR-9 time zones / DST | PASS | `series_occurrence_start('2027-03-26'/'2027-03-29', 10:00, Europe/London)` = 10:00Z / 09:00Z (wall clock kept); summary for a New York viewer: "Tue, Thu, Sun" at 11:30 pm + "10:00 am IST" at the clinic |
| E-1 create a timetable | PASS | case page (375 px, no overflow): Mon + Wed, 10:00, 8 weeks, 45-minute service -> "Timetable saved. Sessions booked: 16. Dates with conflicts: 0."; `/dashboard/schedule` week by week: 16 `Repeats` labels; family `/family/appointments`: "Every Mon, Wed at 10:00 am IST with Dr Speech E043 (synthetic)", sessions grouped by week |
| E-2 conflict | PASS | other family books Wed 15:00 (hold 201, confirm 200); series Mon/Wed 15:00 -> "Dates with conflicts: 1"; schedule `Conflicts` shows "18 November 2026 · 3:00 pm IST", "Time already taken"; `Pick another time` 16:00 -> occurrence confirmed at 16:00, list shows "No conflicts." |
| E-3 change from a date | PASS | `This and future sessions` from week 3 at 11:00: 4 sessions kept at 10:00, 12 cancelled (`series_changed`), 12 new at 11:00; after one outbox pass (deliveries mocked to a log) the family's in-app inbox has `Timetable changed` x1 and no `Appointment cancelled` |
| E-4 paper-consent child | PASS | case page shows "This child has no family app account (paper consent)..."; Thursday 12:00 series -> 4 sessions, `guardian_user_id` null, 0 outbox events for the series or its sessions |

Evidence files (session workspace `files/e2e043/`): `acceptance.cjs` / `acceptance.txt` (9 PASS), screenshots
`e1-case-timetable-375.png`, `e1-schedule-week1-375.png`, `e1-family-visits-375.png`, `e2-conflicts-375.png`,
`e2-resolved-375.png`, `e3-after-change-375.png`, `e3-family-375.png`, `e4-paper-child-375.png`, `verify.log`,
`vitest-series-verbose.txt`.

## Deviations

- **"This session only" Move uses 030 unchanged**, so a single session can only move to a bookable slot of 030's grid
  within 14 days (`slot_unavailable` / `too_far` otherwise; the form says so). Moving a conflicted date (`Pick another
  time`) is not limited that way: it accepts any time inside the weekly hours up to 120 days ahead.
- **Series times need not sit on the booking grid**: an occurrence is valid when it lies inside the weekly (or extra)
  hours and off blocked dates (`series_within_hours`), e.g. 10:00 with a 45-minute service and hours from 09:00. The
  agenda's "outside your hours" warning uses the same rule for series sessions.
- **Guardians are not offered `Reschedule` on series sessions** (only `Cancel`, FR-7); the 030 reschedule route itself is
  unchanged, so a guardian could still move their own session through the API within 030's rules.
- **One guardian per series**: `guardian_user_id` is the child's earliest active guardian link (`notify_family`, default
  on). Other linked guardians do not see the timetable in their Visits tab (same as 030's one booking guardian).
- **Pause**: one pause window at a time (a new one once the current one has ended); no "resume early" (use "This and
  future sessions" instead).
- **036 rating prompt** is withdrawn for series sessions (a prompt after every session would break FR-8's "no
  per-session messages"); the sessions stay rateable on `/family/appointments`.
- **Video series**: Meet links (037) are requested for the next session only, like reminders (`meet_status` starts
  `pending`); demo (`is_synthetic`) profiles cannot get a series.
- New WhatsApp templates `series_created` / `series_changed` need Meta approval (human task, listed in
  `docs/notifications.md`); in DEMO_MODE deliveries are mocked as for every other template.

## Notes

- **Schema for 044/045/047/052**: `appointment_series` (see `docs/booking.md` "Weekly series (043)"),
  `appointments.series_id` + `series_occurrence_date` (unique together), `series_conflicts`. Series sessions are
  ordinary `confirmed` appointments: attendance (044) can use `booking_complete` / `booking_cancel` as for one-offs.
  Billing (045/046): `appointment_series.billing_mode` and `service_snapshot.billing_mode` (`package` | `per_session` |
  `free`; `free` also sets the snapshot's `payment_mode` to `free`, fee 0). Series sessions never pass through
  `pending_payment`. Open question default kept: a series does not auto-end when a package runs out (045 should warn
  staff).
- **Helpers**: `lib/booking/series.ts` - `createSeries(...)` (047 import: `guardian: "auto" | null`), `changeSeriesFrom`,
  `pauseSeries`, `endSeries`, `resolveConflict`, `materializeSeries`, `materializeMany`, `materializeDueSeries` (cron),
  `listCaseSeries`, `listManageableConflicts(userId)` and `listGuardianSeries(userId)` (052 cards),
  `getManageableSeries` (FR-2 gate); `lib/booking/series-display.ts` - `seriesSummary`, `groupByWeek`,
  `occurrenceInstant`, `weekdayList`. SQL: `series_can_manage(org, profile, user)`, `series_slot_problem(...)`.
- **030 files touched additively**: `lib/booking/store.ts` (`AppointmentView.series_id` / `series_occurrence_date`;
  agenda warning rule for series sessions), `/api/cron/booking` (calls `materializeDueSeries()` after expiring holds).
- **Notifications**: topics `series.created`, `series.changed` (aggregate `appointment_series`, recipient
  `seriesGuardian`), templates `series_created`, `series_changed` (en/hi/te; hi/te drafts in `messages/REVIEW.md` /
  `docs/notifications.md` await native review like the rest).
- **No new env vars.** i18n: new `series.*` namespace (en/hi/te), `messages/REVIEW.md` regenerated (2570 rows).
- The acceptance run's synthetic accounts (`e043-*@example.test`, `E043 Centre ...`) and their series are left in the
  slot 6 database; the test suites clean up after themselves.
