# 031: Razorpay payments (test mode) - Results

Branch: `ticket/031-razorpay-test` (base: 017-030, 032, 038, 041 merged). Tested against the isolated local Supabase
stack of worker slot 6 (`dnmslot6`, all 25 migrations applied by `dnm-db.sh 6 <worktree> reset`), `DEMO_MODE=true`
(demo gateway; no Razorpay keys exist locally), dev server on port 3060 with `CRON_SECRET=e031-cron` and a synthetic
`RAZORPAY_WEBHOOK_SECRET`, own headless Chromium (`playwright-core` in the git-ignored `.tmp/`, 375 x 812,
`Asia/Kolkata`). Synthetic accounts (`seed:users --prefix e031`), synthetic clinic, children and provider only.
Evidence: `evidence/acceptance.txt`, `evidence/payments-tests-verbose.txt`, screenshots `evidence/*.png`.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, `vitest run`, build) | PASS | `npm run lint` exit 0; `npm run typecheck` exit 0; `npx vitest run` 78 files, **1222 passed, 11 skipped** (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl); every DB suite ran; `npm run build` exit 0 (new routes `/book/[profileId]/pay/[appointmentId]`, `/api/appointments/[id]/payment-order`, `/api/payments/{verify,demo}`, `/api/webhooks/razorpay`, `/api/cron/payments`) |
| `npx vitest run tests/razorpay-signature.test.ts tests/payments-flow.test.ts --reporter=verbose` | PASS | 2 files, **43 passed** (`evidence/payments-tests-verbose.txt`) |
| Checkout signature (valid, tampered, wrong secret) | PASS | `HMAC_SHA256(order_id + "\|" + payment_id, key_secret)` hex; tampered payment id / order id / one flipped hex digit / empty -> false; other secret -> false; route: 400 `invalid_signature`, appointment stays `pending_payment` |
| Webhook signature (valid, tampered body, wrong secret) | PASS | HMAC over the raw body; tampered amount or one extra space -> false; wrong secret / missing header / missing secret -> false; route 401 and **nothing stored** |
| Constant-time compare used | PASS | `node:crypto.timingSafeEqual` spied: called exactly once per checkout and webhook verification (`safeEqual`) |
| Duplicate event id no-op | PASS | same `X-Razorpay-Event-Id` replayed -> 200 `{ received: true, duplicate: true }`, one `payment_events` row, no second confirmation / audit row |
| `rzp_live_` key rejected at startup | PASS | `instrumentation.ts` `register()` throws for `rzp_live_...` (server not ready), not for `rzp_test_...`/unset; `createRazorpayClient` and `razorpaySettings()` throw `RazorpayConfigError` (also in DEMO_MODE) |
| `apply_payment_captured` idempotency (3x -> one confirmation, one outbox event) | PASS | outcomes `confirmed, already_captured, already_captured`; 1 `appointment.confirmed` event, 1 `-> confirmed` history row; plus **5 concurrent connections** -> exactly 1 `confirmed`, 4 `already_captured` |
| Late payment, free slot -> confirmed | PASS | test + E-3.1 |
| Late payment, taken slot -> refund path | PASS | test + E-3.2 (`refund_pending` -> job -> `refunded`, notification, other booking untouched) |
| FR-1 schema | PASS | migration `20261113003100_payments.sql`: `payments` (order id unique, payment id unique, `amount_paise`, `currency` `INR`, status check, `refund_id`, `failure_reason`, ...) with **at most one non-failed payment per appointment** (partial unique index); `payment_events` (unique `razorpay_event_id`, allowlisted `payload`, `received_at`, `processed_at`, `outcome`); RLS on |
| FR-2 config / demo gateway | PASS | `RAZORPAY_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` in `.env.example` + `lib/env.ts`; DEMO_MODE gateway: deterministic `order_DEMO…` / `pay_DEMO…` / `rfnd_DEMO…`, refunds processed at once; HTTP client tested against a mocked `fetch` (basic auth, order body, error mapping, retryable 5xx/network) |
| FR-3 payment order | PASS | 200 `{ key_id: "rzp_test_DEMOMODE", order_id, amount_paise: 50000, currency: "INR", prefill: { name }, demo: true }`; repeat -> same order (one row); `payment.order_created` audit |
| FR-4 checkout page + verify | PASS | E-1 below; demo checkout signs server-side and goes through the same `/api/payments/verify` |
| FR-5 webhooks | PASS | `payment.authorized` (records payment id), `payment.captured`, `payment.failed` (failure reason `BAD_REQUEST_ERROR: payment_failed`, retry on the same order), `refund.processed`; unknown -> 200 ignored; orders not ours -> 200 `unknown_order`; missing event id 400; amount mismatch -> refund |
| FR-6 capture path | PASS | one SQL function for checkout and webhook; confirmation + reminders through 030's `booking_enqueue_confirmed`; cancelled appointments never revived (refund); strict audit `payment.captured` fails closed (`AUDIT_FAIL_ACTIONS=payment.captured` -> 503, nothing changed) |
| FR-7 cancellation refunds | PASS | provider cancel -> refund (`provider_cancelled`); guardian >= 24 h before -> refund (`guardian_cancelled`); guardian 3 h before -> no refund (stays `captured`, label `Paid, not refunded`); reschedule -> payment moves to the new appointment; refund job: gateway 503 -> retry with back-off, existing refund reused (no double refund), `processed` -> `refunded` + notification |
| FR-8 labels | PASS | `/family/appointments`: `Paid`, `Payment pending` (+ `Pay now`), `Refunded`, `Paid, not refunded`; provider agenda: `Paid online`, `Payment pending` (`Pay at clinic` for at-clinic services, unit-tested) |
| NFR-1 no card/UPI details | PASS | stored payload for a capture that carried `vpa`, `email`, `contact`, `card`, `bank`, `wallet`, `notes`, `acquirer_data`: only `{ event, created_at, payment: { id, entity, order_id, status, amount, currency, method, captured } }` (unit + DB + E-1 `stored payload`) |
| NFR-2 webhook < 2 s | PASS | one short transaction; refunds (`runPaymentJobsSoon`) and notifications (`drainSoon`) after the response; route `maxDuration = 10` |
| NFR-3 privacy registry | PASS | category `payments` (`payments`, `payment_events`; processors Supabase + Razorpay; export = requesting guardian's payments only, other guardian `[]`; retained on erasure as a financial record); privacy notice collect / processor / retention rows (en/hi/te) |
| CSP / third-party allowlist | PASS | `https://checkout.razorpay.com` only on `/book/*/pay/*` (`lib/csp.ts` + `lib/privacy/third-party-allowlist.ts`); `/book/<id>`, `/family/**` keep `frame-src 'none'` and no Razorpay (unit); live CSP header on the pay page (E-1); `tests/no-tracking.test.ts` green |
| E-1 happy path | PASS | UI as guardian_a: `/book/<profile>` -> `Speech assessment (pay online)` -> 15 Nov 10:00 am IST -> `Continue` -> `Continue to payment` -> pay page (`₹500`, `Pay within 14:59 to keep this time.`, refund policy, no overflow at 375 px) -> `Pay now` -> `Simulate successful payment` -> `Payment received. Your appointment is booked.`; appointment `confirmed`, payment `captured`, history `held -> pending_payment -> confirmed (payment_captured)`; confirmation fanned out (guardian + provider in-app/email sent, WhatsApp skipped) + reminders pending; webhook of the same capture -> `already_captured`, replay of that event id -> `duplicate: true`, still 1 confirmation (`pay-*.png`, `family-appointments-paid-375.png`) |
| E-2 webhook security | PASS | wrong secret 401, tampered body 401, `payment_events` count unchanged, appointment/payment unchanged; `settlement.processed` -> 200 `{ received: true, outcome: "ignored" }` |
| E-3 late payment | PASS | 3.1: hold expired, `/api/cron/booking` `{"expired":1}`, `payment.captured` -> `late_confirmed`, appointment `confirmed`, history `expired -> confirmed (system, late_payment)`. 3.2: guardian_b booked the slot first; guardian_a's capture -> `refund_slot_unavailable` -> refunded by the job right after the response (`rfnd_DEMO…`); guardian_a in-app + email `Payment refunded: Your payment was refunded because the time was no longer available.`; guardian_b's appointment byte-identical (`family-notification-refund-375.png`, `family-appointments-refunded-375.png`) |
| E-4 cancellation refunds | PASS | provider cancels a paid appointment -> `refund_pending` (`provider_cancelled`) -> `/api/cron/payments` `{"refunded":1}` -> `refunded`; guardian cancels 3 h before (UI) -> `cancelled`, payment stays `captured`, label `Paid, not refunded`; policy shown before payment (`pay-page-policy-375.png`); provider agenda `Paid online` (`provider-agenda-paid-375.png`) |
| E-5 authz negatives | PASS | guardian_b payment order for guardian_a's appointment 404, verify with guardian_a's order 404, guardian_a's pay page 404; free confirmed appointment -> 409 `not_payable`; anonymous 401; expired 410 |
| i18n / 375 px | PASS | new `payments` namespace + privacy-notice rows in en/hi/te; `messages/REVIEW.md` regenerated (2048 rows); key/copy tests green (fixed a Telugu word the diagnosis-term rule flags); pay page and `/family/appointments` without horizontal scroll at 375 px |

## Deviations

- **No Razorpay keys locally.** Everything runs on the DEMO_MODE gateway (and mocked `fetch` for the real client).
  The real test-mode checkout (Razorpay test cards, dashboard webhooks) is a human step: see `docs/payments.md`
  "Configuration". The demo checkout signs `{ order_id, payment_id }` with the (derived or configured) key secret and
  posts to the same `/api/payments/verify`, so the server path is identical.
- **Late payment re-booking** re-confirms the **same appointment row** for the same slot (under 030's provider lock,
  with `booking_slot_valid`, `booking_conflicts` and the exclusion constraint) instead of calling `booking_hold` +
  `booking_confirm`: those would release the guardian's other hold, need a new idempotency key and create a new id the
  open checkout page and payment do not know. Same guarantees, one transaction.
- **Cancelled appointments are never revived** by a late payment (FR-6 lists expired/cancelled): a deliberate
  cancellation (guardian, provider, erasure) gets a refund instead. Expired holds are re-booked if free.
- **Refund job queue** is the `payments` row itself (`refund_pending` + lease/attempt columns, `lib/payments/jobs.ts`,
  `/api/cron/payments` every minute, also run by `npm run -s outbox:run` and right after a webhook/checkout), not a 032
  outbox topic named `payment.refund_needed`: 032's outbox fans out notifications only and its internals were not to be
  changed. The guardian notification is a real outbox topic (`payment.refunded`, in-app + email; no WhatsApp template).
- **Cancellation refunds via triggers** on `appointments` (`payments_on_appointment_cancelled`,
  `payments_follow_reschedule`) so 030's state machine functions stay untouched and every cancellation path (guardian,
  provider, erasure) applies the policy in the same transaction. Provider cancellations are refunded by the next cron
  run (<= 1 min); the cancel route was not changed.
- **`/family/appointments` list query** (030 `listGuardianAppointments`) also shows expired bookings whose late payment
  was captured/refunded, so the guardian sees `Refunded`.
- **Allowlist test** (`tests/no-tracking.test.ts`) now accepts the Razorpay entry's `/book/*/pay/*` route besides
  `/family/**` (FR-4 puts the checkout under `/book`); `FAMILY_CSP_EXCEPTIONS` keys may contain `*` segments.
- **`payment.refunded` is strict-audited but not listed** in `lib/audit/strict-actions.ts` (no user-facing route calls
  it; the static check needs one); `payment.captured` is listed.
- **`duplicate_payment`** (a second successful payment on the same order) is logged as an outcome but not refunded
  automatically (cannot happen with one order + auto-capture; refund from the dashboard).

## Notes

- **Migration** `20261113003100_payments.sql` (additive): `payments`, `payment_events`, RLS + read policy, functions
  `payment_apply_captured`, `payment_mark_authorized`, `payment_mark_failed`, `payment_mark_refunded`,
  `payment_request_refund` (service role only), triggers `payments_on_appointment_cancelled` /
  `payments_follow_reschedule` on `appointments`. `payments.appointment_id` is `on delete restrict` (financial record):
  test suites that delete appointments must delete their payments first.
- **Helpers:** `lib/payments/{razorpay,webhook,store,jobs,display,errors,recipients}.ts`, `components/payments/PayPanel.tsx`.
  Docs: `docs/payments.md` (new), `docs/system-design.md`, `docs/booking.md`, `docs/notifications.md`,
  `docs/privacy/{retention,processors}.md`.
- **Env vars (names only):** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; `vercel.json` cron
  `/api/cron/payments` every minute; `instrumentation.ts` (new) refuses live keys at start-up.
- **Shared files touched additively:** `lib/csp.ts` (exception + `*` segments), `lib/privacy/third-party-allowlist.ts`
  (route), `lib/privacy/registry.ts` (`payments`, `Processor` + `razorpay`), `lib/audit/strict-actions.ts`,
  `lib/notify/{topics,templates/index}.ts` (+ `payment_refunded`), `lib/auth-access.ts` (public webhook path),
  `lib/env.ts`, `.env.example`, `vercel.json`, `scripts/outbox-run.ts`, `lib/booking/store.ts` (list filter),
  `components/booking/BookingFlow.tsx` (`Continue to payment` -> pay page), `app/family/(portal)/appointments/page.tsx`,
  `app/dashboard/schedule/page.tsx`, `app/privacy/page.tsx`, `messages/*.json`, `messages/REVIEW.md`,
  `tests/notify-templates.test.ts`, `tests/no-tracking.test.ts`.
- **For 034 / 035 / 037 / 042:** an online booking ends at `/book/<profileId>/pay/<appointmentId>`; appointment
  confirmation for paid services happens in `payment_apply_captured` (same `appointment.confirmed` event as free ones).
  Payment state for display: `listPaymentsForAppointments(ids)` + `paymentLabel()`.
- **Open questions (product/legal):** refund policy wording per org (24 h rule global for now); retention period of
  payment records.
- The E2E data (`e031-*` accounts, `e031` clinic, their appointments/payments) is left in the slot 6 database; the test
  suites clean up after themselves.
