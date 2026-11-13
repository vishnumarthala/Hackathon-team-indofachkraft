# 045: Packages and family payments on DoctorNearMe

**Status:** ready
**Mode:** solo
**Runs:** waits for 043, 044: packages cover series sessions; attendance uses them up

## Summary

**Business model (product owner, 2026-11-13, corrected):** the family pays **on DoctorNearMe**, and
DoctorNearMe pays the centre or therapist, keeping a platform fee per consultation. Payouts and the fee
are built in 046.

This ticket makes **every paid session payable on DoctorNearMe**:
- one-off bookings (031, unchanged);
- monthly **packages** (for example 12 sessions for ₹9,000);
- **per-session charges** for timetabled sessions.

It also adds a per-child family account (what was charged, paid and refunded), numbered receipts, and
a way for the front desk to take payment at the clinic **through DoctorNearMe**: a payment link or QR
the parent pays by UPI on their own phone. Cash is not recorded in the product.

## Functional requirements

- **FR-1** – Migration `<ts>_packages_family_payments.sql`:
  - `packages(id, org_id, name, session_count 1–60, price_inr, validity_days 7–180, service_ids uuid[],
    active)`.
  - `child_packages(id, org_id, child_id, package_id, snapshot jsonb, payment_id null, starts_on,
    expires_on, sessions_total, sessions_used, status check in
    ('pending_payment','active','used_up','expired','cancelled'))`.
  - `family_ledger(id, org_id, child_id, kind check in ('charge','payment','refund','adjustment'),
    amount_paise, appointment_id null, child_package_id null, payment_id null, note, receipt_no null,
    created_by, created_at)`, append-only.
  - `platform_receipt_counters(fy text pk, next int)`.
  - `appointments.consultation_amount_paise int null`.
  - Register all of them in the 041 privacy registry.
- **FR-2 – Retire "pay at clinic".**
  - New or edited services can only be `online` or `free`.
  - Existing `at_clinic` services migrate to `online`, and the provider sees a one-time notice.
  - Appointments already confirmed as `at_clinic` keep their snapshot and get a payment link when the
    session is marked present (FR-4).
  - Update the 030 seed and fixtures.
- **FR-3 – Packages.** Staff (owner/admin) `Offer package` to a child: this creates a `child_packages`
  row in `pending_payment` and a Razorpay **payment link** (test mode, 031 D-1). The link is sent to the
  guardian (in-app plus the WhatsApp template `payment_request`) and shown as a QR code on screen for
  the desk.
  - When the payment is captured (the existing signed, deduped webhook path), the package becomes
    `active`, and `family_ledger` gets the `charge` and the `payment`.
  - Unpaid package offers expire after 7 days.
- **FR-4 – Using packages and per-session charges.** When attendance (044) marks a session billable:
  - If the child has an active package that covers the service, one package session is used. When the
    total is reached the status becomes `used_up`.
  - Otherwise the session's fee is a `charge`, and a payment link is created for it, or added to an open
    "balance" link if one exists.
  - `consultation_amount_paise` is the one-off fee, or the package price ÷ `sessions_total` (rounded
    down, remainder on the last session). 046 uses it for the payout.
- **FR-5 – Family view.** `/family/children/[id]/payments` shows:
  - the balance due with a `Pay now` button (Razorpay checkout, same CSP exception as 031);
  - the active package with sessions left and the expiry date;
  - a history of charges, payments and refunds, with receipts.
- **FR-6 – Receipts.** Every captured payment gets a DoctorNearMe receipt number `DNM/<FY>/<000001>`
  (Indian financial year, gap-free, assigned in the same transaction). The PDF reads "Paid to
  DoctorNearMe on behalf of <centre name>". It lists items, amount, Razorpay payment id and date.
  Guardians get it in the app and by WhatsApp/email through the outbox; staff can download it.
- **FR-7 – Staff view.** The case page tab `Fees` shows balance due, the active package and sessions
  left, the ledger, and the buttons `Offer package`, `Request payment`, `Show QR` and `Adjustment`
  (owner/admin only, with a reason). Org settings get a `Packages` editor, and `/dashboard/fees` lists
  balances due.
- **FR-8 – Reminders.** The guardian gets one reminder when a balance is unpaid 3 days after a session,
  and when a package has ≤ 2 sessions left or expires within 7 days. Staff see badges for both.
- **FR-9 – Refunds.** Owner/admin can request a refund of a package's unused sessions or of a session
  charge. The refund amount is the package price minus the used sessions' consultation amounts. The
  refund runs through 031's refund job, and 046 reverses the matching part of the payout first if it
  was already transferred. Each refund adds `refund` rows to the ledger and is audited.
- **FR-10 – No corrections by editing.** Ledger rows are never updated or deleted; mistakes are fixed
  with `adjustment` rows and a reason.

## Non-functional requirements

- **NFR-1** – Integer paise; `formatInr` for display; no card or UPI details stored.
- **NFR-2** – Receipt numbers are gap-free under concurrency (test with 20 parallel captures).
- **NFR-3** – Payment links and QR codes contain only the Razorpay short URL, with no child name.

## Affected areas

- `supabase/migrations/<ts>_packages_family_payments.sql` (new); `lib/fees/**` (new)
- `lib/payments/razorpay.ts` (payment links), `app/api/webhooks/razorpay` (`payment_link.paid`)
- `lib/booking/**` (retire `at_clinic`), the services editor, the 030 seed
- `app/cases/[id]/**` (Fees), `app/dashboard/fees/**`, org settings (Packages),
  `app/family/children/[id]/payments/**` (new)
- `lib/notify/topics.ts`, `lib/privacy/registry.ts`, `messages/{en,hi,te}.json`, `tests/fees-*.test.ts`

## Out of scope

- UPI AutoPay mandates and subscriptions. Cash handling. Coupons and sibling discounts. Insurance.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Who collects | DoctorNearMe collects every payment (Razorpay); the centre is paid out in 046 | Product owner 2026-11-13 (corrected) |
| D-2 | Pay at clinic | Retired; the desk uses a payment link or QR on DoctorNearMe | Keeps every consultation inside the model |
| D-3 | Ledger | Append-only; adjustments only | Money must never change silently |
| D-4 | Per-session value of a package | Price ÷ sessions, remainder on the last | The payout and fee are per consultation |
