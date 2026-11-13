# Payments: Razorpay, test mode (tickets 031, 045)

Online prepayment for services with `payment_mode = 'online'`, using Razorpay Orders + Checkout in **test mode only**
(D-1: a `RAZORPAY_KEY_ID` that does not start with `rzp_test_` stops the server at start-up, `instrumentation.ts`, and is
refused by `lib/payments/razorpay.ts`). Payment state is its own record, separate from appointment state (design rule
12); appointments still move only through 030's booking helpers. Webhooks are signature-verified and deduplicated by
event id; a payment that arrives after the hold expired is handled deterministically (re-book if still free, else refund).

Code: `lib/payments/**`, `app/api/appointments/[id]/payment-order`, `app/api/payments/{verify,demo}`,
`app/api/webhooks/razorpay`, `app/api/cron/payments`, `app/book/[profileId]/pay/[appointmentId]`,
`components/payments/PayPanel.tsx`. Migration: `supabase/migrations/20261113003100_payments.sql`.

## Flow

```
/book/<profile>  Continue to payment ──► booking_confirm (030): held -> pending_payment, hold_expires_at = now + 15 min
        │
        ▼
/book/<profile>/pay/<appointment>   amount (formatInr), countdown, cancellation/refund policy, Pay now
        │  POST /api/appointments/:id/payment-order  -> { key_id, order_id, amount_paise, currency, prefill: { name } }
        ▼
Razorpay Checkout (checkout.js, this route only)  ─ or, DEMO_MODE: demo checkout (POST /api/payments/demo)
        │  success handler { razorpay_order_id, razorpay_payment_id, razorpay_signature }
        ▼
POST /api/payments/verify ── HMAC check ──► applyPaymentCaptured ──► payment_apply_captured (SQL, one transaction)
                                                    ▲
Razorpay ── POST /api/webhooks/razorpay (payment.captured) ────┘   (same function; whichever arrives first wins)
```

## Data model

| Table | What |
|-------|------|
| `payments` | `appointment_id` (FK, `on delete restrict`: a paid appointment cannot be deleted), `gateway` `razorpay`/`demo`, `razorpay_order_id` (unique), `razorpay_payment_id` (unique, null until a payment attempt), `amount_paise`, `currency` `INR`, `status` `created`/`authorized`/`captured`/`failed`/`refund_pending`/`refunded`, `refund_id`, `refund_reason` (`slot_unavailable`, `appointment_cancelled`, `provider_cancelled`, `guardian_cancelled`, `system_cancelled`, `amount_mismatch`, `external`), `failure_reason` (Razorpay error code + reason only), `captured_at`, `refund_requested_at`, `refunded_at`, refund job columns (`refund_attempts`, `refund_next_attempt_at`, `refund_locked_until`, `refund_last_error`). **At most one non-failed payment per appointment** (partial unique index); in practice one order per appointment. |
| `payment_events` | Webhook deliveries: `razorpay_event_id` (unique, the dedup key), `event_type`, `payment_id`, `payload` (allowlisted copy), `received_at`, `processed_at`, `outcome`. |

**No card or UPI details** are stored or logged (NFR-1): `lib/payments/webhook.ts` keeps only ids, amounts, currency,
status, method (`card`/`upi`), `captured` and error code/reason; card, VPA, bank, wallet, email, phone, notes,
descriptions and acquirer data are dropped before the insert.

RLS is on for both tables (guardians/providers may read the payments of their own appointments; `payment_events` is
service-role only). The server uses the service role and gates every route itself.

## SQL functions (security definer, service role only)

| Function | Rules |
|----------|-------|
| `payment_apply_captured(order_id, payment_id, amount_paise?, actor?)` | FR-6, idempotent, one transaction. Lock order: provider advisory lock (030) -> appointment row -> payment row. Payment already captured/refunding/refunded -> no-op (`already_captured`; another payment id on the same order -> `duplicate_payment`, logged, nothing changes). Else payment -> `captured`, then: amount differs (webhook) -> refund `amount_mismatch`; appointment `confirmed`/`completed`/`no_show` -> `already_confirmed`; `pending_payment` unexpired -> `confirmed` + `booking_enqueue_confirmed` (030 confirmation + reminders) -> `confirmed`; **late payment** (`pending_payment` past its expiry or `expired` by the cron) -> the same appointment is confirmed again if the slot is in the future, still published (`booking_slot_valid`), free (`booking_conflicts` + the exclusion constraint) and the child still linked -> `late_confirmed`, otherwise refund `slot_unavailable`; `cancelled` -> refund `appointment_cancelled`. History rows (`appointment_events`) carry `payment_captured` / `late_payment`. |
| `payment_mark_authorized(order_id, payment_id)` | `payment.authorized`: `created`/`failed` -> `authorized` (records the payment id; the appointment waits for the capture). |
| `payment_mark_failed(order_id, payment_id, reason)` | `payment.failed`: `created`/`authorized`/`failed` -> `failed` with the reason. Never downgrades a captured payment. The guardian can retry on the same order (`Pay now` again resets it to `created`). |
| `payment_mark_refunded(payment_id, refund_id)` | Refund processed (job or `refund.processed`). Idempotent; enqueues `payment.refunded` (dedup `payment:<id>:refunded`) in the same transaction. A refund made in the Razorpay dashboard on a captured payment is recorded too (reason `external`). |
| `payment_request_refund(payment_id, reason)` | `captured` -> `refund_pending` (the refund job does the rest). |
| trigger `payments_on_appointment_cancelled` | FR-7 policy, in the cancelling transaction (030 `booking_cancel`, 041 erasure): provider or system cancellation of a paid appointment -> full refund; guardian >= 24 h before the start -> full refund; later -> no refund (payment stays `captured`, label `Paid, not refunded`). Reschedules are skipped. |
| trigger `payments_follow_reschedule` | 030 `booking_reschedule` inserts the new appointment: the captured payment moves to it (no refund, no new payment). |

### Late payment after expiry (rule 12, D-3)

The 15-minute `pending_payment` hold can expire (cron `/api/cron/booking` or the next hold for the provider) while the
guardian is still in Razorpay Checkout. When the capture arrives (checkout handler or webhook):

1. Same appointment row, same slot: confirmed if it is still in the future, published, free and the child still
   linked (stale holds of the provider are expired first). The guardian gets the normal confirmation.
2. Otherwise (taken by someone else, blocked, in the past): payment -> `refund_pending` -> full refund -> guardian
   notified `Your payment was refunded because the time was no longer available.` The other guardian's booking is never
   touched.
3. An appointment that was **cancelled** (by the guardian, the provider or the system) is never revived: refund.

## Refund job (`payment.refund_needed`)

Payments in `refund_pending` are the queue (`lib/payments/jobs.ts`). A run claims due rows (`for update skip locked`,
120 s lease, `refund_attempts + 1`), then per payment: an existing non-failed refund of the payment is reused
(`GET /payments/:id/refunds`, so a crash after creating a refund cannot refund twice), otherwise `POST
/payments/:id/refund` (full amount, `speed: normal`). `processed` -> `payment_mark_refunded` + strict audit
`payment.refunded`, one transaction; `pending` -> poll again in 5 minutes (the `refund.processed` webhook usually
finishes it first); errors -> `refund_last_error`, retry after 1 min, 5 min, 30 min, 2 h, then every 12 h.

Triggers: `POST /api/cron/payments` (Vercel cron every minute, `CRON_SECRET`), `npm run -s outbox:run` (same local
loop as the outbox) and `runPaymentJobsSoon()` (Next.js `after()`) right after a webhook/checkout that needs a refund.
Cancellations are picked up by the next cron run.

## APIs

| Method + path | Who | Body | Success / errors |
|---------------|-----|------|------------------|
| `POST /api/appointments/:id/payment-order` | the booking guardian | - | 200 `{ key_id, order_id, amount_paise, currency, prefill: { name }, demo }` (same order on repeat); 401; 404 other guardians' / unknown; 409 `not_payable` (free, at clinic, confirmed, cancelled) / `already_paid`; 410 `hold_expired`; 502 gateway; 503 not configured |
| `POST /api/payments/verify` | the booking guardian | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` | 200 `{ appointment_id, appointment_status, payment_status, outcome }`; 400 signature mismatch (constant-time HMAC check); 404 someone else's order; 503 audit write failed (nothing saved) |
| `POST /api/payments/demo` | the booking guardian, **DEMO_MODE only** (404 otherwise) | `{ appointment_id, outcome: "success" \| "failure" }` | success: 200 `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` (deterministic `pay_DEMO…`, signed with the demo key secret) for `/api/payments/verify`; failure: 200 `{ status: "failed" }` |
| `POST /api/webhooks/razorpay` | public (Razorpay) | raw JSON | `X-Razorpay-Signature` = HMAC-SHA256(raw body, `RAZORPAY_WEBHOOK_SECRET`) else 401 (nothing stored); `X-Razorpay-Event-Id` required (400); replay -> 200 `{ received: true, duplicate: true }`; handled: `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`; others -> 200 `{ received: true, outcome: "ignored" }`; orders that are not ours -> 200 `unknown_order`; processing error -> 500 (nothing stored, Razorpay retries). Body limit 256 KB. One short transaction; refunds and notifications run after the response (NFR-2) |
| `GET\|POST /api/cron/payments` | `Authorization: Bearer <CRON_SECRET>` | - | 200 `{ refunded, pending, failed }`; 401 |

API error bodies are `{ error, code }` (English contract); the UI translates by `code` (`payments.pay.errors.*`).

## UI

- `/book/<profileId>`: `Continue to payment` (online services) now opens the payment page.
- `/book/<profileId>/pay/<appointmentId>` (booking guardian only, others 404; signed-out -> family sign-in and back):
  provider, service, time (viewer's zone + clinic time when different), amount (`formatInr`), **cancellation and refund
  policy shown before payment** (FR-7), `Pay now`, countdown of the 15-minute hold, then `Payment received. Your
  appointment is booked.` or `This time was no longer available, so we are refunding your payment in full.`; expired ->
  `Pick a time again`. DEMO_MODE shows a `Demo payment` box (`Simulate successful payment` / `Simulate failed payment`)
  instead of loading Razorpay.
- `/family/appointments`: payment label next to the status (`Paid`, `Payment pending`, `Refund in progress`, `Refunded`,
  `Paid, not refunded`, `Pay at clinic`) and `Pay now` for open payment holds; expired bookings whose late payment is
  being refunded stay listed.
- `/dashboard/schedule` agenda: `Paid online` / `Pay at clinic` (+ refund states).
- Strings: `payments` namespace in `messages/{en,hi,te}.json` (hi/te drafts in `messages/REVIEW.md`).

**CSP / third-party scripts (grill Q3, 041):** `https://checkout.razorpay.com` is allowed on `/book/*/pay/*` only
(`lib/csp.ts` `FAMILY_CSP_EXCEPTIONS`, which now accepts `*` path segments; `frame-src`/`connect-src`
`https://api.razorpay.com`, `connect-src https://lumberjack.razorpay.com`) and listed for that route in
`lib/privacy/third-party-allowlist.ts`. Every other booking and family page keeps the no-third-party policy.

## Notifications

| Topic | Recipients | Channels | Template |
|-------|------------|----------|----------|
| `payment.refunded` (`payment_mark_refunded`, dedup `payment:<id>:refunded`, payload `{ payment_id, appointment_id, reason }`) | the booking guardian, while the payment is refunded | in-app, email | `payment_refunded`: `Your payment was refunded because the time was no longer available.` (slot) / `... because the appointment was cancelled.` / generic |

Confirmation and reminders after payment are 030's `appointment.confirmed` / reminders (`booking_enqueue_confirmed`).

## Audit and privacy

- Strict (041, `lib/audit/strict-actions.ts`): `payment.captured` (`applyPaymentCaptured`, checkout and webhook, same
  transaction as the capture). Also strict but not listed (no user route): `payment.refunded` (refund job / webhook).
  Best effort: `payment.order_created`.
- Privacy registry (`lib/privacy/registry.ts`, NFR-3): category `payments` (`payments`, `payment_events`), processors
  Supabase + Razorpay (new `Processor`), export = the requesting guardian's payments for the child's appointments,
  **retained on erasure** (financial record; no child data in it - the appointment's child link is removed by 030's
  `booking_erase_child`). Privacy notice: collect row, Razorpay processor row, retention row.

## Configuration

| Variable | Notes |
|----------|-------|
| `RAZORPAY_KEY_ID` | test key id (`rzp_test_…`); anything else stops the server. Optional with `DEMO_MODE=true` |
| `RAZORPAY_KEY_SECRET` | checkout signature + API auth. DEMO_MODE without it: a secret derived from the service role key |
| `RAZORPAY_WEBHOOK_SECRET` | webhook HMAC. Unset outside DEMO_MODE -> every webhook is 401 |

`DEMO_MODE=true` always uses the demo gateway (`createDemoGateway`: deterministic `order_DEMO…` / `pay_DEMO…` /
`rfnd_DEMO…` ids from sha256, refunds processed at once, no network), even when test keys are set.

Human setup (test mode): Razorpay dashboard in **Test Mode** -> API keys -> `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`;
Webhooks -> `https://<app-domain>/api/webhooks/razorpay`, events `payment.authorized`, `payment.captured`,
`payment.failed`, `refund.processed`, secret -> `RAZORPAY_WEBHOOK_SECRET`; auto-capture on (Account settings ->
Payment capture). Use Razorpay test cards / test UPI ids only.

Local webhook test (demo secret or your own `RAZORPAY_WEBHOOK_SECRET`):

```bash
BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_Local0000000001","order_id":"<order id>","amount":50000,"currency":"INR","status":"captured"}}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3000/api/webhooks/razorpay -H "Content-Type: application/json" \
  -H "X-Razorpay-Signature: $SIG" -H "X-Razorpay-Event-Id: evt_local_1" --data "$BODY"
```

## Tests

`tests/razorpay-signature.test.ts` (pure: checkout + webhook signatures valid / tampered / wrong secret,
`timingSafeEqual` used, live keys rejected by the client, the settings and `instrumentation.ts`, demo gateway, HTTP
client with mocked fetch, payload stripping, CSP route exception, labels) and `tests/payments-flow.test.ts` (database,
route handlers: order idempotency and authz, demo checkout + verify, signature mismatch, `payment_apply_captured` 3x and
5 concurrent connections -> one confirmation, webhooks signed/unsigned/replayed/unknown, authorized/failed, amount
mismatch, late payment free -> confirmed / taken -> refunded + notification, cancellation refunds by provider / guardian
>= 24 h / guardian 3 h before (none), reschedule keeps the payment, refund job retry / reuse / no double refund, strict
audit fail-closed, privacy export).

## Open questions (product / legal)

- Refund policy wording per organisation (rd open question); the 24 h rule is global for now
  (`payments_on_appointment_cancelled`, `REFUND_WINDOW_HOURS`).
- Retention period for payment records (pending legal review; Indian accounting rules usually require 8 years).
- A second successful payment on the same order (`duplicate_payment`) is logged but not refunded automatically
  (Razorpay prevents it with auto-capture + one order; refund it from the dashboard if it ever happens).

## Demo bookings (ticket 042)

Appointments on demo (`is_synthetic`) profiles are `is_demo`: their snapshot is `free` / ₹0, so they confirm without
payment; `POST /api/appointments/:id/payment-order` answers 409 `not_payable` and the `payments_refuse_demo` trigger
refuses a payment row for them. See `docs/pilot-seeding.md`.

## Packages and the family account (ticket 045)

Decision 8 (corrected 2026-11-13): **the family pays on DoctorNearMe**, and DoctorNearMe pays the centre per delivered
consultation (Razorpay Route, ticket 046). "Pay at clinic" is retired. Migration
`supabase/migrations/20261113004500_packages_family_payments.sql`, code in `lib/fees/**`.

### What is paid how

| Session | How it is paid | `appointments.consultation_amount_paise` |
|---|---|---|
| One-off online booking (031) | Prepaid at booking (Razorpay order + Checkout) | the payment amount |
| Session covered by an active package of the same organisation | The package's payment link (paid once) | package price / sessions, rounded down; the **last** session takes the remainder (D-4) |
| Any other billable session (per-session series, a package series without a package, legacy `at_clinic` one-offs) | A `charge` on the family account, collected with the account's **balance payment link** | the service fee |

"Billable" is 044's `appointments.billable` (set when attendance is marked or corrected, never by later policy edits).
A trigger (`appointments_fees_on_billable` -> `fees_apply_billable`) runs in the marking transaction whenever `billable`
changes:

- `true`: prepaid one-off -> consultation amount = payment; else an active package covering the service (earliest expiry
  first) -> one session used (`used_up` at the total); else a `charge` row + a request to refresh the balance link.
- back to `false` (a correction): a package session is given back (`used_up` -> `active` while valid); an unpaid charge
  is cancelled by a credit `adjustment` (ref = the charge); a **paid** charge is refunded from the payment that settled it
  (`fee_refunds`, reason `not_billable`); a prepaid one-off is refunded in full (031's `payment_request_refund`, reason
  `not_billable`).

**Final rule for prepaid one-offs (reconciles 031 and 044):** `billable` decides. A prepaid session that ends up not
billable (absent without `bill_absent`, a late family cancellation recorded without `bill_late_cancel`, a centre
cancellation) is refunded in full; a billable one keeps its payment. A guardian's own cancellation in the app keeps 031's
rule (>= 24 h before -> refund, later -> kept).

### Data model

| Table / column | Notes |
|---|---|
| `packages` | Organisation catalogue: `name`, `session_count` 1-60, `price_inr`, `validity_days` 7-180, `service_ids uuid[]` (this org's services it covers), `active`. Editing never changes offers already made. |
| `child_packages` | One offer / purchase: frozen `snapshot`, `service_ids`, `price_paise`, `sessions_total` / `sessions_used`, `status` `pending_payment` -> `active` -> `used_up` / `expired`; `cancelled` (offer expired after 7 days, link closed, refunded). `starts_on` = payment day (IST), `expires_on` = starts_on + validity - 1. `payment_id` = the package payment. |
| `payments` (031, extended) | `purpose` `appointment` (031 order) / `package` / `balance` (payment links). Link payments carry `org_id`, `child_id`, `child_package_id`, `razorpay_payment_link_id`, `payment_link_url` (the Razorpay short URL only, NFR-3), `link_expires_at`; `appointment_id` and `razorpay_order_id` are null for them. Link payments stay `captured` after partial refunds (see `fee_refunds`). `receipt_no` on every captured payment. Refund reasons gain `not_billable`, `session_refund`. |
| `family_ledger` | Per organisation x child, **append-only** (trigger raises on update / delete / truncate; only the `dnm.ledger_maintenance` flag used by test clean-up may delete). `kind` `charge` / `payment` / `refund` / `adjustment`; `amount_paise` positive (adjustments signed: + owes more, - credit); `appointment_id`, `child_package_id`, `payment_id`, `ref_id` (the row it cancels / refunds), `note`, `receipt_no` (payment rows), `created_by` (null = system). No foreign keys: a financial record outlives the rows it mentions. |
| `fee_link_items` | Which ledger rows a balance link covers (`amount_paise`). A charge is settled when it carries a `payment_id` (one-off, package) or sits in a captured link. |
| `fee_link_requests` | Accounts whose balance link must be refreshed (written by SQL, consumed by `lib/fees/jobs.ts`). |
| `fee_refunds` | Partial refunds of link payments (`package_unused`, `session_charge`, `not_billable`, `overpaid`): the refund job's queue (lease, attempts, back-off like 031). |
| `platform_receipt_counters` | `fy` -> next number. |
| `appointments.consultation_amount_paise`, `appointments.child_package_id` | What the consultation is worth (046 pays it out) and the package that paid it. |
| `services.migrated_from_at_clinic_at`, `provider_profiles.at_clinic_notice_dismissed_at` | FR-2 one-time notice. |

**Balance due** = sum(charge) - sum(payment) + sum(adjustment) (`fees_balance(org, child)`). A `refund` row records
money returned together with the part of a charge it cancels, so it does not move the balance. `fees_open_items(org,
child)` lists what a balance link must cover (unsettled, uncancelled charges and manual adjustments); its sum equals the
balance (the DB tests assert it).

### Payment links (FR-3, FR-4, FR-5)

- `Offer package` (owner/admin): a `pending_payment` child package + a Razorpay **payment link** (`POST /v1/payment_links`,
  test mode; `expire_by` = 7 days, `reference_id` = our payment id, `callback_url` = `/api/payments/links/callback`,
  Razorpay's own SMS/email off). The guardian gets `fees.payment_request` (in-app + WhatsApp `payment_request` + email);
  the desk shows the QR (`GET /api/fees/payments/:id/qr`, SVG of the short URL only).
- Balance link: one open link per account covering exactly the open items. A new charge or adjustment cancels the open
  link at Razorpay and creates one for the new total (a link's amount cannot change). `Request payment` (owner/admin)
  refreshes it and notifies the guardian. Links last 30 days and are renewed a day before they expire.
- Captured by the signed `payment_link.paid` webhook, or the signed redirect to `/api/payments/links/callback`
  (`HMAC_SHA256(link_id|reference_id|status|payment_id, key_secret)`), both through `fees_apply_link_paid` (one
  transaction, idempotent): package -> `active` + `charge` + `payment` rows; balance -> `payment` row (anything it
  covered that was cancelled meanwhile is re-applied and refunded); amount mismatch or a package no longer pending ->
  captured and refunded in full. `payment_link.cancelled` / `.expired` close the row (`fees_close_link`).
- The family's `Pay ₹X with UPI or card` button and the package `Pay` button open the link (Razorpay's hosted checkout),
  so `/family/**` keeps its strict no-third-party CSP (no checkout script needed there).
- DEMO_MODE: the demo gateway creates `plink_DEMO…` links whose URL is `/pay/demo/<link id>` (our stand-in for
  Razorpay's page, public, no child data); `Simulate successful payment` returns the signed redirect and follows it to
  the same callback route.

### Receipts (FR-6, NFR-2)

Every captured payment (031 one-offs too; existing captured payments were backfilled in capture order) gets
`DNM/<FY>/<000001>`: the Indian financial year of the capture time in Asia/Kolkata (`2026-27` from 1 April 2026), from
`platform_receipt_counters`, assigned by the `payments_assign_receipt` trigger in the capturing transaction (a rollback
returns the number; the counter row serialises concurrent captures: gap-free, tested with 20 parallel captures). The PDF
(`GET /api/fees/payments/:id/receipt`, `lib/fees/receipt.ts`, pdf-lib, Helvetica so amounts print as `Rs.`) reads "Paid
to DoctorNearMe on behalf of <centre>" with the items, total, refunds, the Razorpay payment id and the date; no child
name. Guardians of the child and staff with access to one of the child's cases in that organisation may download it.
The guardian gets `fees.receipt` (in-app + WhatsApp `payment_receipt` + email; the link opens the Payments page).

### Refunds (FR-9) and adjustments (FR-7, FR-10)

- `POST /api/cases/:id/fees/refunds` (owner/admin, reason required): `{ kind: "package", child_package_id }` refunds
  price - used consultation amounts - earlier refunds (the package becomes `cancelled`); `{ kind: "session",
  appointment_id }` refunds a prepaid one-off in full (031 path) or a paid session charge from its balance payment.
- The fee refund job (`lib/fees/jobs.ts`) calls `registerRefundPrecondition` hooks first (**046 registers one that reverses
  the matching Route transfer**), then `POST /payments/:id/refund` with `amount` and receipt `fr-<id>` (reused if it
  already exists), then `fees_mark_refund_processed` writes the `refund` row and `fees.refunded` (in-app + email).
- `POST /api/cases/:id/fees/adjustments` (owner/admin): `{ amount_inr: ±N, reason }` -> a signed `adjustment` row. Rows
  are never edited.

### Reminders and badges (FR-8)

The fee job (every minute with `/api/cron/payments`, `npm run -s outbox:run`, and right after marking / webhooks)
enqueues `fees.balance_reminder` once per unpaid session charge whose session is >= 3 days old (dedup
`fees:balance:<org>:<child>:<charge>`) and `fees.package_reminder` once per package with <= 2 sessions left or <= 7 days to
expiry (`fees:package:<id>:ending`). Staff see `Overdue` / `Package ending` badges on the case Fees tab and
`/dashboard/fees`. It also expires unpaid offers after 7 days (link cancelled) and marks packages `expired` after their
last day (046 decides what happens to unused sessions).

### APIs and pages

| Route | Who | What |
|---|---|---|
| `GET /api/cases/:id/fees` | case access (022) | account, open links, active packages, `can_manage` |
| `POST /api/cases/:id/fees/offer` | owner/admin (members 403, other orgs 404) | `{ package_id }` -> 201 `{ child_package_id, payment_id, url, amount_paise }`; 409 `offer_pending` / `package_inactive` |
| `POST /api/cases/:id/fees/request-payment` | owner/admin | 200 `{ payment_id, url, amount_paise }`; 409 `nothing_due` |
| `POST /api/cases/:id/fees/adjustments` | owner/admin | `{ amount_inr, reason }` -> 201 `{ ledger_id, balance_paise }` |
| `POST /api/cases/:id/fees/refunds` | owner/admin | see above -> 201 `{ fee_refund_id, payment_id, amount_paise, via }`; 409 `nothing_to_refund` / `not_refundable` / `not_paid` |
| `GET/POST /api/orgs/:id/packages`, `PATCH /api/orgs/:id/packages/:packageId` | members read; owner/admin write | the catalogue |
| `GET /api/fees/payments/:id/qr` | staff with access to the child's case in that org | SVG QR of an open link |
| `GET /api/fees/payments/:id/receipt` | the child's guardians, staff as above | receipt PDF |
| `GET /api/payments/links/callback` | public, signature-checked | capture + redirect (guardian -> Payments page, others -> `/pay/done`) |
| `POST /api/payments/links/demo` | public, DEMO_MODE only | the demo payment page's API |
| `POST /api/provider/services/notice` | provider | dismiss the "pay at clinic retired" notice |

Pages: case tab `Fees` (`/cases/[id]/fees`), `/dashboard/fees`, `/dashboard/settings/packages`,
`/family/children/[id]/payments`, `/pay/demo/[linkId]` (DEMO_MODE), `/pay/done`.

### For 046 (payouts)

- `fees_consultations(p_org uuid, p_appointment uuid)` (SQL) / `listConsultations({ orgId?, appointmentId? })`
  (`lib/fees/store.ts`): one row per billable appointment with `consultation_amount_paise`, `source`
  (`one_off` / `package` / `per_session`), the funding `payment_id` (our `payments.id`; null while a per-session charge is
  unpaid), `razorpay_payment_id`, `payment_amount_paise`, `refunded_paise` (everything refunded from that payment so
  far), `child_package_id` and `marked_at`. Several package sessions share one payment (one transfer each).
- Refund hook: `registerRefundPrecondition(async (refund) => { ... })` in `lib/fees/store.ts` runs before every fee refund
  is sent to Razorpay (throw to retry later). 031's full refunds (`payments.status = refund_pending`, `lib/payments/jobs.ts`)
  have no hook yet: 046 should add the same reversal step there.
- Expired packages keep `status = 'expired'` with their unused sessions; 046's `package_expiry_policy` decides.
