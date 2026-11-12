# 016: Rebrand to DoctorNearMe - Evaluation

## Setup

Install dependencies. No database is required.

## Automated checks

- `npm run lint`, `npm run typecheck` and `npm test` exit 0 (DB-backed suites may be skipped when no
  local Supabase is running; record which).
- `rg -n "CareThread" app components lib prompts tests .env.example` returns only the module tagline
  ("powered by the CareThread engine") and comments; no other user-visible string.
- `rg -n "__carethread|is_carethread_admin|carethread:demo-call-ended"` still finds the internal
  identifiers (NFR-1).

## Acceptance checks

### E-1: Pages
Open `/`, `/book-demo`, `/login`, an `/intake/<token>` page and a `/specialist/<token>` page: browser tab
titles, wordmark, aria labels and body copy say DoctorNearMe; the landing subtitle mentions the Child
Development module powered by the CareThread engine.

### E-2: Messages
The intake message, intake email subject, referral email subject/body and default email sender say
DoctorNearMe (covered by `tests/intake-message.test.ts`, `tests/intake-routes.test.ts`, `tests/env.test.ts`).

### E-3: Docs
`docs/elevenlabs-agent.md` names the agent `DoctorNearMe Child Development Intake` and lists the manual
update of the published agent.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] No historical specs, migrations or package names changed.
