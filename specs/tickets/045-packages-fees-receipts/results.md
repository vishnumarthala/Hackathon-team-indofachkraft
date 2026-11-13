# 045: Packages and family payments on DoctorNearMe - Results

Branch: `ticket/045-packages-fees-receipts` (worktree `dnm-worktrees/045`). Tested against the local Supabase stack in
slot 6 (all migrations re-applied by `dnm-db.sh 6 <worktree> reset`, incl. the new
`20261113004500_packages_family_payments.sql`), `DEMO_MODE=true` (demo gateway with payment links; no Razorpay keys
exist locally), dev server on port 3060, headless Chromium (staff 1280 px, families 375 px, `timezoneId`
Asia/Kolkata). The acceptance run was done right after a fresh reset (so the first receipt of FY 2026-27 is
`000001`). Synthetic accounts and data only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0. Vitest: **102 files, 1755 passed, 11 skipped** (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl, unchanged; every DB suite ran). Build lists `/cases/[id]/fees`, `/dashboard/fees`, `/dashboard/settings/packages`, `/family/children/[id]/payments`, `/pay/demo/[linkId]`, `/pay/done`, `/api/cases/[id]/fees{,/offer,/request-payment,/adjustments,/refunds}`, `/api/fees/payments/[id]/{qr,receipt}`, `/api/orgs/[id]/packages{,/[packageId]}`, `/api/payments/links/{callback,demo}`; only the pre-existing `lib/demo.ts` tracing warning |
| `npm run lint` / `npm run typecheck` / `npm run build` | PASS | each exit 0 (inside `verify`, and run separately before) |
| `npx vitest run tests/fees-*.test.ts --reporter=verbose` | PASS | 2 files, **30 passed** (`fees-unit` 14 pure, `fees-flow` 16 DB through the route handlers) |
| - `at_clinic` rejected for new services; existing ones migrate to `online` | PASS | `POST /api/provider/services` with `at_clinic` -> 400; raw insert -> check `services_payment_mode_045`; the migration's own `update` statement (read from the file, run in a rolled-back transaction with the check dropped) turns a ₹700 `at_clinic` service into `online` and a fee-less one into `free`, both with `migrated_from_at_clinic_at`; 0 `at_clinic` services left |
| - package offer -> link -> `payment_link.paid` (duplicate no-op, tampered 401) -> active + charge + payment | PASS | offer 201 (`plink_DEMO…`, URL `/pay/demo/<link>` only, `fees.payment_request` enqueued, second offer 409 `offer_pending`); tampered body 401 and nothing changed; valid -> `package_active`, `child_packages.active`, 30-day validity, ledger `[charge 900000 package, payment 900000 package]` with the receipt number, one `payment.captured` audit; replay of the event id -> `{ received: true, duplicate: true }`; the signed redirect for the same payment -> `already_captured`; stored payload without contact / VPA |
| - 12 present sessions -> `used_up`; 75000 each; remainder with ₹10,000 / 12 | PASS | ₹9,000 package: 3 sessions 75000 each (pure test: all 12 = 75000, sum 900000); ₹10,000 package: 12 sessions marked through 044's route -> 83333 x 11 + 83337 = 1000000, status `used_up`; the 13th session is charged ₹800 |
| - an absent, non-billable session uses no package session | PASS | `absent` -> `billable: false`, `consultation_amount_paise` null, `sessions_used` unchanged; a correction present -> absent gives the session back, absent -> present uses it again |
| - a billable session without a package -> a charge plus a link | PASS | ledger `charge 80000` for the appointment, fee job -> balance link of 80000 with its `fee_link_items`; a second session replaces it with a 160000 link (old one `failed` / `link_replaced`) |
| - receipt numbers gap-free under 20 parallel captures; FY rolls over on 1 April | PASS | 20 captures on 20 connections at once -> exactly `DNM/2001-02/000001`..`000020`; a capture that rolls back returns its number (next = `000021`, dated 31 March 23:59 IST); 1 April 00:00:30 IST -> `DNM/2002-03/000001`; pure: `2027-03-31T18:30Z` -> `2027-28` |
| - refund of unused sessions has the right amount | PASS | 900000 - 3 x 75000 = **675000** (201, `via: fee_refund`), package `cancelled`, second refund 409; refund job (demo) -> `processed`, `rfnd_DEMO…`, one `refund` ledger row of 675000, balance still 0, strict audit `fees.refund_requested`; the 046 seam reports `refunded_paise` 675000 |
| - ledger updates and deletes raise | PASS | `update` / `delete` -> `family_ledger is append-only` (42501); `truncate` refused |
| - members who are not owner/admin get 403 | PASS | member (assigned to the case): offer / request-payment / adjustments / refunds / packages POST / PATCH -> 403, `GET` account 200; other organisation 404; guardian 403; anonymous 401 |
| E-1 package at the desk (FR-3, FR-6) | PASS | desk at 1280 px: `/cases/<id>/fees` -> `Send offer` -> "Offer sent" -> QR shown ("Scan to pay ₹9,000 … on behalf of E045 Centre …"); guardian at 375 px opens the link (demo payment page: ₹9,000, "Paid to DoctorNearMe on behalf of <centre>", no child name) -> `Simulate successful payment` -> back on `/family/children/<id>/payments?paid=1`: "12 sessions left", history "Receipt **DNM/2026-27/000001**"; receipt PDF text "Receipt no. DNM/2026-27/000001 … Paid to DoctorNearMe on behalf of E045 Centre … (synthetic) … Rs. 9,000 … Razorpay payment id: pay_DEMO…"; notifications `payment_receipt` in-app sent, email sent, WhatsApp skipped (not configured); `/family/notifications` shows "Payment received" |
| E-2 using sessions (FR-4) | PASS | package-billed weekly series (043 API), 3 sessions marked present by the front desk (044 API) -> each `consultation_amount_paise` 75000 (₹750) with the package; Fees tab "9 sessions left", family page "9 sessions left · 3 of 12 sessions used · Valid until 13 Dec 2026" |
| E-3 pay a balance (FR-5) | PASS | per-session series, one session marked present -> charge + balance link within the request's `after()`; family page (375 px): "₹800", `Pay ₹800 with UPI or card` -> demo payment page -> paid -> back with balance "₹0", "Nothing to pay right now.", receipt `DNM/2026-27/000002` |
| FR-2 one-time notice / services editor | PASS | `/dashboard/schedule`: payment options `Pay online`, `Free` only; notice "Pay at the clinic is no longer available…" shown once, gone after `OK` |
| FR-5 family view | PASS | balance card + pay button, package offers waiting for payment with `Pay ₹X for this package`, active package with sessions left and expiry, history with receipt links; caption "Payments are made to DoctorNearMe on behalf of <centre>" (Figma 30:84); no horizontal scroll at 375 px |
| FR-6 receipts | PASS | every captured payment (031 one-offs too; existing ones backfilled in capture order) gets the number in the capturing transaction (trigger); PDF for the child's guardians and staff with case access, others 404; `fees.receipt` to the guardian |
| FR-7 staff view | PASS | case tab `Fees` (balance, package, badges, ledger, `Offer package`, `Request payment`, `Show payment QR`, `Adjustment` with a reason, refunds); `/dashboard/settings/packages`; `/dashboard/fees` lists "Bala E045 (synthetic) · Overdue · ₹800 · Open fees" |
| FR-8 reminders + badges | PASS | one `fees.balance_reminder` for a session 4 days ago (two job runs -> one event), one `fees.package_reminder` at 2 sessions left; `Overdue` / `Package ending` badges |
| FR-9 / FR-10 refunds and adjustments | PASS | package and session refunds (above); a paid session made non-billable later is refunded from its balance payment (`not_billable`), an unpaid one is cancelled by a credit; adjustment without a reason 400, `+250` -> balance 25000 and a link, `-250` -> 0 and the link closed; strict audit `fees.adjustment_added` |
| Prepaid one-offs (031) in the ledger | PASS | capture -> `charge` + `payment` (receipt); absent and not billable -> `refund_pending` (`not_billable`) -> refund job -> `refund` row |
| 046 seam | PASS | `fees_consultations()` / `listConsultations()`: package sessions -> `source package`, the package payment, 75000; per-session -> the balance payment; one-offs -> their 031 payment |
| Balance identity | PASS | `fees_balance()` = sum of `fees_open_items()` for every account of the suite at the end |
| NFR-1 integer paise / no card or UPI data | PASS | all amounts `int` paise, `formatInr` in the UI, `Rs.` in the PDF; webhook payloads allowlisted (payment link entity without customer, description, short URL) |
| NFR-3 links / QR hold the short URL only | PASS | DB check on `payment_link_url`; `linkQrSvg` refuses anything with a query or other text; Razorpay link `description` = package name / "Sessions" + centre, never the child |
| Privacy registry (041) | PASS | category `family_payments` (`packages`, `child_packages`, `family_ledger`, `fee_link_items`, `fee_link_requests`, `fee_refunds`, `platform_receipt_counters`, `appointments.consultation_amount_paise`), retained on erasure, export of the child's packages and ledger; privacy notice rows updated (en/hi/te); `docs/privacy/retention.md` |
| i18n | PASS | `fees.*` namespace + `caseTabs.fees` in en/hi/te (hi/te drafted, `pending` in `messages/REVIEW.md`, regenerated: 3078 rows); `tests/i18n-keys.test.ts` green |

Evidence files (session workspace `files/e2e045/`): `acceptance.cjs` / `acceptance.txt` (**26 PASS, 0 FAIL**),
`vitest-fees-verbose.txt`, `verify.log`, `e1-receipt.txt`, screenshots `fr7-packages-settings-1280.png`,
`e1-desk-offer-qr-1280.png`, `e1-demo-pay-375.png`, `e1-family-payments-375.png`, `e1-family-notification-375.png`,
`e2-case-fees-1280.png`, `e2-family-package-375.png`, `e3-family-due-375.png`, `e3-family-paid-375.png`,
`fr7-dashboard-fees-1280.png`, `fr2-schedule-notice-1280.png`.

## Deviations

- **No Razorpay keys locally.** Payment links run on the DEMO_MODE gateway: links are `plink_DEMO…` and their URL is our
  own `/pay/demo/<link id>` page (public, DEMO_MODE only, no child data) standing in for Razorpay's hosted page; it
  returns the same signed redirect Razorpay sends and follows it to `/api/payments/links/callback`. The real client
  (`POST /v1/payment_links`, `/cancel`, partial refunds with `amount`) is written but only exercised through the demo
  gateway; creating real test-mode links and the `payment_link.*` webhook subscription in the Razorpay dashboard is a
  human step (`docs/payments.md`). In DEMO_MODE the QR therefore encodes the demo URL, not an `rzp.io` short URL.
- **`Pay now` opens the payment link (Razorpay's hosted checkout) instead of loading Razorpay Checkout on the family
  page.** One payment object per balance (the link the desk QR shows too) means a family cannot pay the same balance
  twice through two objects, and `/family/**` keeps its strict no-third-party CSP (no new CSP exception was needed).
- **"Added to an open balance link"**: a Razorpay link's amount cannot change, so a new charge cancels the open link and
  creates one for the new total (`fee_link_items` records what each link covers). If the old link was paid meanwhile,
  Razorpay refuses the cancel and the webhook records the payment; anything it covered that had been cancelled is
  re-applied and refunded automatically.
- **Ledger sign convention.** `amount_paise` is positive for charge / payment / refund; adjustments are signed. Balance =
  charges - payments + adjustments; a `refund` row records money returned together with the part of a charge it
  cancels, so it does not move the balance (a refund of unused package sessions is one `refund` row, no extra credit).
- **Extra tables** beyond FR-1: `fee_link_items`, `fee_link_requests`, `fee_refunds` (partial refunds of link payments:
  031's refund job only does full refunds of order payments). `payments` gained `purpose`, link columns, `org_id` /
  `child_id` / `child_package_id`, `receipt_no`; `appointment_id` / `razorpay_order_id` became nullable (only for link
  payments, by check constraint). Link payments stay `captured` after partial refunds.
- **Final refund rule for prepaid one-offs (reconciling 031 and 044): `billable` decides.** A prepaid session marked
  absent without `bill_absent` is now refunded in full (`not_billable`); 044 had kept it. Guardians' own cancellations
  keep 031's 24-hour rule.
- **Corrections after a charge**: a paid per-session charge made non-billable is refunded from the payment that settled
  it (not left as account credit), so every billable consultation keeps a single funding payment for 046; an unpaid
  charge is cancelled by a credit adjustment.
- **Packages are used for any billable, non-prepaid session of a covered service** (also per-session series), earliest
  expiry first, while the package is `active` at marking time (the session date is not compared with the validity).
- **Notifications without amounts or centre names** outside the app (032 content rule): `payment_request`,
  `payment_receipt`, `balance_reminder`, `package_reminder` (WhatsApp templates to submit to Meta, listed in
  `docs/notifications.md`) and `fees_refunded` (in-app + email). The receipt itself is a PDF in the app (email has the
  app link, no attachment). `Request payment` messages the family at most once per link per day.
- **Test fixtures**: 043/044/047/030/035 suites used `at_clinic` services; they now use `online` (series, attendance,
  import) or `free` (one-off bookings that must confirm directly). `tests/case-access.test.ts` accepts
  `requireFeesCaseApi` as a case gate; `tests/helpers/world.ts` purges test ledger rows with the maintenance flag.
- **New dependency**: `qrcode` (+ `@types/qrcode`) for the desk QR (SVG, server-side).

## Notes

- **Migration** `20261113004500_packages_family_payments.sql` (expand -> backfill -> enforce): retires `at_clinic`
  (data moved, then check `services_payment_mode_045`), adds the tables above, the receipt trigger
  (`payments_assign_receipt`, backfills existing captured payments), the ledger trigger on payments
  (`payments_fees_ledger`: 031 captures / refunds + `fees.receipt`), the billing hook (`appointments_fees_on_billable`
  -> `fees_apply_billable`), `fees_apply_link_paid`, `fees_close_link`, `fees_mark_refund_processed`, `fees_balance`,
  `fees_open_items`, `fees_consultations`. All service role only.
- **For 046 (payouts via Route)**: `fees_consultations(p_org, p_appointment)` (SQL) / `listConsultations({ orgId?,
  appointmentId? })` in `lib/fees/store.ts` return, per billable appointment, `consultation_amount_paise`, `source`
  (`one_off` / `package` / `per_session`), the funding `payment_id` (our `payments.id`) + `razorpay_payment_id` (the
  `/payments/:id/transfers` source), `payment_amount_paise`, `refunded_paise` (all refunds of that payment so far),
  `child_package_id`, `marked_at` (044's `attendance_marked_at`). `payment_id` is null while a per-session charge is
  unpaid (transfer later, when it is paid: `fees_apply_link_paid` is the place / the `fees.receipt` event the signal).
  Refund hooks: `registerRefundPrecondition(fn)` runs before every fee refund is sent to Razorpay (throw to retry later);
  031's full refunds (`lib/payments/jobs.ts`, payments in `refund_pending`) have no hook yet. Corrections that make a
  consultation non-billable end in a refund (`fee_refunds.reason = not_billable`, or 031 `refund_reason = not_billable`).
  Expired packages keep `status = 'expired'` with their unused sessions (046's `package_expiry_policy`).
- **Helpers**: `lib/fees/{store,jobs,money,display,authz,receipt,qr,recipients}.ts`; components
  `components/fees/{FeesActions,LedgerTable,PackagesEditor,DemoLinkCheckout,AtClinicNotice}.tsx`.
- **Gateway** (`lib/payments/razorpay.ts`): `createPaymentLink`, `cancelPaymentLink`, `createPartialRefund`,
  `paymentLinkSignature` / `verifyPaymentLinkSignature`; webhook parsing handles `payment_link.paid` / `.cancelled` /
  `.expired`. The fee jobs run with `/api/cron/payments` (every minute), `npm run -s outbox:run`, and right after
  attendance marking, the 030 complete route, webhooks and the redirect.
- **Strict audit actions added**: `fees.packages_changed`, `fees.package_offered`, `fees.payment_requested`,
  `fees.adjustment_added`, `fees.refund_requested`. Notification topics: `fees.payment_request`, `fees.receipt`,
  `fees.balance_reminder`, `fees.package_reminder`, `fees.refunded`.
- **No new env vars.** Docs: `docs/payments.md` "Packages and the family account (ticket 045)", `docs/system-design.md`,
  `docs/booking.md`, `docs/notifications.md`, `docs/privacy/retention.md`, `docs/pilot-seeding.md`.
- **Open questions** (product / legal): GST on receipts and whether a receipt must also be a tax invoice (CA); refund
  policy wording for packages; retention period of financial records (8 years assumed, as for 031).
- The acceptance run's synthetic accounts (`e045-*@example.test`, `E045 Centre …`) are left in the slot 6 database; the
  test suites clean up after themselves.
