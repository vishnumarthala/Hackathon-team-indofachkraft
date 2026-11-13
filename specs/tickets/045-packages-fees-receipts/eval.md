# 045: Packages and family payments - Evaluation

## Setup

- 044 setup. Package "12 sessions / ₹9,000 / 30 days" for the speech service. `DEMO_MODE=true` (the fake
  gateway supports payment links). Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/fees-*.test.ts --reporter=verbose` exits 0, covering:
  - `at_clinic` is rejected for new services, and existing ones migrate to `online`.
  - A package offer → payment link → a webhook `payment_link.paid` (duplicated → no-op; tampered → 401)
    → the package is active and the ledger has a charge and a payment.
  - 12 present sessions → `used_up`; consultation amounts are 75000 each (remainder tested with
    ₹10,000 / 12).
  - An absent, non-billable session uses no package session.
  - A billable session without a package → a charge plus a link.
  - Receipt numbers are gap-free under 20 parallel captures, and the FY rolls over on 1 April.
  - A refund of unused sessions has the right amount.
  - Ledger updates and deletes raise.
  - Members who are not owner/admin get 403.

## Acceptance checks

### E-1: Package at the desk (FR-3, FR-6)

Staff `Offer package`, then `Show QR`, and the guardian pays with the fake gateway. The package becomes
active, and receipt `DNM/2026-27/000001` reads "on behalf of <centre>". The guardian sees it under
Payments and gets the notification.

### E-2: Using sessions (FR-4)

Mark 3 sessions present: "9 sessions left", and each appointment has a consultation amount of ₹750.

### E-3: Pay a balance (FR-5)

A per-session child attends once. The family Payments page shows ₹800 due, and `Pay now` → paid →
balance ₹0.
