# 052: Clear next steps - Evaluation

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/next-step-*.test.ts tests/dashboard-today-*.test.ts --reporter=verbose` exits 0,
  covering:
  - The next-step priority table, with one test per rule, including several children at once.
  - Other guardians' children never appear.
  - Provider Today counts per role; a member sees only their own sessions; another org's data → none.
  - The case default tab before and after the assessment.
  - There's no "Coming soon" string left in `messages/*.json`.

## Acceptance checks

### E-1: New parent (FR-1)

A guardian with no child sees "Enter your clinic code" and "Find a therapist". Both work.

### E-2: Invited parent before the first visit (FR-1, FR-6)

The child has an appointment, permission is missing, and the intake isn't done. The Next step is
`Give permission`; after giving it, it becomes `Start the intake call`. The appointment timeline shows
the steps.

### E-3: Mobile nav (FR-3)

At 390 px, the bottom nav shows 5 items and the Messages badge counts unread messages.

### E-4: Therapist morning (FR-4)

A therapist with 4 sessions today, 1 note missing from yesterday and 2 ISAA items unconfirmed sees all
of them in Today. One-tap `Present` works from the dashboard.
