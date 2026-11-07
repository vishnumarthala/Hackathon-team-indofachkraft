# Grill: CareThread hackathon MVP

**Status:** confirmed
**Started:** 2026-11-07
**Rounds so far:** 1

> Round 1 was sent to the user, who was not available to answer. Per the write-tickets rule ("if the
> user won't decide, pick the safest option, write it as a decision and say so"), every open item was
> settled with the recommended option and is marked **agent-decided**. Tickets stay `draft`; the team
> reviews these decisions before running `/super-agent:mark-ready`.

## Goal

Build CareThread today (deadline 17:00): an AI assistant for early intervention therapists that runs a
browser voice intake with the parent, fills the 40-item ISAA form from a recorded session with evidence
for the therapist to confirm, and hands a referral packet with "ask the case" to a specialist.
Success = Phase 2 end to end by 13:30, Phases 1 and 3 + landing page by 15:30 feature freeze.

## Facts found

| # | Fact | Source |
|---|------|--------|
| F-1 | Repo has no app code yet: only the team plan (.md/.pdf); branch `main` | `git ls-files`, `git branch` |
| F-2 | Stack chosen: Next.js App Router + Tailwind on Vercel, Supabase, Gemini, ElevenLabs, Resend | Team plan section 3 |
| F-3 | No n8n and no Twilio: workflows are API routes + webhooks; intake is a browser voice call | Team plan section 3 (updated today) |
| F-4 | Scribe model id is `scribe_v2`; params `diarize`, `num_speakers`, `timestamps_granularity=word`; words carry `speaker_id`, `start`, `end`, `type` | elevenlabs.io/docs/api-reference/speech-to-text/convert |
| F-5 | `@elevenlabs/react` `startSession` accepts `agentId`, `conversationToken` or `signedUrl`, plus `dynamicVariables` and `overrides` | elevenlabs.io/docs/eleven-agents/libraries/react, .../dynamic-variables |
| F-6 | Conversation token: `GET /v1/convai/conversation/token?agent_id=` with API key | React SDK docs |
| F-7 | Post-call webhook `post_call_transcription` carries `transcript`, `analysis`, `conversation_initiation_client_data`; HMAC via `ElevenLabs-Signature` and `webhooks.constructEvent` | elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks |
| F-8 | Telugu TTS: `eleven_v3`/`eleven_v4` support Telugu; `eleven_multilingual_v2` does not | elevenlabs.io/docs/overview/models |
| F-9 | Current Gemini Flash model id: `gemini-3.8-flash` | ai.google.dev/gemini-api/docs/models |
| F-10 | Super-agent BOARD parser reads columns by header name; multiple waits must be listed before the colon | `router/super-agent/skills/setup/scripts/watchdog-scan.mjs` lines 76-96 |
| F-11 | `create-next-app` refuses non-empty folders (repo root has specs/, docs/, plan files) | create-next-app behaviour |
| F-12 | macOS `say` and `afconvert` exist on the build machine (test audio) | `which say afconvert` |
| F-13 | Vercel request bodies are limited to 4.5 MB; Supabase free plan file limit is 50 MB | Vercel / Supabase limits |
| F-14 | Resend test sender `onboarding@resend.dev` only delivers to the account owner's address | Resend docs |
| F-16 | A teammate pushed `/super-agent:setup` output directly to `main` at 11:34 (Windows laptop, Git Bash) | `git log origin/main` 641c839 |
| F-17 | Supabase CLI 3.0.0 + Docker 29.3 on this laptop; `supabase status -o env` prints `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL` | `supabase --version`, supabase.com/docs/reference/cli/supabase-status |
| F-18 | `GET /v1/convai/conversations/{id}` returns `status` (`initiated`/`in-progress`/`processing`/`done`/`failed`), `transcript`, `analysis.data_collection_results`, `conversation_initiation_client_data` | elevenlabs.io/docs/api-reference/conversations/get |
| F-15 | Role-play script says "rate item 5 as 4" for "no response to name"; in the ISAA item list item 5 is "Unable to relate to people", item 6 is "Unable to respond to social/environmental cues" | Team plan section 5, `docs/system-design.md` Appendix A |

## Decisions

| # | Question | Answer | Why |
|---|----------|--------|-----|
| D-1 | Dashboard access | No login; open app with a "Demo - synthetic data only" banner; parent/specialist pages by token | agent-decided (recommended): login is WON'T BUILD in the plan |
| D-2 | Database for workers | ~~One hosted Supabase project~~ -> replaced by D-14 (local Supabase in Docker per laptop); additive migrations only | user changed it at 12:08 |
| D-3 | ISAA items without evidence | AI leaves them empty; score is provisional ("at least N") until all 40 are confirmed; therapist can bulk-rate empty items as 1 | agent-decided (recommended): AI never rates without evidence |
| D-4 | Speaker mapping | Auto: speaker with a segment starting "Note" is the therapist, else first speaker; "Swap speakers" button | agent-decided (recommended) |
| D-5 | Email delivery | Resend test sender; `DEMO_EMAIL_TO` redirects every email to the Resend account owner | agent-decided (recommended): no DNS work today |
| D-6 | Intake language | Parent picks Telugu/Hindi/English on the intake page (default = case language), passed as agent language override | agent-decided (recommended) |
| D-7 | Parallel workers | 4 | agent-decided (recommended): faster path to the 13:30 checkpoint |
| D-8 | Ticket split | 15 tickets as on BOARD.md (Owner column = reviewing team role) | agent-decided (recommended) |
| D-9 | Install super-agent plugin and agent-browser now? | No - user-level change; commands listed for the user | agent-decided (safest) |
| D-10 | Bulk confirm | Review screen also offers "Confirm all remaining suggestions" behind a confirm dialog, audited | agent-decided: 40 single clicks would break the 3-minute demo; still an explicit therapist action |
| D-11 | FACP | Manual number on the case (0-100), not a fact row | agent-decided: no FACP data is captured by voice today |
| D-12 | Role-play "rate item 5" line (F-15) | Fixtures follow the script verbatim; team to check the item number with the ISAA manual | agent-decided: content decision belongs to D |
| D-13 | Collaboration | 4 people, 4 laptops; per-person integration branches `int/<role>`; checkpoint PRs into `main`; merge captain merges with merge commits; no direct pushes. GitHub protection requiring an approved PR, including admins, is configured; local hook is optional and bypassable. | user: "each person will work on different branches and test and merge it after checkpoint ... make sure no one pushes in main" |
| D-14 | Where does it run | Locally on each laptop; Supabase (Postgres + Storage) via the Supabase CLI in Docker, one stack per laptop | user: "we are running only on local laptop so use docker for supabase" |
| D-15 | Intake completion without a public URL | Intake page posts the `conversation_id` to `/api/intake/:token/complete`; server pulls `GET /v1/convai/conversations/:id`; webhook kept for deployed/tunnel use | ElevenLabs cannot reach localhost (follows from D-14) |
| D-16 | Super-agent per laptop | Use workers on assigned tickets with `int/<role>` as their explicit base; a person merges verified ticket branches into that integration branch. Do not run the automatic merger. | The merger checks out the configured main and includes destructive recovery; `git checkout HEAD` detaches HEAD. |
| D-17 | Ticket builders | A: 005, 009, 010, 011, 015 · B: 001, 002, 006, 012, 013 · C: 003, 004, 007, 008 · D: 014 | agent-decided: balances load, keeps the critical path on B and C, leaves D time for validation and pitch |
| D-18 | OS | Evals must run on macOS and Windows (Git Bash): no macOS-only tools, no `/tmp`, `npm run dev -- -p <port>` | a teammate's laptop is Windows (their 11:34 setup commit) |

## Assumptions

| # | Assumption | Status |
|---|------------|--------|
| A-1 | Next.js App Router, TypeScript, Tailwind, Vitest, ESLint, npm | confirmed (agent-decided) |
| A-2 | Local Supabase in Docker (D-14), RLS on with no policies, service-role key server-only, private `recordings` bucket, browser uploads via signed upload URL | confirmed (agent-decided, updated for D-14) |
| A-3 | `GEMINI_MODEL` default `gemini-3.8-flash`, JSON-schema output, one retry | confirmed (agent-decided) |
| A-4 | Gemini cites segment ids; server resolves timestamps and verifies quotes | confirmed (agent-decided) |
| A-5 | `DEMO_MODE=true` serves fixtures for Scribe, Gemini, ElevenLabs agent/TTS and Resend | confirmed (agent-decided) |
| A-6 | Referral recommended at ISAA >= 70 or red flag (item 15 lost speech, item 29 self-injury) or FACP < 40 | confirmed (agent-decided) |
| A-7 | Intake/specialist tokens are random 32-byte base64url, no expiry today | confirmed (agent-decided) |
| A-8 | Role A configures the ElevenLabs agent by hand from `docs/elevenlabs-agent.md` | confirmed (agent-decided) |
| A-9 | Fixtures written from the role-play script now; refreshed from D's real recording later | confirmed (agent-decided) |

## Out of scope

- Login, roles, multi-tenancy, payments, booking marketplace.
- Real phone calls (Twilio, SIP, Exotel), live video, live mic mode for therapist notes.
- Comparison with the previous session (plan Phase 2 output) - roadmap.
- FHIR export, real HIPAA infrastructure, real patient data.

## Branches checked

| Branch | Covered by | Notes |
|--------|------------|-------|
| Goal | Goal | |
| Users and roles | D-1 | therapist (open), parent (intake token), specialist (share token) |
| Scope | Out of scope, D-8 | |
| Flows | system-design section 12 | |
| States and data | system-design section 5 | |
| Rules | system-design section 7, A-6 | |
| Errors and edge cases | system-design section 8 error format, per-ticket edge cases | |
| Integrations | F-4..F-9, D-5, A-8 | |
| Non-functional | system-design section 13 | |
| Look and words | project.md wording rules | |
| Rollout | D-2 additive migrations, section 14 human checklist | |
| Done | eval.md per ticket | |

## Still unclear

None.

## Gap check

Done per ticket (write-tickets step 6) instead of on this record, to save time before the 11:30
contract freeze. Findings and fixes are listed in each ticket's Decisions.

## Play-back

1. Therapist creates a case for a (synthetic) child and sends the parent an intake link (WhatsApp/email).
2. Parent opens it on a phone, consents, picks Telugu/Hindi/English and talks to the ElevenLabs agent.
3. The post-call webhook turns the call into a pre-session brief (parent-reported, red flags, questions).
4. Therapist uploads the session recording; Scribe v2 transcribes with speakers; Gemini suggests all 40
   ISAA ratings with a quote and timestamp each; therapist voice notes override items.
5. Therapist confirms or edits each item; score, band, red flags and suggested action update live.
6. A draft assessment report is generated from confirmed facts only.
7. Referral creates a packet and emails the specialist a private link; the specialist asks questions
   and gets answers that cite facts and timestamps.
8. A landing page collects pilot sign-ups for validation.
9. Not today: login, phone calls, payments, real data, FHIR.
10. Done = every ticket's eval.md passes and the 3-minute demo runs on the seeded demo case.

Confirmed on 2026-11-07 as agent-decided (user unavailable); review before marking tickets ready.
