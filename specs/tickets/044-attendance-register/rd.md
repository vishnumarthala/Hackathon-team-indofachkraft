# 044: Attendance register

**Status:** done
**Mode:** solo
**Runs:** waits for 043: marks attendance on series occurrences

## Summary

Centres record attendance every day. Attendance drives three things: what the family is charged (045),
the platform fee (046), and the progress record. This ticket adds a fast **daily register** for
therapists and front desk. It also adds a clear **attendance outcome** on every appointment, plus a
monthly attendance summary per child for staff and parents.

Source: [PMF check](../../grill/doctornearme-pmf-check.md) §3c; product owner decision 2026-11-13 (Q3 "yes").

## Functional requirements

- **FR-1** – Migration `<ts>_attendance.sql`: `appointments.attendance` text null, check in
  `('present','absent','late_cancel_family','cancelled_centre')`, plus `attendance_marked_by`,
  `attendance_marked_at` and `billable boolean`.
  - `present` → calls `booking_complete(..., 'completed')`.
  - `absent` → calls `booking_complete(..., 'no_show')`.
  - `late_cancel_family` and `cancelled_centre` use 030's cancel path with reasons `late_cancel_family` and
    `centre_cancelled`.
  - The 030 state history records every change.
- **FR-2** – `billable` is computed when attendance is marked, from the org policy
  `organizations.attendance_policy jsonb` (`{ bill_absent: bool, bill_late_cancel: bool,
  late_cancel_hours: int }`). Defaults: absent and late cancellations are **not** billable,
  `late_cancel_hours = 24`.
  - `present` is always billable when the fee is greater than 0.
  - `cancelled_centre` is never billable.
- **FR-3** – Register UI `/dashboard/register`:
  - Shows today's sessions for the org (owner/admin see all; members see their own), grouped by therapist
    and time.
  - Each row has one-tap `Present` / `Absent` / `Late cancel` / `Centre cancelled`, plus `Mark all
    remaining present`.
  - A date picker allows corrections for the last 7 days only; older dates need owner/admin.
  - Corrections are audited with a reason.
- **FR-4** – Attendance can only be marked from the start time onwards (cancel types can be marked any
  time before). Unmarked sessions older than 24 h appear in a `Needs attention` list on the dashboard.
- **FR-5** – A `Present` row links to the session note / scribe (038) for that appointment
  (`Write note`).
- **FR-6** – Monthly summary per child: the case page tab `Attendance` shows a calendar of the month with
  counts (attended / absent / cancelled). Export as CSV for staff.
- **FR-7** – Family view: in `/family/appointments`, past sessions show `Attended`, `Missed` or `Cancelled
  by centre`. A monthly line reads "8 of 10 sessions attended in November".
- **FR-8** – Audit events `appointment.attendance_marked` and `appointment.attendance_corrected` record
  actor, from, to and reason.

## Non-functional requirements

- **NFR-1** – The register loads in < 1 s for 60 sessions/day and works on a 390 px phone (front desk
  often uses a phone).
- **NFR-2** – Marking is idempotent; a double tap does not create two events.

## Affected areas

- `supabase/migrations/<ts>_attendance.sql` (new); `lib/booking/attendance.ts` (new)
- `app/dashboard/register/**` (new), `app/api/appointments/[id]/attendance/route.ts` (new)
- `app/cases/[id]/**` (Attendance tab), `app/family/appointments/**`, `/dashboard` (Needs attention)
- `lib/audit/**`, `messages/{en,hi,te}.json`, `tests/attendance-*.test.ts` (new)

## Don't touch

- Existing migrations; 030 functions' semantics (call them); `BOARD.md`.

## Out of scope

- Therapist payroll and timesheets.
- Biometric or QR check-in.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Storage | Column on `appointments`, mapped onto 030 statuses | One source of truth |
| D-2 | Billing defaults | Absent and late cancel not billable unless the org turns it on | Kind to families; centres choose |
| D-3 | Correction window | 7 days for members, unlimited for owner/admin, always audited | Fees depend on it |
