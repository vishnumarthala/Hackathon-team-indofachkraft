# 030: Availability and atomic booking - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, add `CRON_SECRET=test-<port>`, `npm install`, `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; `provider_a` with a verified listed profile
  (028), one in-clinic 30-min `free` service and one video 45-min `at_clinic` service, rules Mon-Sat
  10:00-13:00 IST. `guardian_a` with a linked child, `guardian_b` with a linked child.
- Start: `DEMO_MODE=true npm run dev -- -p <port>` and `npm run -s outbox:run`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/booking-slots.test.ts tests/booking-state-machine.test.ts tests/booking-concurrency.test.ts --reporter=verbose` exits 0:
  - slots: rules, whole-day and partial overrides, extra hours, buffer, 2 h lead time, 14-day horizon,
    IST rendering across midnight UTC;
  - state machine: every allowed transition and every invalid one (409), hold expiry -> 410, owner
    mismatch -> 404, idempotency key replay;
  - concurrency (real DB, parallel connections): 50 simultaneous holds on one slot -> 1 success, 49
    `slot_taken`; 30-min and 45-min services overlapping -> 1 success; two reschedules into the same
    slot -> 1 success, loser keeps the original appointment; back-to-back `[10:00,10:30)` and
    `[10:30,11:00)` both succeed (half-open);
  - expired holds no longer block (expired in-transaction by the next hold).

## Acceptance checks

### E-1: Book in-clinic free service (FR-2, FR-3, FR-7)

1. Anonymous: `/p/<slug>` -> `Book` -> pick tomorrow 10:30 -> `Continue` -> countdown shown -> sign in as
   `guardian_a` -> hold attached -> choose child -> disclosure shown -> `Confirm booking`.
2. `appointments` row `confirmed` with `service_snapshot`; `appointment_events` has held->confirmed.
3. Outbox: confirmation in-app + email (with `.ics`), reminders scheduled with `deliver_after` 24 h / 2 h
   before start. WhatsApp `skipped` without config.

### E-2: Conflict and expiry (FR-4, FR-5)

1. `guardian_b` tries the same slot -> FR-4 409 message; slot not offered after refresh.
2. Hold a slot as `guardian_b`, wait > 10 min (or set `hold_expires_at` in the past), run cron ->
   `expired`; confirm -> 410 message; slot available again.

### E-3: Cancel / reschedule (FR-3)

1. `guardian_a` reschedules to 11:00 -> new appointment confirmed, old `cancelled` with link; reminders of
   the old one `cancelled`, new ones scheduled.
2. Cancel within 2 h of start as guardian -> 409.
3. Provider cancels -> guardian notified.

### E-4: Provider schedule (FR-8)

Block tomorrow entirely -> no slots tomorrow; existing confirmed appointment remains and is listed with
a warning. `Mark completed` before start -> 409; after start (time-travel via SQL) -> `completed`.

### E-5: Authz negatives

`guardian_b` confirms/cancels `guardian_a`'s appointment -> 404. Guardian confirms with a child not
linked to them -> 422. `provider_b` edits `provider_a`'s availability -> 403/404. Anonymous confirm -> 401.

## Definition of done

- [ ] All checks pass with evidence in `results.md` (concurrency test output attached).
- [ ] A builder reviews results and manually merges the passing ticket branch.
