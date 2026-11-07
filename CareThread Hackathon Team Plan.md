# CareThread: Hackathon Team Plan

Nov 7, 2026 · @Vishnu

## 1. The idea

**Name:** CareThread (one thread from the first call to the specialist). Backups if the name is taken: Saathi, KidCase. Spend 2 minutes on a domain check, then decide and stop debating.

**One-liner:** CareThread is the AI assistant for early intervention therapists. It calls the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.

**Customer:** early intervention therapists and child psychologists who run autism assessments.

- First market: Indian early intervention centres (our network, ISAA is a free government scale, fast sales).
- Second market: German Autismus-Therapiezentren and SPZ, where most centres have waiting times of a year or longer.

**Who pays:** the centre, monthly subscription per clinician. Price hypothesis to test in today's calls: Rs 3,000 per clinician per month (India), EUR 199 (Germany).

**Core principle:** AI documents, the clinician decides.

### The three phases

| Phase | What happens | AI output | Human decision |
| --- | --- | --- | --- |
| 1. Intake call | After booking, the parent gets a link (WhatsApp or email), opens it on their phone and talks to the AI voice agent in the browser in Telugu, Hindi or English (max 15 min). Opens with consent and "I am an AI assistant". | Pre-session brief: summary, red flags (lost speech, self-injury), questions to verify. Every answer marked "parent-reported". | Therapist reviews the brief before session 1 |
| 2. Online session | Session recorded with consent. Therapist can speak notes, e.g. "rate item 5 as 4, no response to name". | ISAA items filled with suggested rating, evidence quote and timestamp. Draft report. Comparison with the previous session. | Therapist confirms or edits every item |
| 3. Specialist handoff | Severe band, ISAA 70 or more, or any red flag: AI recommends referral. | Referral packet (summary, scores, evidence clips, intake, decisions) plus "ask the case" with cited answers. | Therapist decides to refer, parent consents to share |

### Score routing (fixes our old flowchart)

Old chart had gaps at exactly 80, 60 and 40, and all lower bands said only "IEP Develop". New rule:

| FACP score | Band | Suggested action (therapist confirms) |
| --- | --- | --- |
| 80 or more | Typical | Home program and parent counselling, re-screen in 3 months |
| 60 to 79 | Borderline | IEP and home program, review in 3 months |
| 40 to 59 | Moderate | IEP and regular therapy sessions |
| below 40 | Severe | IEP and referral to specialist (Phase 3) |
| any score | ISAA 70 or more, or red flag | Referral to specialist (Phase 3) |

ISAA bands for the demo: below 70 no autism, 70 to 106 mild, 107 to 153 moderate, above 153 severe.

## 2. Scope for today

**MUST (Phase 2 end to end on `main` by CP3, 15:00)**

- Phase 2 core: upload role-play session audio, ElevenLabs Scribe v2 transcript with speakers, Gemini fills the 40 ISAA items (rating, evidence quote, timestamp, confidence), therapist taps confirm or edit, total score and band shown.

**SHOULD (by 15:30)**

- Phase 1: browser voice intake. A teammate opens the intake link on their phone, taps Start and talks to the ElevenLabs agent. Fallback: ElevenLabs embed widget on the same page.
- Phase 1: pre-session brief page built from the call.
- Phase 3: referral packet page and "ask the case" chat with cited answers.
- Landing page with "Join the pilot" sign-up form (needed for validation evidence).

**NICE TO HAVE**

- Parent summary as a voice note in Telugu (ElevenLabs TTS), sent by email via Resend from a Next.js API route.
- Therapist voice notes in live mode (mic, not upload).

**WON'T BUILD TODAY**

- Live video calling (use a pre-recorded role-play instead).
- Real phone calls (Twilio, SIP trunk, Exotel). Today the parent talks to the agent through a browser link; phone calls are roadmap.
- Booking marketplace, payments, login and multi-tenant setup.
- Real patient data of any kind. Real HIPAA infrastructure.

## 3. Architecture and stack

| Layer | Tool | Notes |
| --- | --- | --- |
| App | Next.js (App Router) + Tailwind, runs locally on each laptop | One app: therapist dashboard, specialist page, landing page. Vercel deploy is optional (decided at 15:30) |
| Data | Supabase (Postgres + Storage) in Docker on each laptop | `npx supabase start`; schema in `supabase/migrations/`. Audio files in the local Storage bucket |
| Intake call | ElevenLabs Agents + React SDK (WebRTC in the browser) | No phone number or telephony provider. Parent opens `/intake/[token]`, taps Start. Agent collects proforma answers via data collection fields, posts to our webhook after the call |
| Transcription | ElevenLabs Scribe v2 (batch, diarization on) | Speaker labels: parent, therapist |
| Parent summary | ElevenLabs TTS | Telugu or Hindi voice note |
| AI | Gemini API (Google credits) | Structured JSON output against our schema. Extraction, brief, report, ask-the-case |
| Workflows | Next.js API routes + webhooks | No separate workflow tool. Booking form calls our API, which creates the intake link (shared by WhatsApp link or Resend email). When the browser call ends, our API fetches the finished conversation from ElevenLabs and builds the brief (the post-call webhook is used only when deployed). Refer button calls our API, which emails the specialist. Optional: Supabase Database Webhooks for DB-triggered steps |
| Email | Resend (free tier) | Specialist referral email and parent voice-note email |
| Build | Cursor, Wispr Flow | Dictate prompts and code |

### Flow

```
PHASE 1  Booking form -> POST /api/cases/:id/intake-link -> link to parent (WhatsApp / email)
         -> parent opens link, talks to ElevenLabs agent in the browser
         -> call ends -> our API fetches the conversation (transcript + collected fields)
         -> Gemini -> pre-session brief -> DB

PHASE 2  Session audio upload -> Scribe v2 (diarized transcript)
         -> Gemini extraction (ISAA schema) -> facts (status: suggested)
         -> therapist confirms in UI -> score + band -> draft report

PHASE 3  Refer button -> Gemini builds referral packet from confirmed facts
         -> Resend email to specialist with link
         -> specialist page -> ask-the-case (answers cite fact + timestamp)
```

### Data model: the case memory

Every piece of information is a fact with its source. This is our moat and our architecture slide.

```
fact {
  id, case_id, recording_id, instrument: "ISAA" | "CASE_SHEET",
  item_id, value, ai_value,
  source: "parent_call" | "session" | "therapist_voice",
  evidence: { quote, segment_id, start_sec, end_sec, recording_id, verified },
  confidence: 0..1,
  status: "suggested" | "confirmed" | "edited",
  confirmed_by, confirmed_at, created_at
}
```

Tables: `cases`, `recordings`, `facts`, `reports`, `referrals`, `case_questions`, `audit_events`, `pilot_signups`. FACP is a number on the case (entered by the therapist). Maps later to FHIR (Patient, Encounter, QuestionnaireResponse, ServiceRequest). Full DDL, types and rules: [docs/system-design.md](docs/system-design.md).

### Contracts to agree at 11:30 (do not change after)

Full list with request/response shapes: [docs/system-design.md](docs/system-design.md) section 8.

- `/schemas/isaa.json`: the 40 items, 6 domains, 1 to 5 scale. Single source of truth for prompt and UI.
- `POST /api/cases/:id/intake-link` (create the parent intake link, optionally email it)
- `POST /api/intake/:token/start` (returns ElevenLabs conversation token for the browser call)
- `POST /api/webhooks/elevenlabs` (post-call data)
- `POST /api/cases/:id/sessions` (signed upload URL for the session audio)
- `POST /api/sessions/:id/transcribe`
- `POST /api/sessions/:id/extract`
- `PATCH /api/facts/:id` (confirm or edit)
- `POST /api/sessions/:id/report`
- `POST /api/cases/:id/refer`
- `POST /api/cases/:id/ask`

### Repo and Git rules

```
carethread/
  app/          Next.js pages + API routes
  lib/          env, db, types, isaa, gemini, email, audit, scoring, transcript, extraction,
                elevenlabs/ (stt, agent, tts), intake/, report/, referral/, ask/
  schemas/      isaa.json, case-sheet.json, facp.json
  prompts/      extract.md, brief.md, report.md, referral.md, ask.md, parent-summary.md
  supabase/     migrations/0001_init.sql
  scripts/      migrate.ts, seed-demo.ts, make-scribe-fixture.ts
  demo/         role-play audio, fixtures for DEMO_MODE
  docs/         system-design.md, elevenlabs-agent.md
  specs/        super-agent tickets (BOARD.md) and grill record
  README.md     setup, no login needed, architecture
```

**Git rules (full version: [docs/team-workflow.md](docs/team-workflow.md))**

- **Nobody pushes to `main`.** GitHub branch protection now requires an approved PR, including for admins. The local pre-push hook is optional and bypassable; required CI comes after ticket 001.
- Each person works on their own integration branch: `int/a-voice`, `int/b-backend`, `int/c-frontend`, `int/d-pitch`. Tickets are built on `ticket/NNN-slug` and merged into your `int/` branch only after their eval passes.
- At each checkpoint (CP1 13:30, CP2 14:15, CP3 15:00, CP4 15:30 freeze, CP5 16:15) everyone opens one PR `int/<role> -> main`; the merge captain merges with a merge commit, then everyone merges `origin/main` back into their branch.
- Never rebase or force-push a pushed branch; need a teammate's work early? `git merge origin/int/<their-role>`.
- Each laptop runs its own Supabase in Docker; commit only migrations, never `.env.local`. Commit `.env.example`. Never commit API keys.
- Commit on your branch every 30 to 45 minutes and push (judges look at history).

## 4. Roles

Write your name next to your role.

| Role | Owner | Owns | Done means |
| --- | --- | --- | --- |
| A. Voice | \_\_\_\_\_\_ | ElevenLabs agent (prompt, data collection fields, Telugu/Hindi/English), browser intake page (React SDK), Scribe v2 integration, TTS parent summary | Teammate opens the link on their phone, AI talks, call data lands in our DB |
| B. AI and backend | \_\_\_\_\_\_ | ISAA schema, Gemini prompts (extract, brief, report, ask), API routes and webhooks, Supabase, Resend email, scoring logic | Role-play audio in, 40 items with evidence out, valid JSON every time |
| C. Frontend | \_\_\_\_\_\_ | Therapist dashboard (brief, live form with evidence, report), specialist page, landing page with sign-up form | A judge can click through the full flow without help |
| D. Founder and pitch | \_\_\_\_\_\_ | Customer calls, role-play recording, deck, video, README, submission, timekeeping | 5 slides, 3-minute video, all links tested |

D also calls out the checkpoints and has the final say on cutting scope.

**Work split:** the build is split into 15 draft super-agent tickets in [specs/tickets/BOARD.md](specs/tickets/BOARD.md), one table per builder: A builds 005, 009, 010, 011, 015; B builds 001, 002, 006, 012, 013; C builds 003, 004, 007, 008; D builds 014. Use super-agent workers for assigned, fully specified tickets; builders manually integrate passing work on their own branches. Do not use the unadapted automatic merger. Human-only tasks (accounts, keys, ElevenLabs agent setup, role-play recording) are listed in [docs/system-design.md](docs/system-design.md) section 14.

## 5. Timeline

| Time | What | Who |
| --- | --- | --- |
| 10:55 to 11:30 | Claim credits now: Google AI (only until 13:00, max 70 people), ElevenLabs perk via Discord, Cursor. Create repo and a Resend API key. Agree schema and API contracts. Lock team in the portal before 11:30. | All |
| 11:00 | Send validation messages (section 6) | D |
| Now to target 12:45 | Reconcile and review the plan PR; everyone prepares Docker and reads assigned tickets. Enable the hook after the plan PR lands. | All |
| **Target 12:45** | **CP0: plan PR merged into `main`.** B starts 001 once its spec is ready. | Captain, B |
| After CP0 to target 13:15 | B: 001. A: ElevenLabs agent setup. C: read 003/004/007, UI sketch. D: role-play recording, validation calls. | All |
| Target ~13:15 | 001 express merge when green (only merge outside a checkpoint). Everyone merges `origin/main`, `npm install`, `npx supabase start`. | Captain, All |
| **13:30** | **CP1:** 002, 003, 004, 014 on `main` | All |
| **14:15** | **CP2:** 005, 006, 007, 009 on `main` | All |
| **15:00** | **CP3: Phase 2 end to end on `main` (008), plus 010, 011, 012.** If Phase 2 is not there, everyone helps; D cuts 013/015. Validation cut-off: quotes collected, sign-ups counted. | All, D |
| **15:30** | **CP4: Feature freeze.** 013, 015 only if green. After this, bug-fix PRs only (`fix/<slug>`). | All |
| 15:30 to 16:15 | Deck, record demo screen capture from `main`, decide product link (deploy or tunnel) | D + C |
| **16:15** | **CP5: final merge of fixes, `main` tagged `demo`** | Captain |
| **16:30** | **Checkpoint: video on YouTube (unlisted), all links tested in an incognito window** | D |
| 16:45 | Team lead submits in the portal | Lead |
| 17:00 | Hard deadline, no late submissions |  |

### Role-play script for the demo audio (D records by 13:30)

4 minutes, two adults, quiet room, synthetic names only. The parent (in English with some Telugu) must clearly mention at least 10 ISAA signs so the form fills visibly:

- does not look at us when we talk (poor eye contact)
- does not turn when we call his name
- said a few words at age 2, then stopped talking (lost speech: red flag)
- lines up toys, plays alone, does not play with cousins
- repeats lines from cartoons (echolalia)
- covers ears at the mixer and pressure cooker (sensory)
- flaps hands when excited
- big tantrum if we change the route to school (insists on sameness)
- hits his own head when upset (self-injury: red flag)
- does not point to show us things

The therapist speaks two notes aloud, for example "Note: child did not respond to name in three attempts, rate item 5 as 4."

## 6. Customer validation (25% of the score)

**Targets by 15:00:** 5 therapist conversations, 5 parent conversations, 3 or more pilot sign-ups on the landing page.

**Where:** our therapist contacts in India, Telugu and Indian parent WhatsApp groups in Germany, mentors and people at the venue.

**Message to send (WhatsApp):**

> Hi, we are building an AI assistant for autism and early intervention therapists at a hackathon today. Could I ask you 3 quick questions (5 minutes, voice note is fine)? It would really help us.

**Therapist questions**

1. How long does one first assessment take, including writing the report?
2. While the parent talks and the child plays, how do you fill the proforma today?
3. If an AI called the parent before session 1 and gave you a brief, would you use it? What would you pay per month?

**Parent questions**

1. How long did you wait for the first assessment?
2. Would you take a 15-minute call from an AI assistant in Telugu or Hindi before the first visit?
3. When your child was referred to a specialist, did you have to repeat everything again?

**Log every conversation here** (this goes on slide 3):

| Who | Role and country | Key quote | What we changed because of it |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

Only use quotes with permission. No real child names or health details in the deck.

## 7. Pitch deck and video

### Deck (max 5 slides)

1. **Problem:** An early intervention therapist has to watch the child and fill a 40-item form at the same time. In Germany most autism centres have waiting lists of a year or longer. Indian parents abroad struggle to explain symptoms in a foreign language, and every referral means telling the whole story again.
2. **Solution:** CareThread: AI calls the parent before the visit, fills the assessment form during the session, and hands the full case to the specialist. 10x: zero manual form filling, parent prepared in their own language, case memory that travels with the child.
3. **Product and validation:** 3 screenshots (brief, form with evidence, referral packet), our customer quotes, number of pilot sign-ups, what we changed after the conversations.
4. **Go-to-market:** first 3 pilot centres in India through our network, subscription per clinician, then German autism centres and SPZ once the medical device (MDR) path is clear. Distribution through therapist associations and Indian parent communities.
5. **Why us, why now:** AI Solution Architect with healthcare and Telugu/Hindi language reach, voice AI is finally good in Indian languages, AI scribes are already accepted in adult medicine but missing in child development. Yes, we would go full time if pilots convert.

### Video (max 3 minutes, YouTube unlisted)

| Time | Content |
| --- | --- |
| 0:00 to 0:45 | Pitch: problem, who pays, one quote from a therapist |
| 0:45 to 1:15 | Phase 1: book, parent taps the WhatsApp link, 15 seconds of the AI call in Telugu, brief appears |
| 1:15 to 2:15 | Phase 2: session audio runs, form fills itself with evidence, therapist voice note fills an item, score and band |
| 2:15 to 2:45 | Phase 3: severe band, Refer, specialist asks "When did speech regress?", answer cites the timestamp |
| 2:45 to 3:00 | Close: pilots, ask, team |

Record the demo screen capture first, then the pitch. Never use real children or real patient data on screen.

## 8. Rules, wording and risks

**Hackathon rules we must respect**

- Fresh repo and fresh code today. No code from earlier projects, no old booking screens in the demo.
- This is a new product (CareThread), not a continuation of an existing startup.

**Say this / not this** (a startup lawyer is on the jury)

| Say | Do not say |
| --- | --- |
| "AI documents, the clinician decides" | "AI diagnoses autism" |
| "Built for HIPAA and GDPR: consent, encryption, audit log, EU or India data residency" | "HIPAA compliant" |
| "Subscription per clinician" | "Fee per referral" (illegal kickback in DE and US) |
| "Synthetic role-play data" | Anything that suggests real patient data |
| "Germany after the MDR path is clear" | "Ready for German clinics today" |

**Risks and fallbacks**

| Risk | Fallback |
| --- | --- |
| Telugu quality in the agent is weak | Run the call in Hindi or English, show Telugu as roadmap |
| Browser voice call fails at the venue (mic permission, Wi-Fi) | Phone hotspot, ElevenLabs embed widget, or replay a recorded intake call with the cached webhook payload |
| Scribe or Gemini is slow during recording | Cached transcript and extraction JSON for the demo run |
| Gemini returns invalid JSON | Schema-constrained output, validate, one retry |
| Running out of time | Phase 3 becomes a static referral packet page, no chat |
| Merge conflict at a checkpoint | PR author merges `origin/main` locally, fixes, pushes (2 min); captain merges the others meanwhile |
| Someone pushes to `main` by mistake | GitHub branch protection requires an approved PR, including admins; the optional local hook is bypassable ([team workflow](docs/team-workflow.md)). |
| A laptop's Docker/Supabase breaks | `npx supabase stop --no-backup && npx supabase start && npm run db:migrate && npm run seed:demo`; worst case pair on a teammate's laptop |
| Google credits gone | Use the Gemini free tier key from AI Studio |

## 9. Submission checklist (team lead, before 16:45)

- [ ] Team locked in the portal (before 11:30)
- [ ] Pitch deck, max 5 slides, shared link opens without login
- [ ] GitHub repo public, README with setup, demo link (no login needed) and architecture
- [ ] Pitch + demo video, max 3 minutes, YouTube unlisted or Google Drive "anyone with the link" (no Loom, no Vimeo)
- [ ] Product link works in an incognito window
- [ ] Landing page live with sign-up form
- [ ] Customer learnings filled in (section 6)
- [ ] Team name, project name and short description entered
- [ ] Every link clicked once more right before submitting (a broken link counts against us)
