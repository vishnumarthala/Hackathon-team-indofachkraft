# Voice agents in Hindi and Telugu (ticket 049)

The screen (`/screen`), booking (`/find`), generic intake (`/intake/a/<token>`) and follow-up
(`/family/children/<id>/ask`) voice agents speak **English, Hindi and Telugu**, following the page language, with the
same pattern as the Child Development intake agent (`docs/elevenlabs-agent.md`): one agent per purpose, a per-call
language override, and a localized first message. Urdu is out of scope (product decision).

## How it works

| Piece | Where |
|-------|-------|
| Enabled languages per agent | `ELEVENLABS_SCREEN_LANGUAGES`, `ELEVENLABS_BOOKING_LANGUAGES`, `ELEVENLABS_GENERIC_INTAKE_LANGUAGES`, `ELEVENLABS_FOLLOWUP_LANGUAGES` (comma-separated, e.g. `en,hi,te`; English always). Unset: English only; `DEMO_MODE`: all three. `lib/agents/call-language.ts` `enabledVoiceLanguages()` |
| Call language of a start | The page sends `language` (its UI locale, or `en` after "Voice in English"); the route resolves it before the 051 gate: not enabled -> `409 { error: "language_unavailable", details: { language, enabled } }`, no ElevenLabs call, no quota used. `resolveCallLanguage()` |
| Token | `startAgentSession(agentId, { language })` (`lib/elevenlabs/agent.ts`); the response carries `language` and `dynamic_variables.language` |
| Browser | `startSession({ ..., overrides: { agent: { language } } })` for `hi` / `te` only (`voiceOverrides()`, `lib/agents/languages.ts`); English uses the agent's base configuration |
| Prompts and first messages | `lib/agents/{screen,booking,generic-intake,followup}/prompts/{en,hi,te}.ts`. English = the dashboard text in `docs/elevenlabs-*-agent.md` (tests keep them equal). Hindi/Telugu = language presets: English instructions + catalogue text |
| Words the agents say | `messages/{en,hi,te}.json`: `voiceAgents.*` (first messages, demo lines, follow-up fixed answers, fallback copy), `screen.urgent` (108/112, identical to the page). Native review rows in `messages/REVIEW.md` (all `pending`) |
| Answers in Telugu/Hindi | `voiceAgents.lexicon` (answer words, red flags, provider types, modes, parts of the day, choices, demo areas); written into the prompts; `lib/agents/lexicon.ts` matches them in DEMO_MODE and tests |
| Fallback (FR-4) | `components/voice/VoiceLanguageChoice.tsx`: "Voice is available in English. You can also answer by tapping in Telugu." + `Voice in English` / `Tap in Telugu` (screen, booking), `Skip the call` (generic intake), `Type instead` (follow-up) |
| DEMO_MODE | Screen: scripted voice check-in in the call language (`components/screen/DemoVoiceCheckin.tsx`); booking: the scripted conversation in the call language; follow-up: the demo panel maps Telugu/Hindi text to the English question; generic intake: the Hindi/Telugu demo call fixtures |

### What stays English

- Tool calls: item ids and answer codes (`never`...`yes`/`no`), red-flag codes, provider type/mode codes, English
  place names (`Banjara Hills`) or PIN codes. The follow-up tool's `question` is English (the agent translates it),
  so the shared red-flag classifier, the medicine and condition rules and the citation checks run unchanged.
- The check-in question list (`{{questions}}`): ISAA-derived items stay English until clinically reviewed
  translations exist (018 D-4); the Hindi/Telugu agent asks each question in the call language at call time, keeping
  its meaning. The tap-through form still shows English questions ("The questions are in English for now.").
- Follow-up model answers: checked in English, returned with `translate: true` for the agent to translate
  faithfully; fixed answers come back translated word for word (`translate: false`). The stored history is English.
- Generic intake briefs: written in English for the provider; red-flag quotes stay word for word in the call's
  language (`prompts/generic-intake.md`).

## Human steps (ElevenLabs dashboard, per agent)

Each agent's doc has the exact steps, a Telugu/Hindi smoke test and a language review checklist:

- `docs/elevenlabs-screen-agent.md` > "Hindi and Telugu (ticket 049)"
- `docs/elevenlabs-booking-agent.md` > "Hindi and Telugu (ticket 049)"
- `docs/elevenlabs-generic-intake-agent.md` > "Hindi and Telugu (ticket 049)"
- `docs/elevenlabs-followup-agent.md` > "Hindi and Telugu (ticket 049)"

In short, per agent: add Hindi and Telugu as additional languages (pick a natural voice each); fill both language
presets from `npm run -s agents:presets -- <agent> --md` (or PATCH them with the JSON the same script prints); turn on
the **Language** override only; run the smoke test; then set `ELEVENLABS_<AGENT>_LANGUAGES=en,hi,te` and redeploy.
After any change to `voiceAgents.*`, `screen.urgent` or the prompt templates, re-apply the presets.

## Native-speaker review (NFR-2, before the real pilot)

1. `messages/REVIEW.md`: every `voiceAgents.*` row, `screen.urgent`, `screen.aiDisclosure`, `voiceBooking.disclosure`,
   `followup.voice.intro`, `intake.appointment.introGeneric` and `intake.appointments.generic` are `pending`.
2. Per agent, the "Language review checklist" in its doc (listen to real calls in Telugu and Hindi, check the
   agent's spoken translations of the check-in questions and follow-up answers).
3. Clinical review of the check-in questions as asked in Telugu/Hindi (the agent translates at call time).
