# 055: Free pilot mode - Results

Built on `main` in the working tree (not committed), 2026-11-20. Database checks ran against an isolated local
Supabase for this project (port 58322) with every migration applied, including the new
`20261120005500_free_pilot_mode.sql` (`supabase migration up`).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261120005500_free_pilot_mode.sql` | PASS | Applied cleanly. `payments_set_enabled(false)` inside a transaction makes `payments_enabled()` false until commit and true again after (checked by hand) |
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | Exit 0 after 056's message keys landed (earlier it failed only on 056's then-missing keys) |
| `npx vitest run tests/free-pilot.test.ts` | PASS | 11 tests: the switch (only `"true"`, not `DEMO_MODE` or Razorpay keys), 8 pages 404 + checkout redirect, 8 APIs 404 `payments_disabled`, 3 payment APIs 409, both money crons skip behind the secret, notification kinds suppressed / `enqueue` writes nothing, booking flow copy (pilot and payments on) |
| New DB cases | PASS | `booking-state-machine` (paid in-clinic + video confirm directly, snapshot free, confirmation enqueued, order 409); `fees-flow` (attendance and `Mark completed` not billable, no package session, no ledger row, correction free, fee APIs 404); `outbox` (not enqueued; follow-up migration `20261120005600_outbox_skip_payment_work.sql`: a worker with payments off does not claim payment events or notifications, they stay pending and a worker with payments on delivers them; before this, a free-mode worker consumed them, which made parallel test files race) |
| `next-step-rules`, `parent-landing` | PASS | No Pay step / Pay action in the pilot; `/for-centres` en/hi/te pilot copy, no packages, payouts or platform fee; the paid model with payments on |
| Existing payments-on suites | PASS | `PAYMENTS_ENABLED=true` stubbed in `appointment-intake`, `attendance-register`, `booking-agent-tools`, `booking-state-machine`, `dashboard-today-db`, `demo-booking`, `fees-flow`, `google-meet`, `next-step-family`, `payments-flow`, `payouts-flow`, `next-step-rules`, `parent-landing` (the paid-model test) |
| i18n | PASS | 11 new keys per locale (`landing.daily.{introPilot,familyTitle,familyText,intakeTitle,intakeText,pilotTitle,pilotText}`, `landing.who.{introPilot,centreTagPilot}`, `landing.faq.a1Pilot`, `booking.flow.freePilot`); JSON edited by read / mutate / `JSON.stringify(obj, null, 2)`; `messages/REVIEW.md` regenerated with `npx tsx scripts/i18n-review.ts` (new rows `pending`) |
| `npx vitest run` (full, test DB env) | PASS for 055 | 2 consecutive runs: 115 files passed, 1 failed, 1 skipped; 2003 passed, 1 failed, 25 skipped. The failure is `tests/pilot-readiness.test.ts` (056, another ticket in progress: missing `family.login.phoneUnavailable`). An earlier run had one extra failure in `booking-state-machine` (provider cancel -> guardian notified); it passed in isolation and in both later full runs (likely a cross-file outbox worker race) |

## Not verified

- E-1 to E-5 in a browser (dev server not started). The behaviour is covered by the route, page and DB tests above.
- `npm run build`.
- Hindi and Telugu copy needs a native-speaker review (rows `pending`).
- The ElevenLabs booking agent prompt in the dashboard was not changed: it already says "free = no fee" and "follow the
  message in each tool result"; the tools now return a free service and say so.

## Notes

- SQL defaults mean "payments on" (`p_require_payment`, `p_payments_enabled`, unset `app.payments_enabled`), so direct
  SQL callers and `PAYMENTS_ENABLED=true` keep the 031/044/045/046 behaviour; TypeScript always passes the switch.
- Bookings confirmed during the pilot get a free snapshot (`free_pilot: true`) and stay free after payments are on.
- A correction during the pilot of a session that was billed before the pilot does not undo that charge (the billing
  trigger does nothing while payments are off).
