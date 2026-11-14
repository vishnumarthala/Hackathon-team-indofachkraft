# 046: Payouts to centres and the platform fee (Razorpay Route) - Results

Branch: `ticket/046-payouts-platform-fee` (worktree `dnm-worktrees/046`). Tested against the local Supabase stack in
slot 6 (all migrations re-applied by `dnm-db.sh 6 <worktree> reset`, incl. the new `20261113004600_payouts.sql`),
`DEMO_MODE=true` (the demo gateway fakes Route transfers, releases, reversals and their signed webhooks; no Razorpay keys
exist locally), dev server on port 3060, headless Chromium (staff / admin 1280 px, owner 375 px, `timezoneId`
Asia/Kolkata). Synthetic accounts and data only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0. Vitest: **108 files, 1867 passed, 11 skipped** (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl, unchanged; every DB suite ran, incl. 045's `fees-flow` and 031's `payments-flow` with the new refund hooks). Build lists `/dashboard/payouts`, `/admin/payouts`, `/api/orgs/[id]/payouts{,/accept,/settings,/export,/invoices/[invoiceId]/pdf}`, `/api/admin/payouts{,/orgs/[orgId]/account,/orgs/[orgId]/policy,/items/[id]/retry}`, `/api/cron/payouts`; only the pre-existing `lib/demo.ts` tracing warning |
| `npx vitest run tests/payouts-*.test.ts --reporter=verbose` | PASS | 2 files, **31 passed** (`payouts-unit` 14 pure, `payouts-flow` 17 DB through the route handlers); ran twice in a row (clean-up restores the invoice counter) |
| - fee maths: percent, flat, min, cap, waiver, GST 18%; net = consultation − fee − GST | PASS | unit: ₹750 at 10% -> 7500 / 1350 / 66150; ₹1,000 -> 10000 / 1800 / 88200; min/cap clamp + half-up rounding; flat ₹60 -> GST ₹10.80, never more than the consultation; waived -> 0/0/net = consultation; net + fee + GST = consultation over a grid; DB check `payout_items_net` |
| - exactly one payout item per consultation under 3 retries | PASS | 3 present package sessions, `runPayoutJobs` 3× concurrently + 2× more -> exactly 3 items, 3 processed transfers (unique `appointment_id`, leased claims, our transfer id as idempotency key) |
| - the sum of transfers from one package payment never exceeds the payment | PASS | `payouts_untransferred` = 900000 − 3 × 66150; a forged item for more than what is left -> `failed` / `exceeds_payment`, no transfer row (checked in SQL under the payment row lock); after FR-6 pay-out of all 12 sessions exactly 12 × 8850 (fee + GST) stays untransferred |
| - a one-off transfers only on completion; a provider no-show -> no transfer | PASS | captured ₹1,000 prepaid one-off: no item before marking; `present` -> item 100000 / 10000 / 1800 / 88200 `transferred`; `cancelled_centre` -> not billable, no item, 031 refund job -> `refunded`, 0 transfers |
| - a refund after a transfer -> reversal first, then refund | PASS | 031 full refund of a transferred one-off: transfer `reversed` (`rvrsl_DEMO…`), item `reversed`, `reversed_at` ≤ `payments.refunded_at`; 045 refund of an expired package's unused sessions that were already paid out: the precondition reverses the 10 `package_expiry` transfers (10 reversal ids, last `reversed_at` ≤ `fee_refunds.processed_at`), delivered sessions stay paid; a correction present -> absent reverses the transfer (`not_billable`), present again reopens and pays it again |
| - package expiry `pay_centre` vs `refund_family` | PASS | `pay_centre`: 2 used of 12, expired -> 10 `package_expiry` items of 75000 (fee 7500, GST 1350) transferred, `expiry_outcome pay_centre`, second run adds nothing; `refund_family` (owner setting via `PUT …/payouts/settings`): 1 used -> `fee_refunds` 825000 `package_unused` `processed`, no items |
| - org B cannot publish an online service (409) and its paid services are hidden | PASS | `POST /api/provider/services` online -> 409 `payout_account_inactive` "Finish payout setup to accept payments."; free -> 201; package -> 409; a pre-existing paid service is missing from `listServices(activeOnly)` and `POST /api/appointments/hold` -> 404; after activation -> 409 `fee_policy_not_accepted` until the owner accepts, then 201 and the old paid service is bookable |
| - a `transfer.failed` webhook -> retries -> shows in admin | PASS | linked account `acc_T046FAIL…`: demo `transfer.failed` webhook (signed, through the real handler) -> `failed`, attempts 1..4 with back-off (60 s / 10 min / 1 h), then `next_attempt_at` null + one `payouts.transfer_failed` outbox event; listed in `GET /api/admin/payouts`; provider `Retry` 403, admin `Retry` 200 (strict audit `payouts.transfer_retried`) -> `transferred` |
| - reconciliation flags a mismatch | PASS | a settled package payment balances; a transfer amount altered by ₹1 -> flag `diff_paise −100` (accounted − captured), `payouts.reconciliation_alert` enqueued; restored -> flag resolved |
| - a member who is not owner/admin cannot see `/dashboard/payouts` (403) | PASS | API: member 403 (statement, CSV, invoice PDF, accept), other org 404, guardian 403, anonymous 401; page gate `requirePayoutsPage` -> `forbidden()`; browser: member -> HTTP 403 |
| E-1 package paid out per session (FR-3, FR-7) | PASS | org A (10%, min ₹20), ₹9,000 / 12 package bought through the signed `payment_link.paid` webhook; each present session -> item ₹750 / fee ₹75 / GST ₹13.50 / net ₹661.50, `trf_DEMO…`, `transferred` after the signed `transfer.processed`; statement (`GET /api/orgs/:id/payouts`) and CSV show them (stored webhook payload without notes) |
| E-2 one-off booking (FR-4) | PASS | browser run: front desk marks a captured ₹1,000 one-off `present` through 044's route -> within the request's `after()` the item is 100000 / 10000 / 1800 / **88200 transferred** (`trf_DEMO…`); `/dashboard/payouts` shows "₹1,000 · ₹118 · ₹882 · Transferred" |
| E-3 payout setup gate and waiver (FR-2, FR-8) | PASS | browser run: org B owner sees "Finish payout setup to accept payments"; admin activates (`PUT /api/admin/payouts/orgs/:id/account`); service still 409 `fee_policy_not_accepted`; the owner reads "DoctorNearMe keeps ₹60 of each consultation fee, plus GST, and pays the rest to your account after each session. No fee for sessions until 30 November 2026." and clicks `I accept` -> "You accepted this fee (version 1)" -> paid service 201; DB test: a session this month -> fee 0, GST 0, net 80000 = consultation, `fee_waived` |
| E-4 monthly invoice (FR-7) | PASS | `issueMonthlyInvoices(now = 2026-11-01 01:00 IST)` for org A -> **`DNM-INV/2026-27/0001`** (fresh counter after the reset) for October with fee and GST = the sums of the non-reversed items, platform GSTIN from env; second run issues nothing; PDF route 200 `application/pdf` containing the number for the owner, 404 other org, 403 member |
| FR-1 schema | PASS | `org_payout_accounts`, `platform_fee_policies` (+ `platform_fee_policy_versions`), `fee_policy_acceptances`, `payout_items` (unique `appointment_id`), `payout_transfers`, `platform_invoices` (+ `platform_invoice_counters`), `payout_reconciliation_flags`; RLS on, service role only; all in the 041 privacy registry (`centre_payouts`, retained on erasure, 8 years: open question) and `docs/privacy/retention.md` |
| FR-9 `/admin/payouts` | PASS | browser: GMV ₹1,000, platform fee ₹100 + GST ₹18, failed transfers, voice minutes (link to `/admin/ops`), per-centre payout account / fee policy / this month / `Edit`, failed and on-hold list; provider -> 404; every account / policy change audited (4 strict `payouts.*` rows for 4 changes); new policy version per change |
| FR-7 `/dashboard/payouts` at 375 px | PASS | `scrollWidth` 375, no horizontal scroll |
| Cron | PASS | `/api/cron/payouts` without the bearer secret -> 401; daily 19:30 UTC (01:00 IST) in `vercel.json`; transfers run every minute with `/api/cron/payments` and `npm run -s outbox:run` |
| i18n | PASS | `payouts.*` (+ admin nav, schedule / packages error strings) in en/hi/te (hi/te drafted, `pending` in `messages/REVIEW.md`, regenerated: 3292 rows); three new notification templates in en/hi/te; `tests/i18n-keys.test.ts` and `tests/notify-templates.test.ts` green |

Evidence files (session workspace `files/e2e046/`): `acceptance.cjs` / `acceptance.txt` (**27 PASS, 0 FAIL**),
`vitest-payouts-verbose.txt`, `verify.log`, screenshots `e3-orgB-setup-1280.png`, `e3-orgB-accepted-1280.png`,
`fr7-dashboard-payouts-1280.png`, `fr7-dashboard-payouts-375.png`, `member-forbidden-1280.png`,
`fr9-admin-payouts-1280.png`.

## Deviations

- **No Razorpay keys locally.** Route runs on the DEMO_MODE gateway: deterministic `trf_DEMO…` / `rvrsl_DEMO…` ids and a
  signed fake `transfer.processed` (or `transfer.failed` for account ids containing `FAIL`) delivered through the real
  webhook handler. The real client (`POST /payments/:id/transfers`, `GET` for the idempotency look-up, `PATCH
  /transfers/:id` release, `POST /transfers/:id/reversals`) is written but not exercised against Razorpay. Creating
  linked accounts, KYC and subscribing the webhook to `transfer.*` are human steps (`docs/payouts.md`).
- **Extra tables / columns beyond FR-1:** `payout_transfers` (every attempt; one open per item; its id is the
  idempotency key), `platform_fee_policy_versions`, `platform_invoice_counters`, `payout_reconciliation_flags`;
  `payout_items` also has `kind` (`consultation` / `package_expiry`), `child_package_id`, `unit_no`, attempts / lease /
  reversal columns and `invoice_id`; `platform_invoices` also stores totals, item count and frozen centre / platform
  details. `pdf_path` is the download route: the PDF is rendered on demand from the immutable invoice row.
- **"Retry 3 times"** = the first attempt plus 3 retries (60 s, 10 min, 1 h); then admins are alerted and `Retry` in
  `/admin/payouts` starts a fresh round.
- **FR-8 also gates publishing:** a paid service / package needs the active account *and* the accepted current fee
  version (409 `fee_policy_not_accepted`). In DEMO_MODE an org without an explicit account row counts as active and
  accepted, so existing demo data and the 030/031/045 suites keep working.
- **Existing paid services of orgs without an active account** stay in the database but are hidden from booking
  (profile, slots, hold). Payout items of such orgs wait (`payout_account_inactive`, no attempt counted) until the
  account is active; a `suspended` account receives transfers `on_hold`, released when active again.
- **Invoices** are issued by the daily `/api/cron/payouts` run (idempotent per org and month): the 1st's run issues
  last month's, later runs find them; fees of items created after an invoice land on the next one. CGST + SGST vs IGST is
  decided by the state code of the two GSTINs (provisional, CA to confirm; SAC 998599).
- **045 per-session refunds of package sessions are refused by 045** (`not_refundable`), so FR-5 for package sessions is
  exercised through corrections (`present` -> `absent`, reversal `not_billable`) and the refund of an expired package's
  paid-out unused sessions; 031 full refunds and 045 session-charge / package refunds all go through
  `reverseBeforeRefund`.
- **Reconciliation** reports `diff = transferred + refunded + platform share − captured` only for settled payments
  (nothing pending, sessions over / package closed); one open flag per payment, resolved when it balances; admins get
  one alert per India day.
- **Fixed while finishing:** the reconciliation alert used the date as the outbox aggregate id (uuid column) and reversed
  items kept a payment "unsettled" forever; both fixed in the (unmerged) 046 migration / job.

## Notes

- New: `lib/payouts/**` (`fees.ts` maths, `store.ts`, `jobs.ts` `runPayoutJobs` / `runDailyPayoutJobs`,
  `reversals.ts` `reverseBeforeRefund`, `register.ts` 045 hook, `demo.ts`, `invoice.ts`, `csv.ts`, `authz.ts`), env names
  `PLATFORM_FEE_DEFAULT_BPS`, `PLATFORM_GST_BPS`, `PLATFORM_LEGAL_NAME`, `PLATFORM_GSTIN`, `PLATFORM_ADDRESS`
  (`.env.example`, `lib/env.ts`), outbox topics `payouts.transfer_failed`, `payouts.reconciliation_alert`,
  `payouts.invoice_issued`, `next.config.ts` `experimental.authInterrupts` (for `forbidden()`). `ServiceRow` gained
  `payouts_ready`.
- Next tickets: anything that refunds a family payment must call `reverseBeforeRefund` (or go through the 031 / 045
  refund jobs, which do). Live mode needs the CA / legal answers listed in rd.md "Open questions" and `docs/payouts.md`.
- Human / CA steps: pilot fee rate; GST on the fee, TDS 194-O / GST TCS s.52, invoice format, 8-year retention (CA);
  Route agreement and centre marketplace terms (legal); per centre linked account + KYC in the Razorpay dashboard, then
  `acc_…` in `/admin/payouts`; webhook subscription to `transfer.processed` / `transfer.failed`; `PLATFORM_GSTIN` etc.
  in the deployment env.
