# 049: Telugu and Hindi for the new voice agents

**Status:** done (approved 2026-11-13: "fix the user journey so that I get a rating of at least 9")
**Mode:** solo
**Runs:** waits for 048 and 051: same voice components and screen agent

## Summary

UI languages stay **en / hi / te** (product owner 2026-11-13: no Urdu). The original Child Development intake
agent already speaks en/hi/te. The newer agents only speak English:
- screen (033)
- booking (034)
- generic intake (035)
- follow-up (040)

Telugu is the first language of about 75% of Telangana. This ticket makes those four agents follow the
page language, using the same pattern as the Child Development agent.

## Functional requirements

- **FR-1** – Each of the four agents starts in the viewer's UI locale (`en`/`hi`/`te`), and the same
  agent can serve all three languages. Use the pattern documented in `docs/elevenlabs-agent.md` (language
  override, localized first message, `{{language}}` variable). Server code passes the locale when it asks
  for a conversation token.
- **FR-2** – Prompts and first messages are written for each language in `lib/agents/<agent>/prompts/`.
  Safety messages (108/112, "not a diagnosis") are fixed, reviewed translations, identical to the page text
  in `messages/{hi,te}.json`.
- **FR-3** – Tool calls (search, slots, hold, record answers) stay language-neutral: values are codes, not
  translated words. Answers spoken in Telugu or Hindi map to the same answer codes.
- **FR-4** – Fallback: if a language isn't enabled on the agent (env `ELEVENLABS_<AGENT>_LANGUAGES`, e.g.
  `en,hi,te`), the page says "Voice is available in English. You can also answer by tapping in
  Telugu." It offers both options; the voice call never silently falls back to English.
- **FR-5** – Update `docs/elevenlabs-*-agent.md`: replace the "English only / do not add languages" steps
  with the steps to enable Hindi and Telugu, and add a language review checklist (human task).
- **FR-6** – Regression evals: for each agent, one scripted Telugu and one Hindi conversation in
  `DEMO_MODE` fixtures produce the same tool calls as the English script.

## Non-functional requirements

- **NFR-1** – No extra processors; same ElevenLabs agents, same consent text (it already names
  ElevenLabs).
- **NFR-2** – Native speakers review the translations before the real pilot (human task, tracked in docs).

## Affected areas

- `lib/agents/**`, `lib/elevenlabs/**`, the screen, booking, intake and follow-up components
- `docs/elevenlabs-*.md`, `messages/{en,hi,te}.json`, `tests/agents-*-locale.test.ts`

## Out of scope

- Urdu (decided against).
- Code-mixed "Tenglish"/"Hinglish" tuning beyond what the model does by default.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Languages | en / hi / te | Product owner 2026-11-13 (no Urdu) |
| D-2 | One agent or one per language | One agent per purpose, language from the locale | Fewer agents to configure |
