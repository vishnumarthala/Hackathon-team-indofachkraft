# 035: Appointment-scoped pre-consult intake

**Status:** done
**Mode:** solo
**Runs:** waits for 021, 024, 030, 041: uses clinical contracts/report kinds (024) and confirmed appointments (030); the pre-consult brief reads the child's health profile (021); real child data needs the privacy/audit baseline (041)

## Summary

A confirmed appointment selects or creates the organisation's case for the child (rule 11), assigns the
provider, and issues an **appointment-bound** intake link in the confirmation message. Child-development
services use the existing Child-Dev intake agent (en/hi/te); other services use a new English-only
generic intake agent that produces a generic pre-consult brief. Intake attempts, recordings and briefs
are scoped to the appointment and processed idempotently.

## Functional requirements

- **FR-1** - Migration `<ts>_appointment_intake.sql`: `appointments.case_id` FK; `recordings.appointment_id
  null`, `reports.appointment_id null`; `reports.kind` check extended with `generic_intake_brief`;
  `intake_attempts(id, appointment_id, case_id, token_hash unique, agent_kind text check in
  ('child_dev','generic'), status text check in ('issued','started','completed','expired','revoked'),
  expires_at, conversation_id text unique null, started_at, completed_at, created_at)`.
- **FR-2** - On `appointment.confirmed` (outbox consumer `appointment.link_case`, idempotent by
  appointment id): find an open case in the appointment's org with the same `child_id`; else create one
  (`child_alias` = child display name, `language` = guardian `preferred_locale`); add `case_assignments`
  for the provider's user (022); set `appointments.case_id`. Re-running does nothing.
- **FR-3** - If `services.intake_kind <> 'none'` and the child has consent `ai_intake_call` (020): create
  an `intake_attempts` row (token 43 chars, hash stored, `expires_at` = appointment start) and include
  `Before your visit, please take a short voice call with our AI assistant: <APP_URL>/intake/a/<token>`
  in the confirmation (in-app + email; WhatsApp template param). Without consent: the confirmation
  says `Allow the AI intake call in your DoctorNearMe app to prepare for this visit.` and the link is
  issued when consent is granted (consumer of `consent.granted`).
- **FR-4** - `/intake/a/[token]` reuses the 009 page/flow: Child-Dev agent (language select en/hi/te) for
  `child_dev`; generic agent (`ELEVENLABS_GENERIC_INTAKE_AGENT_ID`, English, no language select) for
  `generic`. Start re-checks consent, token status and expiry (410 `This link has expired`). Dynamic
  variables include `intake_attempt_id`, never the case id. Cancelling/rescheduling the appointment
  revokes/moves the attempt.
- **FR-5** - Completion (webhook/complete endpoint, idempotent by `conversation_id`): verifies agent id and
  `intake_attempt_id`; creates the `intake_call` recording with `appointment_id`; Child-Dev -> existing
  010 brief pipeline; generic -> `generic_intake_brief` via `prompts/generic-intake.md` and
  `schemas/generic-intake.json` (reason for visit, history, current concerns, medications/allergies
  checked against the 021 health summary when 021 is merged, questions for the provider). A second webhook for the same conversation ->
  200 `{ received: true, duplicate: true }`.
- **FR-6** - Provider agenda/appointment view shows `Intake: not started / completed` and links to the
  brief in the case. `docs/elevenlabs-generic-intake-agent.md` describes the generic agent (English, AI
  disclosure, no diagnosis, red-flag 108/112 message, 10-minute limit, data-collection fields).

## Non-functional requirements

- **NFR-1** - All processing steps idempotent (retries do not create duplicate cases, recordings or briefs).
- **NFR-2** - Existing case-level intake links (009) keep working unchanged for provider-created cases.

## Affected areas

- `supabase/migrations/<ts>_appointment_intake.sql` (new); `lib/intake/**` (extend), `lib/booking/case-link.ts` (new)
- `app/intake/a/[token]/**`, `app/api/intake/a/[token]/**` (new); `app/api/webhooks/elevenlabs/route.ts` (route by attempt)
- `prompts/generic-intake.md`, `schemas/generic-intake.json`, `docs/elevenlabs-generic-intake-agent.md` (new)
- `lib/notify/topics.ts` + templates, `lib/clinical/reports.ts` (kind), `.env.example`, `messages/*.json`
- `tests/appointment-intake.test.ts` (new)

## Don't touch

- Child-Dev agent prompt and language set, booking state machine (030), existing migrations, `BOARD.md`

## Out of scope

- Intake for walk-in appointments, phone-call intake, multiple intake attempts per appointment (one active).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Case per appointment | Reuse open org case for the child, else create | rule 11 |
| D-2 | Agents | Child-Dev existing (en/hi/te); generic new (en) | plan §4 voice agents table |
| D-3 | Link scope | Appointment-bound, expires at start, revocable | rule 6 |
| D-4 | Which agent | `services.intake_kind` (default `child_dev` for dev-ped, psychiatrist, psychologist, SLP, OT, ABA, special educator; `generic` for physio and paediatrician) | plan says Child-Dev vs "others"; provider can override |

## Open questions

None.
