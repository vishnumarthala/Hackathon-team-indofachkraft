# 044: Attendance register - Evaluation

## Setup

- 043 setup plus an active Mon–Fri series with sessions today. `npm run db:migrate`, synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/attendance-*.test.ts --reporter=verbose` exits 0, covering:
  - present → `completed` and billable.
  - absent → `no_show`; billable only with `bill_absent`.
  - A late cancel inside the window is billable only with `bill_late_cancel`.
  - Centre cancel is never billable.
  - Marking before the start is rejected (409) except for cancel types.
  - A member correcting after 7 days gets 403; owner may, with reason, and it is audited.
  - A double submit creates one event.

## Acceptance checks

### E-1: Daily register (FR-3)

As the front desk, open `/dashboard/register` on a 390 px viewport, then mark 3 sessions present and 1
absent. Counts update and `Write note` appears on present rows.

### E-2: Family view (FR-7)

As the guardian, the past sessions show `Attended` / `Missed`, with the monthly line "3 of 4 sessions
attended".

### E-3: Needs attention (FR-4)

Leave yesterday's session unmarked. The dashboard shows it under `Needs attention`.
