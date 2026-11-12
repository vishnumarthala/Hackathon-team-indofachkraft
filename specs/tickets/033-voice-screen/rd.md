# 033: Voice developmental check-in (public screen)

**Status:** draft
**Mode:** solo
**Runs:** waits for 020, 024, 029, 041: saving a result to a child needs consent (020); results point to nearby providers (029); the ISAA-derived parent question set lives in the instrument registry (024); real child data needs the privacy/audit baseline (041)

## Summary

A public `/screen` page (linked from the landing page) where a parent talks to an English-only
ElevenLabs agent - or uses an equivalent tap-through form - answering short ISAA-derived questions about
their child. The result is a **developmental check-in, not a diagnosis**, with a clear next step and
nearby providers. Red flags stop the flow and direct the parent to 108/112 with no booking offered.
Before sign-in and consent the system collects **no identifiable child data** (rule 6).

## Functional requirements

- **FR-1** - Question set: `ISAA_PARENT_CHECKIN` (`schemas/isaa-parent-checkin.json`, defined in 024 -
  see Open questions), filtered by age band. Age bands chosen on the page: `18-36 months`, `3-5 years`,
  `6-9 years`, `10+ years`.
- **FR-2** - `/screen` (public, translated chrome): `<h1>Developmental check-in</h1>`; text `About 5
  minutes. This is a developmental check-in, not a diagnosis. Only a qualified professional can assess
  your child.`; AI disclosure `You will talk to an AI assistant. It speaks English. Your voice is
  processed by ElevenLabs (USA) and is not stored by DoctorNearMe.`; `Child's age` (bands), checkbox
  `I understand this is not a diagnosis and agree to talk to an AI assistant.`; buttons `Start voice
  check-in` and `Answer by tapping instead` (form in en/hi/te UI chrome, question text English until
  clinically reviewed translations exist).
- **FR-3** - Agent `DoctorNearMe Developmental Check-in` (English only), configured by hand from
  `docs/elevenlabs-screen-agent.md` (this ticket): private agent, max 8 minutes, dynamic variables
  `{{screen_session_id}}`, `{{age_band}}`, `{{questions}}` (numbered list); system prompt rules: never ask
  for the child's or parent's name, date of birth, phone, address or school; if volunteered, do not
  repeat them; ask each question and map the answer to `never/sometimes/often/always`; ask the red-flag
  questions first; on any red flag say the fixed safety message and end; never say whether the child
  has autism. Client tool `record_answer({ item_id, answer })` and `record_red_flag({ code })`.
- **FR-4** - APIs (public, rate-limited per IP: 5 sessions/hour, reuse `lib/voiceDemoLimit.ts` pattern):
  `POST /api/screen/sessions` `{ age_band, mode: "voice" | "form" }` -> 201 `{ session_id, questions,
  conversation_token? }` (token only for voice; DEMO_MODE -> `{ demo: true }`);
  `POST /api/screen/sessions/:id/answers` `{ answers: [{ item_id, answer }] }` -> 200;
  `POST /api/screen/sessions/:id/red-flag` `{ code }` -> 200 `{ stop: true }`;
  `POST /api/screen/sessions/:id/finish` -> 200 `{ result_band, domains: [{ domain, level }], red_flag,
  message }` computed server-side with 024 `score("ISAA_PARENT_CHECKIN", ...)`. Sessions expire after 2 h.
- **FR-5** - Storage: `screen_sessions(id, created_at, expires_at, age_band, mode, answers jsonb,
  result_band, red_flag_codes text[], conversation_id null, saved_child_id null, saved_by null)` - no
  IP (only a rate-limit hash in memory), no names. Unsaved sessions deleted after 30 days (041 registry).
  ElevenLabs agent configured with the shortest available conversation retention (documented).
- **FR-6** - Result page: band headline (`No strong signs from this check-in` / `Some areas are worth
  discussing with a professional` / `Please see a professional soon`), per-domain plain text, the line
  `This is a developmental check-in, not a diagnosis.`, and `Find a specialist near you` -> embedded 029
  search (location prompt) prefiltered by suggested types (`developmental_pediatrician`,
  `child_psychologist`, `speech_language_pathologist`, `occupational_therapist`).
- **FR-7** - Red flag (any time, voice or form): stop immediately; show only `Please get help now. Call
  108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your
  child's doctor today.` - no result band, no provider list, no booking buttons; `red_flag_codes` stored.
- **FR-8** - Save: signed-in guardian can `Save this result to <child>` -> `POST
  /api/family/screen-results` `{ session_id, child_id }` -> requires 020 consent `screen_result_save`
  (422 otherwise, with an inline `Allow` dialog) and an active child link -> sets
  `saved_child_id`, `saved_by` and removes the 30-day expiry; the child page (020) lists it under
  `Check-ins` (date, age band, band headline). Guardians can share it with a provider later through the
  care team (not in this ticket).

## Non-functional requirements

- **NFR-1** - No third-party scripts on `/screen` other than the ElevenLabs SDK; no analytics.
- **NFR-2** - Copy rules: no "diagnose/diagnosis" except "not a diagnosis"; reviewed by a clinician (human task).
- **NFR-3** - Form mode fully usable without microphone; 375 px.

## Affected areas

- `supabase/migrations/<ts>_screen.sql` (new); `lib/screen/**` (new)
- `app/screen/**`, `app/api/screen/**`, `app/api/family/screen-results/route.ts` (new); landing CTA link
- `docs/elevenlabs-screen-agent.md` (new); `lib/elevenlabs/agent.ts` (agent id parameter, env `ELEVENLABS_SCREEN_AGENT_ID`)
- `lib/auth-access.ts`, `lib/privacy/registry.ts`, `.env.example`, `messages/*.json`
- `tests/screen-flow.test.ts`, `tests/screen-red-flags.test.ts` (new)

## Don't touch

- Child-Dev intake agent and its prompt (stays en/hi/te), scoring of ISAA, existing migrations, `BOARD.md`

## Out of scope

- Hindi/Telugu voice (risk 2), storing audio, M-CHAT or other licensed instruments, booking from the
  result page directly (link to directory only).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Instrument | ISAA-derived parent questions, "not a diagnosis" | plan §2 "Screening instrument"; risk 1 |
| D-2 | Language | Agent English only; form available | plan §2 "Voice languages"; risk 2 |
| D-3 | Safety | Red flag -> stop, 108/112, no booking | plan §2 "Safety" |
| D-4 | Pre-consent data | No identifiable child data before sign-in + consent | rule 6 |

## Open questions

- Dependency gap: the question set and scorer come from 024, which is not upstream of 033 in the plan
  (033 <- 020, 029). Run after 024 or move `ISAA_PARENT_CHECKIN` here.
- Clinical sign-off of questions, bands and the safety message before public launch.
