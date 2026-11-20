# 055: Free pilot mode (payments off by default)

**Status:** done (product owner decision, 2026-11-20)
**Mode:** solo
**Runs:** alongside

## Summary

The first pilot centre and its families use DoctorNearMe **for free**. All payment work (live Razorpay, the platform
fee rate, GST / CA review, payouts) and licences move to the end of the plan. One explicit server-side switch,
`PAYMENTS_ENABLED`, turns payments off by default. The payment code and migrations of 031, 045 and 046 stay in place, so
payments come back by setting the variable, without another migration.

## Functional requirements

- **FR-1** - Switch: `env.PAYMENTS_ENABLED` (`lib/env.ts`) is true only when `PAYMENTS_ENABLED === "true"`. Default
  (unset or anything else) = free pilot. It is not inferred from missing Razorpay keys and is independent of
  `DEMO_MODE`. Documented in `.env.example`. Helpers in `lib/payments/mode.ts`.
- **FR-2** - Booking (030/031): with payments off, a booking of any service (in-clinic or video, free or paid)
  confirms directly, never `pending_payment`, and never goes to `/book/[profileId]/pay/[appointmentId]` (that page
  redirects to `/family/appointments/[id]`). New migration `20261120005500_free_pilot_mode.sql`:
  `booking_confirm(p_appointment, p_guardian, p_require_payment boolean default true)`; `confirmHold` passes the flag.
  A pilot booking's snapshot becomes free (`payment_mode: free`, `fee_inr: 0`, `free_pilot: true`). Paid services are
  bookable and publishable without payout readiness (no `PayoutSetupNotice`). Video prerequisites (Google identity)
  stay. The booking flow shows "Free during the pilot" and "Confirm booking". Booking agent tools return a free
  service and tell the agent there is no fee; the voice widget shows no pay note.
- **FR-3** - Payment APIs: `POST /api/appointments/[id]/payment-order`, `/api/payments/verify`, `/api/payments/demo`
  answer `409 payments_disabled` (no order is created). `/api/payments/links/**` answers 404. The Razorpay webhook stays.
- **FR-4** - Attendance (044) and fees (045): marking attendance still works but is never billable: no ledger charge,
  package session, adjustment or refund. `attendance_mark(..., p_payments_enabled boolean default true)` and a
  transaction-local flag (`payments_set_enabled`, read by 044's billing rule and 045's billing trigger) for 030's
  complete / cancel. Fee, package, refund, receipt, QR and payment-link APIs (`app/api/fees/**`,
  `app/api/cases/[id]/fees/**`, `app/api/orgs/[id]/packages/**`, `app/api/payments/links/**`) answer 404. Pages
  `/cases/[id]/fees`, `/dashboard/fees`, `/dashboard/settings/packages`, `/family/children/[id]/payments`,
  `/pay/done`, `/pay/demo/[linkId]` are 404. Entry points are hidden: dashboard top bar, settings, case tabs, the
  child page, schedule and family appointment payment labels / Pay now, series billing mode, attendance billing rules
  and Billable labels.
- **FR-5** - Payouts (046): `/dashboard/payouts`, `/admin/payouts` and their APIs are 404; the admin nav link is hidden.
  `/api/cron/payouts` and `/api/cron/payments` answer `200 { skipped: "payments_disabled" }`; `run*JobsSoon()` and
  `npm run outbox:run` skip the payment, fee and payout jobs. `/api/cron/booking` is unchanged.
- **FR-6** - Next steps (052): no Pay step on the family home (`pickNextStep`, `loadFamilyFacts` skips the balance
  and package queries), no Pay action in "What happens next", no balances on provider Today.
- **FR-7** - Notifications: payment, fee and payout kinds (`payment_refunded`, `payment_request`, `payment_receipt`,
  `balance_reminder`, `package_reminder`, `fees_refunded`, `payout_transfer_failed`, `payout_reconciliation_alert`,
  `payout_invoice_issued`) are not enqueued, not fanned out and not delivered.
- **FR-8** - `/for-centres`: pilot variants in en/hi/te: `landing.daily.pilotTitle` / `pilotText` / `introPilot`,
  `familyTitle` / `familyText` and `intakeTitle` / `intakeText` instead of packages and payouts,
  `landing.who.introPilot`, `landing.who.centreTagPilot`, `landing.faq.a1Pilot`. No "platform fee". Booking copy key
  `booking.flow.freePilot`. `messages/REVIEW.md` regenerated (new hi/te rows `pending`).
- **FR-9** - Docs: "Free pilot mode" in `docs/payments.md` (flag, effects, how to turn payments on later), short notes
  in `docs/booking.md`, `docs/next-steps.md`, `docs/payouts.md`.

## Non-functional requirements

- **NFR-1** - Payments on (`PAYMENTS_ENABLED=true`) behaves exactly as before: the SQL defaults mean "payments on",
  and every existing payment, fee and payout test passes with the variable set.
- **NFR-2** - Fail closed for money: the default never creates a payment order, ledger charge, payout or payment
  message.

## Affected areas

- `lib/env.ts`, `.env.example`, `lib/payments/{mode,errors,jobs}.ts`, `lib/fees/jobs.ts`, `lib/payouts/jobs.ts`
- `supabase/migrations/20261120005500_free_pilot_mode.sql` (new)
- `lib/booking/{store,attendance}.ts`, `lib/family/{next-step,journey}.ts`, `lib/dashboard/today.ts`,
  `lib/agents/booking/tools.ts`, `lib/notify/{topics,outbox,worker}.ts`, `scripts/outbox-run.ts`
- Routes: `app/api/{fees,cases/[id]/fees,orgs/[id]/packages,orgs/[id]/payouts,admin/payouts,payments}/**`,
  `app/api/appointments/[id]/payment-order`, `app/api/cron/{payments,payouts}`, `app/api/agents/booking/session`
- Pages / components: `app/book/[profileId]/**`, fee / package / payout / payment pages, `app/dashboard/{layout,
  schedule/page,register/page,settings/page}.tsx`, `app/cases/[id]/{layout,attendance/page}.tsx`,
  `app/family/(portal)/{appointments/page,children/[id]/page}.tsx`, `app/for-centres/page.tsx`,
  `components/{booking/BookingFlow,case/CaseTabs,admin/AdminNav,payouts/PayoutSetupNotice,attendance/RegisterClient,
  series/SeriesForms,series/TimetableCard}.tsx`
- `messages/{en,hi,te}.json`, `messages/REVIEW.md`, `docs/{payments,booking,next-steps,payouts}.md`
- Tests: `tests/free-pilot.test.ts` (new); pilot cases in `booking-state-machine`, `fees-flow`, `outbox`,
  `next-step-rules`, `parent-landing`; `PAYMENTS_ENABLED=true` stubbed in the payments-on suites

## Out of scope

- Live Razorpay, the platform fee rate, GST / CA sign-off, payout accounts and licences (later tickets).
- Removing or rewriting any payment code or migration.
