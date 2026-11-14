# Payouts to centres and the platform fee (ticket 046)

Decision 8 (corrected): the family pays **on DoctorNearMe** (031 one-offs, 045 packages and balances). DoctorNearMe
pays the centre **per delivered consultation** through **Razorpay Route**, keeping a platform fee plus GST on the fee.
Money only moves inside Razorpay (D-3): every payout is a Route transfer *from the family's payment* to the centre's
linked account, never through a DoctorNearMe bank account. Test mode only (NFR-2); live mode is a separate ticket after
CA and legal review.

Migration `supabase/migrations/20261113004600_payouts.sql`; code in `lib/payouts/**`.

## Data model

| Table | What |
|-------|------|
| `org_payout_accounts` | The centre's Route linked account (`acc_…`), `status` `not_started` / `pending_kyc` / `active` / `suspended`, legal name, GSTIN (for the invoice). No row = `not_started`; in `DEMO_MODE` a missing row is a fake active demo account. |
| `platform_fee_policies` (+ `platform_fee_policy_versions`) | `percent` (basis points 0–3000) or `flat` (paise), `min_paise`, `cap_paise`, `waived_until` (free pilot month, D-5), `version` (+1 on every admin change). No row = the platform default `PLATFORM_FEE_DEFAULT_BPS` (version 0). |
| `fee_policy_acceptances` | The owner accepted policy version *n* (FR-8). |
| `payout_items` | Exactly one per billable consultation (`appointment_id` unique; NFR-1), or one per unused session of an expired package paid out under `pay_centre` (`kind = package_expiry`). Consultation, fee, GST, net (`net = consultation − fee − GST`, checked), status `pending` → `transferred` / `on_hold` → `released`, `failed`, `reversed`. |
| `payout_transfers` | Every Route transfer attempt of an item (one open per item). Its `id` is the idempotency key sent to Razorpay in `notes.payout_transfer` and looked up before a retry. |
| `platform_invoices` (+ `platform_invoice_counters`) | Monthly platform-fee tax invoice per centre, `DNM-INV/<FY>/<0001>` gap-free per Indian financial year (counter row incremented in the issuing transaction). |
| `payout_reconciliation_flags` | FR-10 mismatches (one open flag per payment). |
| `organizations.package_expiry_policy` | `pay_centre` (default) / `refund_family` (FR-6). |

All service-role only (RLS on, no policies); every route gates itself (`lib/payouts/authz.ts`).

## Fee maths (FR-3)

`lib/payouts/fees.ts` (`splitFee`, `splitFor`) and SQL `payouts_fee_split` are the same (unit tests compare):
fee = percent of the consultation (half-up, integer paise) or flat; clamped to `min` / `cap`; 0 while
`waived_until >= consultation date` (Asia/Kolkata). GST = fee × `PLATFORM_GST_BPS` (default 1800). The fee is reduced
so fee + GST never exceeds the consultation. Examples: ₹750 at 10% → fee ₹75, GST ₹13.50, net ₹661.50; ₹1,000 → ₹100,
₹18, ₹882.

## Jobs

- `runPayoutJobs()` (`lib/payouts/jobs.ts`) runs every minute with `/api/cron/payments`, in `npm run -s outbox:run`, and
  right after attendance marking / captures / webhooks (`runFeeJobsSoon()` → Next.js `after()`):
  1. `payouts_sync` – one item per billable consultation whose funding payment (045 seam `fees_consultations`) is
     captured. Unpaid per-session charges get their item once the balance link is paid. Corrections that make a
     consultation non-billable void the item (nothing moved) or request a reversal.
  2. `payouts_settle_package_expiry` – FR-6: `pay_centre` creates `package_expiry` items (price / sessions each, the
     remainder on the last unit, fee applied); `refund_family` inserts a 045 `fee_refunds` row (`package_unused`),
     sent by the 045 refund job.
  3. Reversals that were requested (`POST /transfers/:id/reversals`, full amount; an existing reversal is reused).
  4. Transfers – `payouts_claim_transfers` leases due items, checks in SQL that `net` ≤ what is left of the source
     payment (`payouts_untransferred`: captured − refunds − transfers not reversed; NFR-3; else `exceeds_payment`),
     then `POST /payments/:id/transfers`. Several transfers can come from one package payment (one per session).
     Failures retry with back-off 60 s, 10 min, 1 h (3 retries); then `payouts.transfer_failed` alerts platform admins
     and the item waits in `/admin/payouts` for `Retry`.
  5. Held transfers (account `suspended` when made: `on_hold`) are released when the account is active again.
- `runDailyPayoutJobs()` – `/api/cron/payouts`, daily 19:30 UTC = 01:00 IST (`vercel.json`): reconciliation (FR-10) and
  last month's invoices (FR-7; idempotent per org and month, so the 1st's run issues them and later runs find them).

Webhooks `transfer.processed` / `transfer.failed` arrive on the existing signed, deduped `/api/webhooks/razorpay`
(payload allowlisted: never the notes). Subscribe them in the Razorpay dashboard (human step).

## Refunds after a transfer (FR-5)

Before any refund goes to Razorpay, the matching transfers are reversed first (`reverseBeforeRefund`,
`lib/payouts/reversals.ts`; throws `PayoutReversalPending` → the refund job retries with its back-off):

- 045 fee refunds: `registerRefundPrecondition` (`lib/payouts/register.ts`, imported by `lib/fees/jobs.ts`). A session
  charge refund reverses that session's item; a refund of unused package sessions reverses `package_expiry` items
  (latest first) until enough of the payment is unallocated.
- 031 full refunds: `lib/payments/jobs.ts` reverses every item of the payment before the refund.

The item becomes `reversed`. FR-4: a one-off is paid out only once delivered (billable); a provider no-show
(`cancelled_centre`) or a refundable cancellation never creates an item and 031 refunds the family.

## Payout setup gate (FR-2, FR-8)

`payoutReadiness(orgId)` → `block`: `payout_account_inactive` (account not `active`) or `fee_policy_not_accepted`.
Publishing an `online` paid service (`lib/booking/store.ts`) and creating / activating / offering packages
(`lib/fees/store.ts`) return **409** with that code ("Finish payout setup to accept payments"). Free services always
work. Paid services of orgs whose account is not active are hidden from booking (`listServices`, the slots route, hold
→ 404; SQL `payouts_org_can_charge`). A platform admin sets the account id and status by hand in `/admin/payouts`
after KYC in the Razorpay dashboard (human step); `DEMO_MODE` fakes an active account (and a missing account id).
The owner accepts each fee policy version once on `/dashboard/payouts`. Families never see the fee (D-4): they see
the centre's price, "paid to DoctorNearMe on behalf of <centre>".

## Pages and routes

| Route | Who |
|-------|-----|
| `/dashboard/payouts` (Figma 31:340) | org owner/admin (members 403 via `forbidden()`, `experimental.authInterrupts`): account status + setup steps, fee notice + `I accept` (owner), week/month stats, payout items, monthly invoices, settings (package expiry policy, GSTIN) |
| `GET /api/orgs/:id/payouts`, `GET …/export` (CSV), `POST …/accept` (owner), `PUT …/settings`, `GET …/invoices/:invoiceId/pdf` | owner/admin; other orgs 404 |
| `/admin/payouts` (Figma 31:777) | platform admins: GMV, platform fee + GST this month, failed transfers, voice minutes (link to `/admin/ops`), per-centre account / policy / this month, failed and on-hold transfers with `Retry` |
| `GET /api/admin/payouts`, `PUT /api/admin/payouts/orgs/:orgId/account`, `PUT …/policy`, `POST /api/admin/payouts/items/:id/retry` | platform admins (strict audit `payouts.*`) |

## Env (names only; `.env.example`)

`PLATFORM_FEE_DEFAULT_BPS` (1000), `PLATFORM_GST_BPS` (1800), `PLATFORM_LEGAL_NAME`, `PLATFORM_GSTIN`,
`PLATFORM_ADDRESS` (printed on invoices). Razorpay keys are 031's.

## DEMO_MODE

The demo gateway answers transfers (deterministic `trf_DEMO…` from our idempotency key), releases and reversals
(`rvrsl_DEMO…`), and `lib/payouts/demo.ts` delivers a signed fake `transfer.processed` webhook through the real
handler – or `transfer.failed` for linked accounts whose id contains `FAIL` (to exercise retries).

## Open questions (product owner / CA / legal)

- The pilot fee rate (suggested 8–10% or a flat ₹60–100 per session).
- GST on the platform fee, e-commerce operator obligations (TDS 194-O, GST TCS s.52), the invoice format (SAC 998599,
  CGST/SGST vs IGST by state code) and the 8-year financial record retention: needs a CA.
- The Razorpay Route agreement and the marketplace terms for centres (legal).
