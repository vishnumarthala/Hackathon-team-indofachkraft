# 035: Appointment-scoped pre-consult intake - Results

Branch: `ticket/035-appointment-intake` (base: 017-028, 030, 032, 038, 041 merged). Tested against the isolated local
Supabase stack of worker slot 5 (`dnmslot5`, all 26 migrations applied by `supabase db reset`), `DEMO_MODE=true`, dev
server on port 3050 (`CRON_SECRET=test-3050`, test values for `INTAKE_LINK_SECRET`, `ELEVENLABS_WEBHOOK_SECRET`,
`ELEVENLABS_AGENT_ID`, `ELEVENLABS_GENERIC_INTAKE_AGENT_ID`), own headless Chromium (playwright-core in a scratch folder
inside the worktree, removed afterwards) at 375 px / 1280 px. Synthetic accounts (`seed:users --prefix e035`, `t035i*`
test users), synthetic clinics, children and providers only. Evidence: `evidence/acceptance.txt` (23 PASS lines),
`evidence/appointment-intake-tests-verbose.txt`, `evidence/e2e-script.mjs`, screenshots `evidence/*.png`.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, `vitest run`, build) | PASS | lint 0, typecheck 0, vitest **77 files, 1191 passed, 11 skipped** (the pre-existing opt-in `CT_DB_TESTS` block + the live no-tracking crawl; every DB suite ran), build 0 with `/intake/a/[token]`, `/api/intake/a/[token]/{start,complete}`, `/api/dev/simulate-intake/a/[token]` |
| `npx vitest run tests/appointment-intake.test.ts --reporter=verbose` | PASS | 13 tests (`evidence/appointment-intake-tests-verbose.txt`): case reuse vs creation (and a separate case in another org), consumer re-run idempotency (same case/assignment/attempt, event re-fanned), attempt expiry, revocation on cancel, move on reschedule (same token, new expiry), duplicate webhook, consent re-check at start (422) and at completion (`consent_withdrawn`, nothing stored), consent granted later -> `appointment.intake_link`, wrong agent refused, token of another appointment refused (403), generic brief schema validation + health-profile check, D-4 defaults, the case-level 009/010 link unchanged |
| FR-1 migration | PASS | `20261113003500_appointment_intake.sql`: FK `recordings.appointment_id -> appointments` (column added if 038's migration has not run yet; dangling ids nulled first), `reports.appointment_id`, `reports.kind` + `generic_intake_brief` (extends the current list), `intake_attempts` (`token_hash` unique sha256 hex, `agent_kind`, `status`, `expires_at`, `conversation_id` unique, `started_at`, `completed_at`, + `revoked_at`/`revoked_reason`, one active attempt per appointment), RLS (care team read), security-definer `appointment_link_case`, `appointment_issue_intake`, lifecycle triggers; `appointments.case_id` FK already existed (030). Companion `20261113013500_appointment_intake_report_kind.sql` (see Deviations) |
| FR-2 case per appointment | PASS | E2E: booking -> `after()` drain -> case in org A for the child (`child_alias` = child name, guardian locale, status `booked`), provider_a lead on the care team, `appointments.case_id` set; second booking in org A -> same case; booking in org B -> another case; re-running the consumer changes nothing |
| FR-3 link / consent text | PASS | Confirmation (in-app + email): `... Before your visit, please take a short voice call with our AI assistant: http://localhost:3050/intake/a/<43 chars>`; WhatsApp variant `appointment_confirmed_intake` with the link as `{{2}}`; attempt `expires_at` = appointment start; only the SHA-256 stored. Without consent: `Allow the AI intake call in your DoctorNearMe app to prepare for this visit.` and no link; granting consent (`POST /api/family/children/:id/consents` 201) -> `consent.granted` consumer -> `Prepare for your visit` notification with the link |
| FR-4 intake page / start | PASS | Child-Dev link: language select English/हिन्दी/తెలుగు, demo start, simulated completion; generic link: no language select (`data-agent-kind="generic"`), start forces `en`; start after cancel/expiry -> 410 `This link has expired`, after completion 409, without consent 422; dynamic variables carry `intake_attempt_id` (Child-Dev agent's required `case_id` = placeholder `appointment-intake`) |
| FR-5 completion | PASS | Child-Dev: `intake_call` recording with `appointment_id`, case-sheet facts, 010 `pre_session_brief` with `appointment_id`; generic: one `generic_intake_brief` (`health_check`: Peanut `in_profile`, Paracetamol `not_in_profile`, profile-only Iron syrup); signed webhook replay -> 200 `{ received: true, duplicate: true }`, still one report; agent-id mismatch -> ignored, nothing stored |
| FR-6 provider views + agent guide | PASS | `/dashboard/schedule`: `Intake: completed` / `Intake: not started` + `Open brief` -> `/cases/<case>/brief#appointment-<id>` showing both brief kinds (`schedule-agenda-intake.png`, `case-brief-appointment-intakes.png`); `docs/elevenlabs-generic-intake-agent.md` (English, AI disclosure, no diagnosis, 108/112 red-flag message, 10-minute limit, data-collection fields) |
| NFR-1 idempotency | PASS | DB tests + E2E: consumer re-run, re-fanned confirmation, duplicate webhook, completion of an already completed attempt, `on conflict` on recordings/reports, unique `conversation_id`, advisory lock per org/child for case creation |
| NFR-2 case-level links unchanged | PASS | existing intake suites green; DB test runs a provider-created case's `/api/dev/simulate-intake/<token>`; `hasIntakeRecording` counts only recordings without an appointment |
| E-1 Child-Dev flow | PASS | `acceptance.txt` [E-1]; screenshots `family-appointments-link-375.png`, `intake-child-dev-375.png`, `intake-child-dev-done-375.png` |
| E-2 Generic flow | PASS | `acceptance.txt` [E-2]; `intake-generic-375.png` |
| E-3 Consent and expiry | PASS | `acceptance.txt` [E-3]; `family-appointments-consent-375.png`, `intake-expired-375.png` |
| E-4 Case reuse and authz | PASS | `acceptance.txt` [E-4]: same case in org A, separate case in org B; org A's provider gets 404 on org B's case page and API; completing appointment B's link with appointment A's conversation -> 403, nothing attached |
| Consent gating (020 rule 6) | PASS | collection: link issued only with `ai_intake_call`, start re-checks; async: webhook/complete/simulate re-check before storing and before Gemini; withdrawal revokes attempts (`consent_withdrawn`) |
| 375 px / i18n | PASS | case Brief tab and `/family/appointments` have no horizontal scroll at 375 px; new keys (`intake.appointment.*`, `intake.appointments.*`, `booking.schedule.agenda.intake.*`, `booking.list.intake.*`) in en/hi/te, `messages/REVIEW.md` regenerated (2022 rows) |
| Privacy registry (041) | PASS | `intake_attempts` registered (erased with the child's cases); calls/briefs stay under `case_records` / `intake_conversations`; `docs/privacy/retention.md` updated |

## Deviations

- **Extra late migration file.** The naming rule gives this ticket `2026111300 35 xx`, which sorts **before** 038's
  scribe migration. On a fresh `db reset`, 038 restates `reports_kind_check` without `generic_intake_brief`, so the
  generic brief would fail on every fresh database. `20261113013500_appointment_intake_report_kind.sql` (time 01:35)
  runs after every `00:xx` migration and *extends* the current list (parses `pg_get_constraintdef`, never removes a
  kind, idempotent); the main migration does the same for databases that already have 038 (production `db:push`).
  Any later ticket that restates `reports.kind` (039?) will be fixed up by this file on fresh resets; tickets merged
  after 035 should extend the list the same way instead of restating it.
- **"Outbox consumer" mechanism added to the worker.** 032's outbox only fanned events out to notifications. The
  confirmation must already contain the link, so the case link + attempt run as a consumer of
  `appointment.confirmed` / `.rescheduled` inside the fan-out transaction, before the template renders, and store
  `intake` in the event payload (`lib/notify/consumers.ts`, a 4-line hook in `lib/notify/worker.ts`). The confirmation
  is therefore fanned out only after the case exists (a failing consumer keeps the event pending and retries it).
  `consent.granted` is a consumer-only topic enqueued by a trigger on `consent_records`.
- **Token = HMAC of the attempt id** (`INTAKE_LINK_SECRET`, fallback the service role key) instead of a random
  token: only the hash is stored, yet email re-renders and `/family/appointments` can show the link again. Rotating
  the secret invalidates open links (documented).
- **Generic recordings keep the default `recordings.template`** (no new template value, to avoid restating 038's
  check); the Child Development Brief skips them through their intake attempt.
- **No ElevenLabs keys locally:** the generic agent is documented (`docs/elevenlabs-generic-intake-agent.md`) but
  not created; every flow ran with `DEMO_MODE=true` and fixtures (`demo/fixtures/elevenlabs-generic-post-call.json`,
  `demo/fixtures/gemini/generic-intake.json`). The real-agent path (token, `getConversation`, agent/attempt checks) is
  covered by code review only. Without `ELEVENLABS_GENERIC_INTAKE_AGENT_ID` a live generic start answers 503.
- **Open case = any case of the child in the org** (cases have no closed state yet); the newest is reused.
- **WhatsApp:** new Meta templates (`appointment_confirmed_intake`, `appointment_confirmed_allow_intake`,
  `appointment_intake_link`) are listed in `docs/notifications.md` for submission; until approved, WhatsApp stays
  `skipped`. Hindi/Telugu template text is a draft awaiting native review.

## Notes

- New helpers: `lib/booking/case-link.ts` (`linkAppointmentCase`, `prepareAppointmentIntake`,
  `issueIntakeLinksForChild`), `lib/intake/attempts.ts` (lookup by token, `attemptLinkState`, `agentIdFor`, agenda /
  family / case views), `lib/intake/attempt-token.ts`, `lib/intake/appointment-process.ts`
  (`processAppointmentPostCall`, `isAppointmentPostCall`), `lib/intake/generic.ts`, `lib/notify/consumers.ts`,
  `lib/booking/intake-defaults.ts` (D-4). `generateChildDevBrief` was extracted from `processPostCall` (unchanged
  behaviour, now also used by appointment calls).
- New env names: `ELEVENLABS_GENERIC_INTAKE_AGENT_ID`, `INTAKE_LINK_SECRET` (`.env.example`, `lib/env.ts`).
- Schema for later tickets: `intake_attempts`, `reports.appointment_id`, FK on `recordings.appointment_id`,
  `REPORT_KINDS.generic_intake_brief.inUse = true`. `ServiceCreateSchema.intake_kind` is now optional (default by
  provider type). The Child-Dev regression baseline gained `"appointment_id": null` in the report draft response.
- `services.intake_kind` changes apply to new bookings only (the snapshot decides).
- `consent.granted` events are delivered by the cron (or `outbox:run`); the link notification follows on the next
  run (no `after()` drain from the consent route, which belongs to 020).
- Parallel tickets: 031 (payments) needs nothing extra - `booking_enqueue_confirmed` emits `appointment.confirmed` and
  the consumer links the case. 039 should extend (not restate) `reports_kind_check`. 037 can add the Meet link to
  the same consumer pattern.

## Merge of main (031 Razorpay test mode, 033 voice screen, 037 Google Meet)

`git merge main`; conflicts resolved keeping both sides: `lib/notify/worker.ts` (037's job topics run first, then
035's consumers, then the notification fan-out), `lib/notify/topics.ts` / `templates/index.ts` /
`tests/notify-templates.test.ts` (intake link + Meet + reconnect + refund topics), `lib/privacy/registry.ts`
(`intake_attempts` + `payments`), `lib/elevenlabs/agent.ts` (033's comment, same `agentId` parameter),
`app/dashboard/schedule/page.tsx` and `app/family/(portal)/appointments/page.tsx` (intake status / link next to the
Meet panel and payment labels), docs (`booking.md`, `notifications.md` consumers + job topics sections,
`privacy/retention.md`); `messages/REVIEW.md` regenerated (2238 rows). After `$H 5 <worktree> reset` (28 migrations):

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0 |
| `npx vitest run` | PASS | **82 files, 1328 passed, 11 skipped** (same pre-existing opt-in skips; every DB suite ran) |
| `tests/appointment-intake.test.ts` | PASS | 15 tests (`evidence/appointment-intake-tests-verbose.txt`), 2 new: |
| Paid booking (031) | PASS | online child_dev service -> `pending_payment`, no confirmation and no attempt yet; payment order + `payment_apply_captured` (the path shared by `/api/payments/verify` and the Razorpay webhook) -> `confirmed` -> `appointment.confirmed` consumer links the case and issues the attempt; guardian confirmation carries the link |
| Video confirmation (037) | PASS | video generic service, guardian with a linked Google identity -> `meet.create` job queued (`meet:<id>:create`, pending) **and** the confirmation's consumer issues the intake attempt (`payload.intake.status = link`); enriching the payload does not queue a second Meet job (037's trigger is insert-only) |

Merge fix: `next build` failed with TS2589 ("type instantiation is excessively deep") in
`lib/i18n/translate.ts` once the merged catalogue reached ~2200 keys (plain `tsc --noEmit` passed).
`createTranslator` now types its inner function loosely and casts once to `TFunction<N>` (no behaviour change; the
i18n suites pass).

## Merge of main (034 voice booking agent)

Second `git merge main`. `lib/i18n/translate.ts`: main's version kept (034 fixed the same TS2589 the same way:
loosely typed inner function, one cast to `TFunction<N>`); `messages/{en,hi,te}.json` merged cleanly with both sides'
keys (`voiceBooking` + 035's `intake.appointment*` / `booking.*.intake`), `messages/REVIEW.md` regenerated (2266 rows);
`docs/booking.md` keeps 034's voice-agent note and 035's intake pointer. After `$H 5 <worktree> reset` (30
migrations): lint 0, typecheck 0, build 0, `npx vitest run` **83 files, 1351 passed, 11 skipped** (pre-existing
opt-in skips; every DB suite ran), `tests/appointment-intake.test.ts` 15 passed.
