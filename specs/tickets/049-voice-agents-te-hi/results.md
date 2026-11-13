# 049: Telugu and Hindi for the new voice agents - Results

Branch: `ticket/049-voice-agents-te-hi`. Tested against the local Supabase stack of slot 2 (`supabase_db_dnmslot2`, all
migrations re-applied by the helper's `reset`, including `20261113004900_voice_agent_language.sql`), `DEMO_MODE=true`,
dev server on port 3020 with `ELEVENLABS_BOOKING_LANGUAGES=en`, headless Chromium (playwright-core) at 375 px for the
acceptance checks. ElevenLabs is mocked at the client boundary in tests (`startAgentSession`, `@elevenlabs/react`);
no real keys exist. Synthetic accounts and data only; test accounts are removed afterwards.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (DB suites running) | PASS | 104 files, 1766 passed, 11 skipped (the same pre-existing opt-in suites as the base: 1699 passed / 11 skipped before). One earlier full run had `privacy-export-deletion` fail once on an outbox event delivered by a parallel suite; it passes alone (2/2) and in the next full run (untouched by this ticket) |
| `npm run build` | PASS | exit 0 |
| `npx vitest run tests/agents-*-locale.test.ts --reporter=verbose` | PASS | 4 files, 67 tests (screen 24, booking 13, intake 15, follow-up 15) |
| The token request carries the locale (FR-1) | PASS | screen/booking/follow-up/intake clients send `language` (UI locale, or `en` after "Voice in English"); routes call `startAgentSession(agentId, { language })` (mock asserted `{ language: "te" }`) and return `language` + `dynamic_variables.language`; the browser sends `overrides.agent.language` for `hi`/`te` only |
| First message and safety text match `messages/{hi,te}.json` exactly (FR-2) | PASS | per agent and language: `firstMessage === toAgentTemplate(voiceAgents.<agent>.firstMessage)`, `safetyMessage === screen.urgent` (generic intake: `voiceAgents.genericIntake.safetyMessage`), the prompt contains `say exactly: "<safety>"`; the screen greeting contains `screen.result.notDiagnosis` of that language; English prompts/first messages equal the dashboard text in `docs/elevenlabs-*-agent.md` |
| A disabled language shows the FR-4 choice and never starts an English call silently | PASS | routes (DB): `ELEVENLABS_{SCREEN,BOOKING,FOLLOWUP,GENERIC_INTAKE}_LANGUAGES=en` + `te` -> `409 { error: "language_unavailable", details: { language: "te", enabled: ["en"] } }`, ElevenLabs mock not called, no `voice_usage` reservation, no follow-up session row; unset outside DEMO_MODE = English only; `en` (explicit "Voice in English") starts. Rendered pages (te): screen and booking show "Voice is available in English. You can also answer by tapping in Telugu." with `Voice in English` / `Tap in Telugu`, intake `Voice in English` / `Skip the call`, follow-up `Voice in English` / `Type instead`; no plain voice start button |
| te/hi scripted fixtures produce the same tool calls as English (FR-3, FR-6) | PASS | screen: `demo/fixtures/voice-agents/screen.json` (21 answers, red-flag answer, spoken red flag) -> identical `record_answer`/`record_red_flag` calls and identical HTTP requests through `screenClientTools`; booking: the DEMO_MODE script in te/hi -> identical `search_providers` (`Banjara Hills`, `speech_language_pathologist`, `in_clinic`), `get_slots` (`morning`), `hold_slot` (+ `demo_acknowledged`) calls; follow-up: `demo/fixtures/voice-agents/followup.json` -> identical English `answer_question` questions (medicine rule and 108/112 still trigger); generic intake (no tools): `elevenlabs-generic-post-call.{hi,te}.json` -> identical data-collection identifiers and values |
| Follow-up answers in the call language | PASS | DB: a `te` session stores `language = 'te'`; through the routes the medicine, not-found and 108/112 answers come back word for word from `te.json` (`translate: false`), the session ends after the red flag (401), history stays English; English sessions get exactly the 040 body; model answers -> `translate: true`, `answer_language: "en"` (unit) |
| E-1: Telugu screen call (FR-1, FR-2) | PASS | browser, UI `తెలుగు`, signed-in synthetic provider, `/screen`, `2½-5 years`, voice: note "సహాయకుడు మాట్లాడే భాష: తెలుగు.", `POST /api/screen/sessions` with `language: "te"` -> 201 `language: "te"`; the DEMO_MODE voice check-in shows the Telugu first message with "రెండున్నర నుండి 5 సంవత్సరాల"; answering "అవును" to the first safety question -> the agent line is `te.screen.urgent`, then the page shows only the Telugu 108/112 message; `red_flag_codes = {skill_regression}` (screenshots `e1-te-*-375.png` in the session files `w049/`) |
| E-2: Fallback (FR-4) | PASS | browser, `ELEVENLABS_BOOKING_LANGUAGES=en`, UI Telugu, `/find`: the widget shows "వాయిస్ ఇంగ్లీష్‌లో అందుబాటులో ఉంది. మీరు తెలుగులో ట్యాప్ చేసి కూడా సమాధానం ఇవ్వవచ్చు." with exactly two buttons `ఇంగ్లీష్‌లో వాయిస్` / `తెలుగులో ట్యాప్ చేయండి` (no `Book by voice`); tap -> focus on the search (`#find-q`); Voice in English -> "సహాయకుడు మాట్లాడే భాష: ఇంగ్లీష్.", start with `language: "en"` -> 201, English demo conversation; a direct Telugu start -> 409 `language_unavailable` |
| Mobile 375 px, accessible labels | PASS | screenshots at 375 px; fallback buttons are real buttons with text labels; captions/transcripts carry `lang` (`te-IN`, `hi-IN`, `en-IN`) of the call language, English question text `lang="en"` |

## Deviations

- **No real ElevenLabs agents or keys.** The Hindi/Telugu language presets, the Language override and the voices must
  be configured by a human in the dashboard (steps per agent in `docs/elevenlabs-*-agent.md` > "Hindi and Telugu
  (ticket 049)", overview `docs/voice-languages.md`). `npm run -s agents:presets -- <agent>` prints the exact presets
  (JSON for `PATCH /v1/convai/agents/<id>` or Markdown to paste); nothing is sent by the app. Until a human sets
  `ELEVENLABS_<AGENT>_LANGUAGES`, real calls are English only and Telugu/Hindi pages get the FR-4 choice; DEMO_MODE
  enables all three.
- **"Token request carries the locale":** ElevenLabs' conversation-token endpoint takes no language, so the locale
  travels in our start request (`language`), in `startAgentSession(agentId, { language })` and the response, and in
  the call's `overrides.agent.language` + `{{language}}` variable. The per-language first message and prompt live in
  the agent's language presets (configured server-side), not in client overrides: enabling prompt/first-message
  overrides would let any browser rewrite the agents' safety rules.
- **Check-in questions stay English text.** The ISAA-derived items have no clinically reviewed translations (018
  D-4), so the Hindi/Telugu agent asks each question in the call language at call time ("keeping its meaning
  exactly"); the tap form still shows English questions; the DEMO_MODE voice check-in shows the English question with
  "In a live call the assistant asks this question in Telugu." Clinical/native review of the spoken questions is in the
  screen agent's review checklist.
- **Follow-up:** the answer pipeline stays English (red-flag classifier, medicine/condition rules and citation checks
  are English-only), so the agent sends the question in English. Fixed answers come back translated word for word;
  model answers come back in English with `translate: true` for the agent to translate faithfully (not word for word).
  The text chat and the stored history stay English (out of scope).
- **Generic intake fallback:** there is no tap-through intake, so FR-4's second option there is `Skip the call`
  ("<provider> will ask you at the visit"); follow-up's is `Type instead` (the text chat, English).
- **English calls send no language override** (only `hi`/`te`), so English keeps working on agents whose Language
  override is not switched on yet. `{{language}}` is sent to all four agents; only the hi/te presets use it.
- **DEMO_MODE screen voice** is now a scripted voice check-in (first message, questions, reply buttons with the call
  language's answer words, same client tools) instead of going straight to the tap form; `Continue by tapping` keeps
  the answers.

## Notes

- New helpers: `lib/agents/languages.ts` (pure: `parseVoiceLanguages`, `planVoiceLanguage`, `voiceOverrides`,
  `toAgentTemplate`, `SPEECH_LANG`, `LANGUAGE_UNAVAILABLE`), `lib/agents/call-language.ts` (server:
  `enabledVoiceLanguages`, `resolveCallLanguage`, `agentTexts`, `urgentMessage`), `lib/agents/lexicon.ts` (spoken-word
  matching), `lib/agents/<agent>/prompts/{en,hi,te}.ts` + `lib/agents/prompts-all.ts`,
  `components/voice/VoiceLanguageChoice.tsx`, `components/screen/DemoVoiceCheckin.tsx`,
  `lib/agents/followup/localize.ts`, `scripts/elevenlabs-language-presets.ts` (`npm run -s agents:presets`).
- New env names (no values): `ELEVENLABS_SCREEN_LANGUAGES`, `ELEVENLABS_BOOKING_LANGUAGES`,
  `ELEVENLABS_GENERIC_INTAKE_LANGUAGES`, `ELEVENLABS_FOLLOWUP_LANGUAGES` (`.env.example`, `lib/env.ts`).
- Schema: `followup_agent_sessions.language text not null default 'en'` (check en/hi/te), migration
  `20261113004900_voice_agent_language.sql` (expand only; existing rows are English).
- `SPOKEN_AGE_BAND` (048) is now `Record<Locale, Record<QuestionAgeBand, string>>`; `startScreen()` takes the call
  language as a 5th argument; `runDemoScript()` (034) takes an optional `script`; `demoAppointmentPostCall()` and the
  simulate route take a `language`.
- Copy: `voiceAgents.*` added to `messages/{en,hi,te}.json` (first messages, demo lines, fixed answers, fallback copy,
  lexicon); "English only" removed from `screen.aiDisclosure`, `voiceBooking.disclosure`, `followup.voice.intro`,
  `intake.appointment.introGeneric`, `intake.appointments.generic` (the call language is shown next to the voice
  button). `messages/REVIEW.md` regenerated: every new/changed hi/te row is `pending` for native review (NFR-2).
- NFR-1: no new processor; the same agents and consent texts.
- `prompts/generic-intake.md`: one rule for Hindi/Telugu calls (brief in English, quotes word for word).
