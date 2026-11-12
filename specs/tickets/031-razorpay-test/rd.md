# 031: Razorpay payments (test mode)

**Status:** draft
**Mode:** solo
**Runs:** waits for 030: pays for `pending_payment` appointments

## Summary

Online prepayment for services with `payment_mode = 'online'` using Razorpay Orders + Checkout in
**test mode only**. Payment state is its own record, separate from appointment state (rule 12);
webhooks are signature-verified and idempotent; a payment that arrives after the hold expired is
handled deterministically (re-book if still free, otherwise refund).

## Functional requirements

- **FR-1** - Migration `<ts>_payments.sql`: `payments(id, appointment_id, razorpay_order_id unique,
  razorpay_payment_id unique null, amount_paise int, currency 'INR', status text check in ('created',
  'authorized','captured','failed','refund_pending','refunded'), refund_id null, failure_reason, created_at,
  updated_at)`; `payment_events(id, razorpay_event_id text unique, event_type, payload jsonb (stripped of
  card/VPA details), received_at, processed_at, outcome)`. At most one non-failed payment per appointment.
- **FR-2** - Env `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; `lib/payments/razorpay.ts`
  refuses to start (throws) if `RAZORPAY_KEY_ID` does not start with `rzp_test_` (D-1). `DEMO_MODE`
  uses a fake gateway with deterministic ids.
- **FR-3** - `POST /api/appointments/:id/payment-order` (guardian owner, status `pending_payment`, hold
  unexpired) -> creates a Razorpay order (`amount = fee_inr * 100`, `receipt = appointment id`,
  `notes.appointment_id`) once (idempotent: existing `created` order returned) -> 200 `{ key_id, order_id,
  amount_paise, currency, prefill: { name } }`.
- **FR-4** - Checkout page `/book/[profileId]/pay/[appointmentId]`: loads `https://checkout.razorpay.com/v1/checkout.js`
  (allowed only on this route - CSP exception), shows amount via `formatInr`, countdown, `Pay now`. On
  success handler: `POST /api/payments/verify` `{ razorpay_order_id, razorpay_payment_id,
  razorpay_signature }` -> verifies `HMAC_SHA256(order_id + "|" + payment_id, key_secret)` with
  constant-time compare (400 on mismatch); then the same `apply_payment_captured` path as the webhook.
- **FR-5** - Webhook `POST /api/webhooks/razorpay` (public): verify `X-Razorpay-Signature` over the raw
  body with `RAZORPAY_WEBHOOK_SECRET` (401 on failure); dedupe by `x-razorpay-event-id` (duplicate ->
  200 `{ received: true, duplicate: true }`); handle `payment.authorized`, `payment.captured`,
  `payment.failed`, `refund.processed`; unknown events -> 200 ignored.
- **FR-6** - `apply_payment_captured(order_id, payment_id)` SQL function (one transaction, idempotent):
  payment -> `captured`; appointment `pending_payment` and unexpired -> `confirmed` (030 outbox events);
  appointment `expired`/`cancelled` (late payment) -> try `booking_hold`+`confirm` for the same slot
  atomically; if the slot is taken -> payment `refund_pending`, enqueue `payment.refund_needed` job which
  calls Razorpay refund API and sets `refunded`; guardian notified `Your payment was refunded because
  the time was no longer available.` Already `confirmed` -> no-op.
- **FR-7** - Cancellation of a paid appointment by the provider -> full refund; by the guardian >= 24 h
  before start -> full refund, later -> no refund (policy text shown before payment). Refunds via outbox job.
- **FR-8** - Guardian `/family/appointments` shows payment status (`Paid`, `Payment pending`, `Refunded`);
  provider agenda shows `Paid online` / `Pay at clinic`.

## Non-functional requirements

- **NFR-1** - No card/UPI details stored or logged; `payment_events.payload` stripped.
- **NFR-2** - Webhook handler responds < 2 s; heavy work goes to the outbox.
- **NFR-3** - Register `payments` in the 041 privacy registry.

## Affected areas

- `supabase/migrations/<ts>_payments.sql` (new); `lib/payments/**` (new)
- `app/api/appointments/[id]/payment-order/route.ts`, `app/api/payments/verify/route.ts`, `app/api/webhooks/razorpay/route.ts` (new)
- `app/book/[profileId]/pay/[appointmentId]/**` (new); `/family/appointments`, provider agenda (status labels)
- `lib/notify/topics.ts`, `lib/privacy/registry.ts`, `lib/auth-access.ts`, `.env.example`, `messages/*.json`
- `tests/razorpay-signature.test.ts`, `tests/payments-flow.test.ts` (new)

## Don't touch

- Booking state machine internals (030) except calling its functions; existing migrations; `BOARD.md`

## Out of scope

- Live mode, payouts/settlements to providers (Razorpay Route), invoices/GST, coupons, UPI intent flows.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Mode | Test keys only; live keys rejected | plan §2 "Booking ... Razorpay test mode" |
| D-2 | State separation | `payments` table; appointment only moves via 030 functions | rule 12 |
| D-3 | Late payment | Re-book same slot if free, else auto-refund | rule 12 |
| D-4 | Webhooks | Signed, deduped by event id | rule 12 |

## Open questions

- Refund policy wording per org (product/legal).
