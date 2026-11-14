# Board

Status: `draft` (not ready to build) -> `ready` (router may pick it up) -> `done` (merged into the
builder's integration branch; on `main` after the next checkpoint).
Mode: `solo` (one worker in its own worktree) or `team` (teammates that talk to each other).
Runs: `alongside` (can run at the same time as others) or `waits for NNN: <reason>`.

Only the team marks tickets `ready`. The builder manually marks tickets `done` after integrating
their passing worker branch; do not use the unadapted automatic merger.
**Each builder only edits rows in their own table** (one table per integration branch, so checkpoint
PRs never conflict here). Workflow, branches and checkpoints: [docs/team-workflow.md](../../docs/team-workflow.md).
Priority follows the team plan: MUST = Phase 2 (001-008), SHOULD (009-014), NICE (015).
A ticket that waits for another builder's ticket can start once that ticket is `done` in their table
on `main` or on their pushed `int/<role>` branch (`git merge origin/int/<role>`).
All tickets remain draft until their requirements and evaluations have been reviewed together.

## B. AI and backend - `int/b-backend`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 001 | Foundations - scaffold, schema, shared contracts | done | solo | alongside | MUST | express (target ~13:15) |
| 002 | Demo fixtures and seed | done | solo | waits for 001: needs lib/types.ts, lib/db.ts, the migration and npm scripts | MUST | CP1 13:30 |
| 006 | ISAA extraction with Gemini | done | solo | waits for 002: needs the extract fixture and seed --stage transcribed | MUST | CP2 14:15 |
| 012 | Referral packet, specialist page and email | done | solo | waits for 002, 003, 004: needs seed --confirmed, lib/scoring.ts and the Referral tab | SHOULD | CP3 15:00 |
| 013 | Ask the case | done | solo | waits for 012: adds the chat to the specialist page and reuses EvidencePlayer | SHOULD | CP4 15:30 |

## C. Frontend - `int/c-frontend`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 003 | Scoring and routing | done | solo | waits for 001: needs schemas/*.json, lib/types.ts and the Vitest setup | MUST | CP1 13:30 |
| 004 | Cases dashboard and case pages | done | solo | waits for 001: needs the scaffold, lib/db.ts, lib/http.ts and the cases table | MUST | CP1 13:30 |
| 007 | Therapist review screen | done | solo | waits for 002, 003, 004: needs seeded sessions, lib/scoring.ts and the case layout | MUST | CP2 14:15 |
| 008 | Upload and process panel, speaker swap | done | solo | waits for 005, 006, 007: calls their APIs and edits 007's review page | MUST | CP3 15:00 |

## A. Voice - `int/a-voice`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 005 | Session upload and Scribe v2 transcription | done | solo | waits for 002: needs the Scribe fixture, role-play segments, test audio and seed | MUST | CP2 14:15 |
| 009 | Intake link and browser voice call | done | solo | waits for 004: replaces the Brief tab placeholder | SHOULD | CP2 14:15 |
| 010 | Intake completion and pre-session brief | done | solo | waits for 002, 009: needs post-call/brief fixtures and edits 009's pages | SHOULD | CP3 15:00 |
| 011 | Draft assessment report | done | solo | waits for 002, 003, 004: needs seed --confirmed, lib/scoring.ts and the Report tab | SHOULD | CP3 15:00 |
| 015 | Parent voice note (Telugu TTS + email) | done | solo | waits for 011: adds a section to the Report tab | NICE | CP4 15:30 |

## D. Founder and pitch - `int/d-pitch`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 014 | Landing page and pilot sign-up | done | solo | waits for 001: replaces the placeholder home page | SHOULD | CP1 13:30 |

## Critical path

001 -> 002 -> 005 + 006, and 001 -> 003 + 004 -> 007 -> 008 = Phase 2 end to end on `main` at CP3 (15:00).
Human tasks that tickets depend on (not tickets): `docs/system-design.md` section 14.


# DoctorNearMe (tickets 016-042) - `feat/doctornearme`

Decision record: [specs/grill/doctornearme-mvp.md](../grill/doctornearme-mvp.md). Built by AI workers;
`done` = merged into `feat/doctornearme`. Draft tickets need a team review before `ready`.

## M1 - SaaS core and pilot safety

| # | Title | Status | Mode | Runs |
|---|-------|--------|------|------|
| 016 | Rebrand to DoctorNearMe (user-facing) | done | solo | alongside |
| 017 | Organisations, roles, resource-level authorisation and provider onboarding | done | solo | alongside |
| 018 | i18n foundation (English, Hindi, Telugu) | done | solo | alongside |
| 019 | Guardian sign-in and family portal shell | done | solo | waits for 017, 018 |
| 020 | Children, guardian links and consent gating | done | solo | waits for 019 |
| 021 | Child health profile | done | solo | waits for 020 |
| 022 | Care team, provider assignments and cross-org sharing grants | done | solo | waits for 020 |
| 023 | Document vault | done | solo | waits for 022 |
| 024 | Assessment portal and shared clinical contracts | done | solo | waits for 022 |
| 025 | IEP plans, SMART goals and progress tracking | done | solo | waits for 022, 024 |
| 026 | Home program | done | solo | waits for 023, 025 |
| 027 | Secure messaging (guardian <-> care team) | done | solo | waits for 022, 023, 032 |
| 032 | Notifications - transactional outbox, scheduler, email / in-app / WhatsApp adapters | done | solo | waits for 020 |
| 041 | Privacy, audit and operations baseline | done | solo | waits for 023, 032 |

## M2 - Directory, booking and voice

| # | Title | Status | Mode | Runs |
|---|-------|--------|------|------|
| 028 | Public provider profiles, credential verification, admin seeding and claim links | done | solo | waits for 017, 018 |
| 029 | PostGIS "near me" directory with Google Maps | done | solo | waits for 028 |
| 030 | Availability and atomic one-off booking | done | solo | waits for 028, 032, 041 |
| 031 | Razorpay payments (test mode) | done | solo | waits for 030 |
| 033 | Voice developmental check-in (public screen) | done | solo | waits for 020, 024, 029, 041 |
| 034 | Voice booking agent (web widget on /find) | done | solo | waits for 030, 033 |
| 035 | Appointment-scoped pre-consult intake | done | solo | waits for 021, 024, 030, 041 |
| 036 | Ratings for completed appointments | done | solo | waits for 030 |
| 042 | Hyderabad directory seed data (synthetic demo + real-provider import) | done | solo | waits for 029, 030 |

## M3 - Video, scribe, prescriptions and follow-up

| # | Title | Status | Mode | Runs |
|---|-------|--------|------|------|
| 037 | Google Meet for video appointments | done | solo | waits for 030 |
| 038 | AI scribe for any provider type | done | solo | waits for 024, 025, 028, 041 |
| 039 | E-prescriptions for verified prescribers | done | solo | waits for 021, 028, 038 |
| 040 | Follow-up agent ("ask about my child's plan") | done | solo | waits for 026, 033, 039 |

## M4 - Pilot readiness (from the [PMF check](../grill/doctornearme-pmf-check.md), 2026-11-13)

| # | Title | Status | Mode | Runs |
|---|-------|--------|------|------|
| 043 | Recurring therapy sessions (weekly series) | done | solo | alongside |
| 044 | Attendance register | done | solo | waits for 043 |
| 045 | Packages and family payments on DoctorNearMe | done | solo | waits for 043, 044 |
| 046 | Payouts to centres and the platform fee (Razorpay Route) | done | solo | waits for 044, 045 |
| 047 | Import existing children from a spreadsheet | done | solo | alongside |
| 048 | Parent check-in up to 8 (age-aware, concern-based advice, inline slots) | done | solo | waits for 051 |
| 049 | Telugu and Hindi for the new voice agents | done | solo | waits for 048, 051 |
| 050 | Parent-first home page and Indian statistics | done | solo | waits for 051 |
| 051 | Voice cost guard (no anonymous voice, quotas, platform budget) | done | solo | alongside |
| 052 | Clear next steps (family home, provider Today, what happens next) | done | solo | waits for 043, 044, 045, 051 |
| 053 | Design-system alignment (teal primary actions, shared UI primitives) | ready | solo | waits for 043-052 |

## Critical path (DoctorNearMe)

017 -> 019 -> 020 -> 022 -> 023 -> 041, and 020 -> 032 -> 041 -> 030 (booking) -> 034/035.
Real child data needs 020 (consent) and 041 (privacy/audit) on `main` first.
M4: 043 -> 044 -> 045 -> 046 (business model) and 051 -> 048 -> 049, 051 -> 050; 052 after 045/051; 053 last.
