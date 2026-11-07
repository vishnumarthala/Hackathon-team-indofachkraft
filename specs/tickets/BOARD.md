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
| 001 | Foundations - scaffold, schema, shared contracts | draft | solo | alongside | MUST | express (target ~13:15) |
| 002 | Demo fixtures and seed | done | solo | waits for 001: needs lib/types.ts, lib/db.ts, the migration and npm scripts | MUST | CP1 13:30 |
| 006 | ISAA extraction with Gemini | draft | solo | waits for 002: needs the extract fixture and seed --stage transcribed | MUST | CP2 14:15 |
| 012 | Referral packet, specialist page and email | draft | solo | waits for 002, 003, 004: needs seed --confirmed, lib/scoring.ts and the Referral tab | SHOULD | CP3 15:00 |
| 013 | Ask the case | draft | solo | waits for 012: adds the chat to the specialist page and reuses EvidencePlayer | SHOULD | CP4 15:30 |

## C. Frontend - `int/c-frontend`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 003 | Scoring and routing | done | solo | waits for 001: needs schemas/*.json, lib/types.ts and the Vitest setup | MUST | CP1 13:30 |
| 004 | Cases dashboard and case pages | done | solo | waits for 001: needs the scaffold, lib/db.ts, lib/http.ts and the cases table | MUST | CP1 13:30 |
| 007 | Therapist review screen | draft | solo | waits for 002, 003, 004: needs seeded sessions, lib/scoring.ts and the case layout | MUST | CP2 14:15 |
| 008 | Upload and process panel, speaker swap | draft | solo | waits for 005, 006, 007: calls their APIs and edits 007's review page | MUST | CP3 15:00 |

## A. Voice - `int/a-voice`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 005 | Session upload and Scribe v2 transcription | done | solo | waits for 002: needs the Scribe fixture, role-play segments, test audio and seed | MUST | CP2 14:15 |
| 009 | Intake link and browser voice call | done | solo | waits for 004: replaces the Brief tab placeholder | SHOULD | CP2 14:15 |
| 010 | Intake completion and pre-session brief | draft | solo | waits for 002, 009: needs post-call/brief fixtures and edits 009's pages | SHOULD | CP3 15:00 |
| 011 | Draft assessment report | draft | solo | waits for 002, 003, 004: needs seed --confirmed, lib/scoring.ts and the Report tab | SHOULD | CP3 15:00 |
| 015 | Parent voice note (Telugu TTS + email) | draft | solo | waits for 011: adds a section to the Report tab | NICE | CP4 15:30 |

## D. Founder and pitch - `int/d-pitch`

| # | Title | Status | Mode | Runs | Priority | Checkpoint |
|---|-------|--------|------|------|----------|------------|
| 014 | Landing page and pilot sign-up | draft | solo | waits for 001: replaces the placeholder home page | SHOULD | CP1 13:30 |

## Critical path

001 -> 002 -> 005 + 006, and 001 -> 003 + 004 -> 007 -> 008 = Phase 2 end to end on `main` at CP3 (15:00).
Human tasks that tickets depend on (not tickets): `docs/system-design.md` section 14.
