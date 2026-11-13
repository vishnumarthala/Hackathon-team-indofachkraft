# 046: Platform fee per consultation (Razorpay Route split + monthly centre statement)

**Status:** ready
**Mode:** solo
**Runs:** waits for 044, 045: needs billable attendance and consultation amounts

## Summary

Business model (product owner decision 2026-11-13): **the parent pays the centre or therapist, and the
centre or therapist pays DoctorNearMe a platform fee for each consultation, as part of the main fee.**

The fee **accrues** on every billable consultation in a platform fee ledger, whatever way the family paid.
There are two ways to **collect** it:

1. **Online payments** (031 one-off checkout, 045 payment links) use **Razorpay Route**. The platform
   receives the payment, keeps the fee and transfers the rest to the centre's linked account. The
   transfer is held until the session happens, so refunds before then are simple.
2. **Offline payments** (cash, UPI or card at the desk) produce a **monthly statement** for the centre:
   accrued fees minus fees already withheld through Route = amount due. The centre pays it with a
   Razorpay payment link.

## Functional requirements

- **FR-1** – Migration `<ts>_platform_fee.sql`:
  - `platform_fee_policies(org_id pk, kind check in ('percent','flat'), percent_bps int 0–3000 null,
    flat_paise int null, min_paise int default 0, cap_paise int null, waived_until date null,
    updated_by, updated_at)`. A platform-wide default lives in `PLATFORM_FEE_DEFAULT_BPS` (env; the
    pilot value is set by the platform admin).
  - `platform_fee_ledger(id, org_id, kind check in ('accrual','withheld','statement_payment',
    'adjustment'), appointment_id null, payment_id null, base_paise, fee_paise, gst_paise,
    statement_id null, created_at)`, append-only, unique `(appointment_id) where kind = 'accrual'`.
  - `platform_statements(id, org_id, period_month date, accrued_paise, withheld_paise, gst_paise,
    due_paise, status check in ('draft','issued','paid','waived'), invoice_no, razorpay_link_id null,
    issued_at, paid_at)`.
  - `organizations.razorpay_account_id null` and `organizations.route_status` check in
    `('not_started','pending_kyc','active','suspended')`.
- **FR-2** – Accrual: when a session becomes billable (044) with `consultation_amount_paise > 0` (045), or
  a one-off appointment (030/031) becomes `completed`, insert exactly one `accrual`.
  - The fee follows the org policy: percent of the base, or flat, then clamped to min/cap.
  - The fee is 0 while `waived_until` is still in the future (the free pilot month).
  - GST at `PLATFORM_GST_BPS` (default 1800) applies to the fee, stored separately.
  - Reversing attendance to non-billable inserts an `adjustment` with the opposite amount.
- **FR-3** – Route split for online payments (test mode only):
  - On `payment.captured` for an org with `route_status = 'active'`, create a Route **transfer** of
    `payment − fee − GST` (for a package: fee on the package price at the policy rate) to the org's
    linked account, with `on_hold = true`.
  - Record a `withheld` ledger row for fee + GST.
  - Release the hold when the appointment is completed or attended, or after `start + 24 h` for one-off
    bookings. For packages, release on payment (the centre has delivered nothing yet, but package
    refunds are the centre's policy; see open questions).
  - A refund before release reverses the transfer.
  - When Route isn't active, no transfer is made; the money waits in a `pending_payout` state and
    shows on the statement as owed **to** the centre.
  - Signed, idempotent webhooks reuse 031's handler (`transfer.processed`, `transfer.failed`).
- **FR-4** – Monthly statement: a cron on the 1st of the month (Asia/Kolkata) builds one draft
  statement per org for the previous month: accrued fee + GST − withheld ± adjustments ± pending payouts.
  - The platform admin reviews and issues it, which assigns a gap-free `invoice_no` (`DNM/<FY>/<0001>`).
  - Issuing also creates a PDF tax invoice (platform GSTIN from env, the centre's GSTIN if any) and a
    Razorpay payment link.
  - The org owner gets the statement by email and in-app. When paid, a `statement_payment` row is
    added; a credit balance carries forward.
- **FR-5** – Centre UI `/dashboard/billing` (owner/admin):
  - The current month to date: number of consultations, fees accrued, fees already withheld, estimated
    amount due.
  - Past statements with PDFs and a `Pay now` button.
  - Route status, with the steps to finish KYC.
- **FR-6** – Admin UI `/admin/billing`:
  - Fee policy per org: kind, rate, min/cap, waived until.
  - Draft statements with `Issue`, `Waive` (needs a reason), `Mark paid offline`.
  - Overdue list.
  - Route accounts: set `razorpay_account_id` and status by hand (KYC is a human task).
  - Every change is audited.
- **FR-7** – Transparency: before a centre's first billable session, the dashboard shows a one-time
  notice with the fee policy ("DoctorNearMe charges X% of each consultation fee, plus GST"). The owner
  must accept it once (stored with policy version and time). Families never see the platform fee.
- **FR-8** – Overdue: statements unpaid 15 days after issue show a banner to owner/admin. There is no
  automatic delisting or lock-out in the pilot.

## Non-functional requirements

- **NFR-1** – Integer paise; there is one accrual per consultation even under retries (unique index plus
  idempotent outbox jobs).
- **NFR-2** – Test keys only (031 D-1). Live mode needs a separate ticket after a chartered accountant
  (CA) and legal review.
- **NFR-3** – The statement for 2,000 consultations generates in < 5 s.

## Affected areas

- `supabase/migrations/<ts>_platform_fee.sql` (new); `lib/billing/**` (new)
- `lib/payments/razorpay.ts` (Route transfers), `app/api/webhooks/razorpay` (transfer events)
- `app/dashboard/billing/**`, `app/admin/billing/**` (new), cron route for statements
- `lib/notify/topics.ts`, `lib/audit/**`, `.env.example`, `messages/{en,hi,te}.json`
- `tests/platform-fee-*.test.ts` (new)

## Don't touch

- 031 checkout UX for families; existing migrations; `BOARD.md`.

## Out of scope

- Live Razorpay, automated KYC onboarding of linked accounts, TDS (194-O) and GST TCS handling,
  credit notes beyond adjustments, and dunning beyond the banner.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Business model | Platform fee per consultation, inside the main fee, paid by the centre | Product owner 2026-11-13 |
| D-2 | When the fee accrues | Per billable consultation (attended, or billable per org policy) | "each consultation" |
| D-3 | Collection | Route split for online payments, monthly statement for everything else | Centres keep cash/UPI at the desk |
| D-4 | Visibility | Families never see the platform fee | The fee is part of the centre's price |
| D-5 | Free pilot month | `waived_until` per org | PMF check §6 |

## Open questions (product owner / CA)

- The pilot fee rate. A suggested starting point is 5–10% of the consultation fee, or a flat ₹50–100 per
  session. Check this against the Practo Ray anchor of about ₹999–1,999 a month.
- GST registration, the platform's place of supply, and whether DoctorNearMe is an "e-commerce operator"
  for TDS 194-O and GST s.52 on Route payments. Needs a CA.
- Whether the fee for an online package is withheld upfront (current spec) or per session as sessions
  happen.
