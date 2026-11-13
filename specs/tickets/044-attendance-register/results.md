# 044: Attendance register - Results

Branch: `ticket/044-attendance-register` (worktree `dnm-worktrees/044`). Tested against the local Supabase stack in slot 6
(all migrations re-applied by `dnm-db.sh 6 <worktree> reset`, incl. the new `20261113004400_attendance.sql` and
`20261113004401_import_series_undo.sql`), `DEMO_MODE=true`, dev server on port 3060, headless Chromium at 390 px
(`timezoneId` Asia/Kolkata). Synthetic accounts and data only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0 |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (DB suites running, slot 6) | PASS | 95 files, 1597 passed, 11 skipped. The 11 skips are the pre-existing opt-in suites (`intake-completion` needs `CT_DB_TESTS=1`, the live `no-tracking` crawl), unchanged; every DB suite ran |
| `npm run build` | PASS | exit 0; `/dashboard/register`, `/cases/[id]/attendance`, `/api/appointments/[id]/attendance`, `/api/attendance/mark-all`, `/api/orgs/[id]/attendance-policy`, `/api/cases/[id]/attendance`, `/api/org/import/[id]/schedule` in the route list; only the pre-existing `lib/demo.ts` tracing warning |
| `npm run verify` | PASS | its four steps above, each exit 0 |
| `npx vitest run tests/attendance-*.test.ts --reporter=verbose` | PASS | 2 files, 28 passed (`attendance-register.test.ts` 17 DB tests through the route handlers, `attendance-display.test.ts` 11 pure tests) |
| - present -> `completed` and billable | PASS | 200 `{ result: marked, status: completed, billable: true }` (fee 800); one `appointment_events` row confirmed -> completed by the front desk; strict audit `appointment.attendance_marked` `{ from: null, to: present, billable: true }`; a free session -> `billable: false` |
| - absent -> `no_show`, billable only with `bill_absent` | PASS | default policy -> `billable: false`; after `PUT /api/orgs/:id/attendance-policy { bill_absent: true }` -> `true`; the earlier session keeps `false` |
| - late cancel inside the window billable only with `bill_late_cancel` | PASS | a session in a few hours: 030 cancel path (`cancel_reason late_cancel_family`, `cancelled_by provider`, history, one `appointment.cancelled`), `billable: false`; with `bill_late_cancel` -> `true`; 72 h ahead (outside 24 h) -> `false`; recorded after the start -> `true`, no message |
| - centre cancel never billable | PASS | every rule on (`168` h) -> `billable: false` before and after the start; `cancel_reason centre_cancelled` |
| - marking before the start rejected (409) except cancel types | PASS | present / absent on a future session -> 409 `not_started`, status unchanged; `cancelled_centre` -> 200 |
| - member correcting after 7 days 403; owner may, with reason, audited | PASS | member on an 8-day-old session -> 403 `correction_window` (marking and correcting); owner marks it; correction without a reason -> 422 `reason_required`; with a reason -> `corrected`, history `completed -> no_show` with `attendance_corrected:present->absent: Marked the wrong child`, audit `appointment.attendance_corrected { from, to, reason }`; a member corrects their own 3-hour-old session with a reason |
| - a double submit creates one event | PASS | two parallel identical POSTs -> `marked` + `unchanged`, 1 history row, 1 audit row; a third POST -> `unchanged` |
| Authz | PASS | other org's provider 404; a member on another therapist's session 404; guardian 403; anonymous 401; malformed / unknown id 404; bad value 400; case month: other org 404, guardian 403; policy: member reads, member PUT 403, other org 404 |
| NFR-1: 60 sessions/day < 1 s | PASS | `loadRegister` with 71 sessions (60 seeded for 3 therapists) in 5 ms (test log `044 NFR-1`); the register page in the browser: 326 ms on the dev server; 390 px: `scrollWidth 390` |
| E-1 daily register (FR-3) | PASS | front desk (org admin) at 390 px: 5 rows under `Dr Speech E044 (synthetic)` (four started weekly-series sessions + one later today); tapping Present x3 and Absent x1 -> counts `Present: 0 · Absent: 0 · Cancelled: 0 · Not marked: 5` -> `Present: 3 · Absent: 1 · Cancelled: 0 · Not marked: 1`; `Write note` on the 3 present rows (`/cases/:id/sessions/new?appointment=:id`, the scribe form opens with that appointment selected); labels `Present · Billable` / `Absent · Not billable`; the later row: Present/Absent disabled with "Starts at 5:53 am IST...", cancel types enabled; a correction through the inline reason form is audited with its reason |
| E-2 family view (FR-7) | PASS | guardian at 390 px: past sessions `Attended, Missed, Attended, Attended`; line "3 of 4 sessions attended in November"; no overflow |
| E-3 needs attention (FR-4) | PASS | yesterday's session (26 h ago) left unmarked -> `/dashboard` `Needs attention` lists it; `Mark on the register` opens `/dashboard/register?org=..&date=<yesterday>`; after marking it the section is gone |
| FR-6 case `Attendance` tab | PASS | month calendar (Monday first) + counts `Attended: 4 · Absent: 1 · Cancelled: 0 · Not marked: 0` (future sessions shown as `Upcoming`), 390 px; `Download CSV` 200 `text/csv` with UTF-8 BOM, 11 sessions; guardian -> 403 |
| FR-2 org policy | PASS | defaults `{ bill_absent: false, bill_late_cancel: false, late_cancel_hours: 24 }` for every organisation (column default = backfill); owner/admin form on the register; 400 for out-of-range hours / wrong types; the database check refuses malformed JSON; strict audit `org.attendance_policy_changed { from, to }` |
| 030 complete route stays in step | PASS | `Mark completed` / `No-show` on `/dashboard/schedule` -> `attendance present/absent`, `billable` and `attendance_marked_by` filled (trigger + same transaction) |
| Weekly series (043) session | PASS | a series occurrence time-travelled into the past is marked present like any other (`completed`, billable) |
| Late-cancel refund rule (031) | PASS | online prepayment + `late_cancel_family`: not billable -> `refund_pending` (`guardian_cancelled`); billable -> stays `captured`; centre cancel -> `refund_pending` (`provider_cancelled`) |
| i18n | PASS | `attendance.*`, `caseTabs.attendance`, `childImport.schedulePending*` / `billing_mode_invalid` in en/hi/te; `messages/REVIEW.md` regenerated (2763 rows); `tests/i18n-keys.test.ts` green |

Evidence files (session workspace `files/e2e044/`): `acceptance.cjs` / `acceptance.txt` (21 PASS, 0 FAIL), screenshots
`e1-register-before-390.png`, `e1-register-after-390.png`, `e1-correction-390.png`, `fr5-write-note-390.png`,
`e2-family-390.png`, `e3-needs-attention-390.png`, `fr6-case-attendance-390.png`, `vt-att.log` (verbose attendance
tests), `vitest-full.log`.

## Extra scope (047 import + 043 series)

| Check | Result | Evidence |
|-------|--------|----------|
| (a) the import creates the series through 043's `createSeries` | PASS | `tests/import-children.test.ts` "044: the import creates a 043 weekly series": `Mon;Wed;Fri 10:00` + `billing_mode package` -> one `appointment_series` (weekdays `[0,2,4]` in 043's Monday-first numbering, `billing_mode package`, `guardian_user_id null`), >= 23 confirmed sessions all at 10:00 IST on Mon/Wed/Fri, `series_created_count 1`, `timetable_pending_count 0`; no outbox events for the series or its sessions (047 NFR-2 holds). Empty `billing_mode` -> `per_session`; `free` accepted; anything else -> row error `billing_mode_invalid` |
| (b) schedule pending timetables (button + script), idempotent | PASS | an import made "before 043" (scheduler unavailable) keeps the timetable `pending`; `POST /api/org/import/:id/schedule`: member 403, other org 404, anonymous 401, owner 200 `{ scheduled: 1, pending: 0 }` (Sun -> 043 weekday 6), again `{ scheduled: 0, pending: 0 }`, one series only, counts updated, strict audit `children.import_timetables_scheduled`; `schedulePendingTimetables({ orgId })` (what `npm run import:schedule-pending` runs) schedules a second import once and nothing on the next run; the script itself: `{"imports":0,"scheduled":0,"pending":0}` exit 0 |
| (c) undo also removes the import's series and their future untouched sessions | PASS | undo -> 200 `{ result: undone, cases: 1, children: 1, series: 1, sessions: N }`; series and sessions deleted; audit `children.import_undone` carries `series` / `sessions` |
| (c) safety checks not weakened | PASS | one series session cancelled -> 409 `blocked_rows [2]`, nothing deleted; a paused series -> 409; all of 047's existing undo tests (session note, used code, expired window, already undone) still pass with the new function |

## Deviations

- **Transitions 030 has no function for.** First markings call 030's `booking_complete` / `booking_cancel` as FR-1 asks.
  Two cases are written by `attendance_mark()` itself (one transaction, row lock, a row in 030's `appointment_events`):
  a cancel type recorded **after** the start (030's cancel refuses `too_late`; the register must still record "the
  family cancelled this morning"; no message is sent, unsent reminders are withdrawn) and **corrections** between
  outcomes (030 only moves `confirmed` -> `completed` / `no_show`). 030's functions are unchanged.
- **Who may mark.** 043's `series_can_manage` rule (active member who is owner/admin, or the therapist bound to the
  session's profile), stricter than 030's `booking_is_provider` (which does not check membership). Members who are not
  therapists (e.g. a front desk invited as `member`) see an empty register: front desk staff should be `admin`.
- **"Late" is measured at marking time.** `late_cancel_hours` is compared with when the cancellation is recorded (the
  register has no separate "family called at" field); recorded after the start = inside the window.
- **A `Centre cancelled` / `Late cancel` tap on a future session really cancels it** (030's path; the family gets 030's
  cancellation message), so the register asks first. There is no "back to unmarked" (re-booking a cancelled slot would
  need 030's availability checks): rebook through the schedule instead.
- **`Write note`** links to 038's upload form only for in-clinic sessions (the scribe is in-clinic only); present video
  sessions show `Open case` instead.
- **031's refund trigger replaced** (`payments_on_appointment_cancelled`, new migration): a centre-recorded late family
  cancellation keeps an online prepayment when it is billable and refunds it as a family cancellation otherwise.
  Absences of online one-offs keep their payment whatever `bill_absent` says (031 unchanged) - left to 045.
- **Mon-Fri needs two series.** 043 allows 1-4 weekdays per series, so the eval's "Mon-Fri series" was set up as
  Mon/Tue/Wed + Thu/Fri (both through 043's API).
- **Import undo function renamed.** The new migration must be named `...004401`, which sorts before 047's
  `...004700` (`create or replace function undo_child_import`); redefining that name would be overwritten on a fresh
  database. The new version is `undo_child_import_with_series()` (compiled lazily, `check_function_bodies = off`);
  047's function stays unused.

## Notes

- **Schema (045/046/052):** `appointments.attendance` (`present` | `absent` | `late_cancel_family` | `cancelled_centre`),
  `attendance_marked_by`, `attendance_marked_at`, `billable` (always non-null once marked; check constraints keep it in
  step with `status`); `organizations.attendance_policy jsonb`. Legacy completed / no-show rows were backfilled
  (`billable` by the default policy). `billable` is computed at marking / correction time and never rewritten by later
  policy changes; corrections can flip it (045/046 must handle credits/refunds for already-charged sessions). Use
  `attendance_marked_at` as the charge event time and `appointment_events` for history.
- **Helpers:** `lib/booking/attendance.ts` - `markAttendance(id, actor, attendance, reason?)` (strict audit),
  `loadRegister`, `groupByTherapist`, `listNeedsAttention(userId)`, `listCaseAttendance`, `getAttendancePolicy` /
  `setAttendancePolicy`; `lib/booking/attendance-display.ts` (pure: `effectiveAttendance`, `attendanceCounts`,
  `monthlyAttendance`, `familyAttendanceLabel`, `monthGrid`, `attendanceCsv`, ...). SQL: `attendance_mark`,
  `attendance_billable`, `attendance_billable_for`, trigger `appointments_attendance_sync`.
- **052:** `<NeedsAttention userId={user.id} limit? />` (`components/attendance/NeedsAttention.tsx`) is a self-contained
  server component (fetches its data, renders nothing when empty); it is on `/dashboard` above the cases list.
- **Strict audit actions added:** `appointment.attendance_marked`, `appointment.attendance_corrected`,
  `org.attendance_policy_changed`, `children.import_timetables_scheduled`. `AppointmentView` gained `attendance` and
  `billable`; the privacy export of appointments includes `attendance`.
- **Import (047) changes:** optional CSV column `billing_mode`; `lib/import/schedule.ts` (server: scheduler,
  `schedulePendingTimetables`), `lib/import/timetable.ts` stays client-safe; `createSeries(args, tx?)` can run inside a
  caller's transaction; script `npm run import:schedule-pending [-- --org <id>]`.
- **No new env vars, no new dependencies.** i18n: new `attendance.*` namespace (hi/te drafted by this worker, `pending`
  in `messages/REVIEW.md`).
- The acceptance run's synthetic accounts (`e044-*@example.test`, `E044 Centre ...`) and their series are left in the
  slot 6 database; the test suites clean up after themselves.
