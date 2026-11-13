# 046: Platform fee - Evaluation

## Setup

- 045 setup. `DEMO_MODE=true` (the fake gateway also fakes Route transfers). Org A policy 10% with a min of
  ₹20; org B flat ₹50, waived until the end of this month. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/platform-fee-*.test.ts --reporter=verbose` exits 0, covering:
  - Fee maths: percent, flat, min, cap, waiver, GST 18%.
  - One accrual per consultation under 3 retries.
  - Reversing attendance adds an adjustment.
  - Route: captured payment → transfer `on_hold`, amount = payment − fee − GST.
  - Release on completion; a refund before release reverses the transfer.
  - When Route is not active, a pending payout is recorded.
  - A statement = accrued − withheld ± adjustments; gap-free invoice numbers; the credit carries forward.
  - Members (not owner/admin) are blocked from `/dashboard/billing` (403).
  - A non-platform admin is blocked from `/admin/billing` (403).

## Acceptance checks

### E-1: Offline month (FR-2, FR-4)

Org A: 20 present sessions at ₹750 each, paid in cash. The statement shows 20 consultations, fee ₹1,500,
GST ₹270 and due ₹1,770. Issue it: the PDF has `DNM/2026-27/0001` and a pay link, and paying it sets the
statement to `paid`.

### E-2: Online split (FR-3)

A one-off online booking at ₹1,000 for org A (Route active) leads to a transfer of ₹882 on hold. Mark it
completed: the transfer is released and a `withheld` ₹118 row is added. The statement shows it as
already withheld.

### E-3: Waiver and transparency (FR-2, FR-7)

Org B: the owner sees the fee notice and accepts it. Sessions this month accrue ₹0, and no statement
amount is due.
