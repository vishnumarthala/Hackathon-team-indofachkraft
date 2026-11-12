# 031: Razorpay test payments - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes: raw request body in route
  handlers, `next/script`) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- `DEMO_MODE=true` uses the fake gateway; optional manual run with Razorpay **test** keys (human).
- Accounts/data: 030 setup plus an `online` service with fee ₹500 for `provider_a`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>` and `npm run -s outbox:run`. Synthetic data only;
  Razorpay test card numbers only in manual runs.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/razorpay-signature.test.ts tests/payments-flow.test.ts --reporter=verbose` exits 0:
  checkout signature and webhook signature (valid, tampered body, wrong secret), constant-time compare
  used, duplicate event id no-op, `rzp_live_` key rejected at startup, `apply_payment_captured`
  idempotency (called 3x -> one confirmation, one outbox event), late payment with free slot -> confirmed,
  late payment with taken slot -> refund path.

## Acceptance checks

### E-1: Happy path (FR-3, FR-4, FR-6)

Book the online service as `guardian_a` -> `Continue to payment` -> fake gateway success -> appointment
`confirmed`, payment `captured`, confirmation notification. Webhook replay of the same event ->
`duplicate: true`, no change.

### E-2: Webhook security (FR-5)

POST a webhook with a wrong signature -> 401, nothing stored. Unknown event type -> 200 ignored.

### E-3: Late payment (FR-6)

1. Let the payment hold expire (set `hold_expires_at` in the past, run booking cron) then deliver
   `payment.captured`: slot still free -> appointment confirmed.
2. Repeat but have `guardian_b` book the slot first -> payment `refund_pending` -> `refunded` (fake
   gateway), guardian notified with the refund message; `guardian_b`'s appointment untouched.

### E-4: Cancellation refunds (FR-7)

Provider cancels a paid appointment -> refund. Guardian cancels 3 h before start -> no refund, policy
text was shown before payment (screenshot).

### E-5: Authz negatives

`guardian_b` requests a payment order for `guardian_a`'s appointment -> 404. Payment order for a
`confirmed` free appointment -> 409.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
