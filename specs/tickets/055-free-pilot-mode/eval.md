# 055: Free pilot mode - Evaluation

## Automated checks

- `npm run typecheck` and `npm run lint` exit 0.
- Migration `20261120005500_free_pilot_mode.sql` applies on a local Supabase with all earlier migrations.
- `npx vitest run` (with the local test database) passes, including:
  - `tests/free-pilot.test.ts`: only `"true"` turns payments on (not `DEMO_MODE`, not the Razorpay keys); fee,
    package, payment and payout pages are 404 and the checkout page redirects to the appointment page; fee, package,
    payout and payment-link APIs answer `404 payments_disabled`; payment-order / verify / demo answer
    `409 payments_disabled`; both money crons skip behind `CRON_SECRET`; every payment / fee / payout notification
    kind is suppressed and nothing else; `enqueue` writes nothing; the booking flow shows "Free during the pilot" and
    "Confirm booking" (payments on: the fee and "Continue to payment").
  - `tests/booking-state-machine.test.ts` (DB): with payments off, a paid in-clinic and a paid video service confirm
    directly, the snapshot is free (`free_pilot`), `appointment.confirmed` is enqueued, a payment order is 409.
  - `tests/fees-flow.test.ts` (DB): with payments off and an active package, marking present (register and 030's
    `Mark completed`) is not billable, uses no package session, writes no ledger row; a correction too; fee APIs 404.
  - `tests/outbox.test.ts` (DB): a payment kind is not enqueued, a SQL-enqueued receipt fans out to nobody, a payment
    notification fanned out earlier is skipped with `payments_disabled`; with payments on the kind is enqueued.
  - `tests/next-step-rules.test.ts`: no Pay step and no Pay action with payments off.
  - `tests/parent-landing.test.ts`: `/for-centres` in en/hi/te shows the pilot copy, no packages / payouts / platform
    fee; with payments on, the paid model as before.
  - Every existing payment, fee, payout, booking and next-step suite passes with `PAYMENTS_ENABLED=true` stubbed.
  - i18n parity and copy rules; `messages/REVIEW.md` regenerated.

## Acceptance checks

### E-1: Free booking (FR-2)

Without `PAYMENTS_ENABLED`, book a paid in-clinic service on `/book/<profile>` as a guardian: the summary says "Free
during the pilot", the button says "Confirm booking", and you land on `/family/appointments/<id>?booked=1` with a
confirmed visit. Opening `/book/<profile>/pay/<id>` goes to the same appointment page.

### E-2: Attendance without charges (FR-4)

Mark the session present in `/dashboard/register`: the row says Attended with no Billable label; the case has no Fees
tab; `/cases/<id>/fees` is 404.

### E-3: No money surfaces (FR-4, FR-5, FR-6)

The dashboard top bar has no Fees link, `/admin` has no Payouts link, `/dashboard/payouts` and `/admin/payouts` are 404,
the family home never shows a Pay card.

### E-4: Switch back on (NFR-1)

Set `PAYMENTS_ENABLED=true` and restart: the paid booking goes to checkout again, Fees and Payouts are back, and the
pilot booking from E-1 stays free.

### E-5: /for-centres (FR-8)

In English, Telugu and Hindi the page says "Free for pilot centres." and shows the family app and intake call items,
with no packages, payouts or platform fee.
