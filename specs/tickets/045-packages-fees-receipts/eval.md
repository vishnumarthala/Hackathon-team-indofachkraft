# 045: Packages, fee ledger and receipts - Evaluation

## Setup

- 044 setup. A package "12 sessions / ₹9,000 / 30 days" for the speech service. `DEMO_MODE=true` for the fake
  Razorpay gateway (payment links). Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/fees-*.test.ts --reporter=verbose` exits 0, covering:
  - Selling a package creates a charge of 900000 paise.
  - 12 present sessions → `used_up`; consultation amounts are 75000 each (remainder rule tested with
    ₹10,000 / 12).
  - A non-billable absent session uses no package session.
  - A per-session billable session creates a charge.
  - Receipt numbers are gap-free under 20 parallel payments, and the FY rolls over on 1 April.
  - An adjustment reverses a payment; direct updates and deletes raise.
  - A payment-link webhook that is duplicated or tampered → no-op or 401.
  - A member who is not owner/admin cannot record a payment (403).

## Acceptance checks

### E-1: Sell, attend, receipt (FR-2, FR-4, FR-5)

Sell the package and record a UPI payment of ₹9,000. Receipt `ORG/2026-27/0001` appears; the guardian sees
it under Payments and gets the WhatsApp/in-app notice. Mark 3 sessions present: the Fees tab shows
"9 sessions left".

### E-2: Online link (FR-4)

Use `Send payment link` and complete it with the fake gateway. The payment entry is recorded with method
`razorpay`, and the balance drops to 0.

### E-3: Warnings (FR-7)

Use 10 of 12 sessions. Staff see the "2 sessions left" badge, and the guardian gets one reminder.
