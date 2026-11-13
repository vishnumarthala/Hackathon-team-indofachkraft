# 043: Recurring therapy sessions - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` before coding (Next.js 16.4).
- `npm install`, `npm run db:migrate`, `npm run seed:demo`. Synthetic data only.
- Data: org with `provider_a` (speech, weekly hours Mon–Fri 09:00–17:00), an `in_clinic` 45-minute
  service, child with an active case, guardian linked.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/series-*.test.ts --reporter=verbose` exits 0, covering:
  - Mon/Wed/Fri series → 24 occurrences in 8 weeks.
  - Running materialize twice creates no duplicates.
  - An occurrence that clashes with a one-off booking → a `slot_taken` conflict and no appointment.
  - A blocked date → a `blocked_date` conflict.
  - "This and future" splits the series and cancels only future, untouched rows.
  - Pause cancels the range; past rows stay unchanged.
  - A non-member provider gets 404; a guardian cannot create a series (403).
  - Concurrent materialize (2 workers) causes no duplicates or errors.

## Acceptance checks

### E-1: Create a timetable (FR-2, FR-3, FR-6)

On the case page, create Mon/Wed 10:00 for 8 weeks. The schedule shows 16 sessions with the "repeats"
marker, and the family Visits tab shows "Every Mon, Wed at 10:00".

### E-2: Conflict (FR-3, FR-6)

Book a one-off appointment for Wednesday next week at 10:00, then create the series. The Conflicts list
shows that date; `Pick another time` resolves it.

### E-3: Change from a date (FR-5)

Move the series to 11:00 from week 3. Weeks 1–2 stay at 10:00, weeks 3+ move to 11:00, and the family
gets one change message.

### E-4: Paper-consent child (FR-2, FR-8)

Create a series for a child with no guardian account. Appointments are created and no notification is
queued.
