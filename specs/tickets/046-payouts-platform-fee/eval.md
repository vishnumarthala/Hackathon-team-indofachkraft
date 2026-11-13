# 046: Payouts and platform fee - Evaluation

## Setup

- 045 setup. `DEMO_MODE=true` (the fake gateway also fakes Route transfers, reversals and their
  webhooks).
- Org A: active payout account, policy 10% with a min of ₹20.
- Org B: payout account `pending_kyc`, flat ₹60, waived until the end of the month.
- Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/payouts-*.test.ts --reporter=verbose` exits 0, covering:
  - Fee maths: percent, flat, min, cap, waiver, GST 18%; net = consultation − fee − GST.
  - Exactly one payout item per consultation under 3 retries.
  - The sum of transfers from one package payment never exceeds the payment.
  - A one-off booking transfers only on completion; a provider no-show → no transfer.
  - A refund after a transfer → reversal first, then refund.
  - Package expiry with `pay_centre` versus `refund_family`.
  - Org B cannot publish an online service (409) and its paid services are hidden.
  - A `transfer.failed` webhook → retries → shows in admin.
  - Reconciliation flags a mismatch.
  - A member who is not owner/admin cannot see `/dashboard/payouts` (403).

## Acceptance checks

### E-1: Package paid out per session (FR-3, FR-7)

Org A sells a ₹9,000 / 12-session package. Each present session creates a payout item: consultation
₹750, fee ₹75, GST ₹13.50, net ₹661.50. It is transferred and shows in `/dashboard/payouts`.

### E-2: One-off booking (FR-4)

A ₹1,000 online booking at org A is completed: fee ₹100, GST ₹18, and ₹882 is transferred.

### E-3: Payout setup gate and waiver (FR-2, FR-8)

Org B's owner sees "Finish payout setup". Once the admin activates the account, the owner accepts the
fee notice. Sessions this month have fee ₹0 and net = consultation.

### E-4: Monthly invoice (FR-7)

The cron job for last month creates `DNM-INV/2026-27/0001` for org A with the fee and GST totals.
