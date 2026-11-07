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
| 1. Intake call | After booking, the AI voice agent calls the parent in Telugu, Hindi or English (max 15 min). Opens with consent and "I am an AI assistant". | Pre-session brief: summary, red flags (lost speech, self-injury), questions to verify. Every answer marked "parent-reported". | Therapist reviews the brief before session 1 |
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

**MUST (working end to end by 13:30)**

- Phase 2 core: upload role-play session audio, ElevenLabs Scribe v2 transcript with speakers, Gemini fills the 40 ISAA items (rating, evidence quote, timestamp, confidence), therapist taps confirm or edit, total score and band shown.

**SHOULD (by 15:30)**

- Phase 1: real outbound call from the ElevenLabs agent to a teammate's phone. Fallback: ElevenLabs web voice widget.
- Phase 1: pre-session brief page built from the call.
- Phase 3: referral packet page and "ask the case" chat with cited answers.
- Landing page with "Join the pilot" sign-up form (needed for validation evidence).

**NICE TO HAVE**

- Parent summary as a voice note in Telugu (ElevenLabs TTS), sent by email via Resend from a Next.js API route.
- Therapist voice notes in live mode (mic, not upload).

**WON'T BUILD TODAY**

- Live video calling (use a pre-recorded role-play instead).
- Booking marketplace, payments, login and multi-tenant setup.
- Real patient data of any kind. Real HIPAA infrastructure.

## 3. Architecture and stack

| Layer | Tool | Notes |
| --- | --- | --- |
| App | Next.js (App Router) + Tailwind on Vercel | One app: therapist dashboard, specialist page, landing page |
| Data | Supabase (Postgres + Storage) | Fresh project created today. Audio files in Storage |
| Intake call | ElevenLabs Agents + Twilio outbound | Agent collects proforma answers via data collection fields, posts to our webhook after the call |
| Transcription | ElevenLabs Scribe v2 (batch, diarization on) | Speaker labels: parent, therapist |
| Parent summary | ElevenLabs TTS | Telugu or Hindi voice note |
| AI | Gemini API (Google credits) | Structured JSON output against our schema. Extraction, brief, report, ask-the-case |
| Workflows | Next.js API routes + webhooks | No separate workflow tool. Booking form calls our API, which starts the ElevenLabs outbound call. ElevenLabs post-call webhook triggers the brief. Refer button calls our API, which emails the specialist. Optional: Supabase Database Webhooks for DB-triggered steps |
| Email | Resend (free tier) | Specialist referral email and parent voice-note email |
| Build | Cursor, Wispr Flow | Dictate prompts and code |

### Flow

```
PHASE 1  Booking form -> POST /api/cases/:id/call -> ElevenLabs agent calls parent
         -> post-call webhook (transcript + collected fields)
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
  id, case_id, instrument: "ISAA" | "CASE_SHEET" | "FACP",
  item_id, value, 
  source: "parent_call" | "session" | "therapist_voice",
  evidence: { quote, start_sec, end_sec, recording_id },
  confidence: 0..1,
  status: "suggested" | "confirmed" | "edited",
  confirmed_by, created_at
}
```

Tables: `cases`, `recordings`, `facts`, `reports`, `referrals`. Maps later to FHIR (Patient, Encounter, QuestionnaireResponse, ServiceRequest).

### Contracts to agree at 11:30 (do not change after)

- `/schemas/isaa.json`: the 40 items, 6 domains, 1 to 5 scale. Single source of truth for prompt and UI.
- `POST /api/cases/:id/call` (start the ElevenLabs outbound intake call)
- `POST /api/webhooks/elevenlabs` (post-call data)
- `POST /api/sessions/:id/transcribe`
- `POST /api/sessions/:id/extract`
- `PATCH /api/facts/:id` (confirm or edit)
- `POST /api/cases/:id/refer`
- `POST /api/cases/:id/ask`

### Repo and Git rules

```
carethread/
  app/          Next.js pages + API routes
  lib/          elevenlabs.ts, gemini.ts, scoring.ts, db.ts, email.ts
  schemas/      isaa.json, case-sheet.json, facp.json
  prompts/      extract.md, brief.md, report.md, ask.md
  demo/         role-play audio, sample transcript, seed.sql
  README.md     setup, demo login, architecture
```

- Public GitHub repo created at kickoff. Commit every 30 to 45 minutes (judges look at history).
- One branch per person, small PRs, merge to main often. Main must always run.
- Secrets only in `.env.local`. Commit `.env.example`. Never commit API keys.

## 4. Roles

Write your name next to your role.

| Role | Owner | Owns | Done means |
| --- | --- | --- | --- |
| A. Voice | \_\_\_\_\_\_ | ElevenLabs agent (prompt, data collection fields, Telugu/Hindi/English), Twilio outbound call, Scribe v2 integration, TTS parent summary | Teammate's phone rings, call data lands in our DB |
| B. AI and backend | \_\_\_\_\_\_ | ISAA schema, Gemini prompts (extract, brief, report, ask), API routes, Supabase, scoring logic | Role-play audio in, 40 items with evidence out, valid JSON every time |
| C. Frontend | \_\_\_\_\_\_ | Therapist dashboard (brief, live form with evidence, report), specialist page, landing page with sign-up form | A judge can click through the full flow without help |
| D. Founder and pitch | \_\_\_\_\_\_ | Customer calls, role-play recording, deck, video, README, submission, timekeeping | 5 slides, 3-minute video, all links tested |

D also calls out the checkpoints and has the final say on cutting scope.

## 5. Timeline

| Time | What | Who |
| --- | --- | --- |
| 10:55 to 11:30 | Claim credits now: Google AI (only until 13:00, max 70 people), ElevenLabs perk via Discord, Cursor. Create repo, Supabase and a Resend API key. Agree schema and API contracts. Lock team in the portal before 11:30. | All |
| 11:00 | Send validation messages (section 6) | D |
| 11:30 to 12:30 | A: agent + first test call. B: ISAA schema + extraction prompt on a sample transcript. C: dashboard skeleton on mock JSON. D: write and record the role-play audio (below), first calls. | All |
| 12:30 to 13:00 | Lunch, keep tests running | All |
| **13:30** | **Checkpoint 1: Phase 2 works end to end on the role-play audio.** If not, everyone helps until it does. | All |
| 13:30 to 15:30 | Phase 1 call to brief, Phase 3 referral + ask, landing page live | A, B, C |
| 15:00 | Validation cut-off: quotes collected, sign-ups counted | D |
| **15:30** | **Feature freeze. Bug fixes only.** | All |
| 15:30 to 16:30 | Deck, record demo screen capture, then pitch, edit video, README with demo login | D + C |
| **16:30** | **Checkpoint 2: video on YouTube (unlisted), all links tested in an incognito window** | D |
| 16:45 | Team lead submits in the portal | Lead |
| 17:00 | Hard deadline, no late submissions |  |

### Role-play script for the demo audio (D records at 12:00)

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
| 0:45 to 1:15 | Phase 1: book, phone rings, 15 seconds of the AI call in Telugu, brief appears |
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
| Twilio outbound call fails | ElevenLabs web voice widget in the browser |
| Scribe or Gemini is slow during recording | Cached transcript and extraction JSON for the demo run |
| Gemini returns invalid JSON | Schema-constrained output, validate, one retry |
| Running out of time | Phase 3 becomes a static referral packet page, no chat |
| Google credits gone | Use the Gemini free tier key from AI Studio |

## 9. Submission checklist (team lead, before 16:45)

- [ ] Team locked in the portal (before 11:30)
- [ ] Pitch deck, max 5 slides, shared link opens without login
- [ ] GitHub repo public, README with setup, demo login and architecture
- [ ] Pitch + demo video, max 3 minutes, YouTube unlisted or Google Drive "anyone with the link" (no Loom, no Vimeo)
- [ ] Product link works in an incognito window
- [ ] Landing page live with sign-up form
- [ ] Customer learnings filled in (section 6)
- [ ] Team name, project name and short description entered
- [ ] Every link clicked once more right before submitting (a broken link counts against us)
