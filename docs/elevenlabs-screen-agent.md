# ElevenLabs agent for the public developmental check-in (ticket 033)

The public `/screen` page lets a parent answer the ISAA-derived parent check-in (024, `ISAA_PARENT_CHECKIN`) by
voice. It talks to its own ElevenLabs Conversational AI agent (English, Hindi and Telugu since 049; see "Hindi and
Telugu" below), separate from the Child-Dev intake
agent (`docs/elevenlabs-agent.md`, which stays en/hi/te and must not be changed for this). The agent is configured
**by hand** in the ElevenLabs dashboard (ElevenLabs > Agents). Do the steps below once, then put the agent id in
`ELEVENLABS_SCREEN_AGENT_ID` (git-ignored `.env.local` / Vercel env). Never commit keys.

Without `ELEVENLABS_SCREEN_AGENT_ID` (or with `DEMO_MODE=true`) the page still works: the tap-through form asks the
same questions, and `DEMO_MODE` answers `{ demo: true }` without contacting ElevenLabs.

**Ticket 048 (children up to 8).** The page offers `under-18m` (milestone guidance, no call), `18-30m`, `31-71m`
(2½-5 years), `6-8y` and `9y+` ("this check-in is for children up to 8", no call). Only the three middle bands start
a check-in, so the agent only ever hears those (as words, see `{{age_band}}` below). With `MCHAT_LICENSED=true`
the 18-30 month list is the M-CHAT-R/F (items `mchat_1` ... `mchat_20`, answered **yes or no**) instead of the
ISAA-derived items; the prompt below already covers both, so no dashboard change is needed when the flag flips. The
parent's "What worries you most?" choices are **not** sent to the agent (the page uses them for the recommendation).
049 added Hindi and Telugu with the item ids, the tools and the safety rules unchanged.

## Rules this agent must follow (summary)

- **No personal data.** Never ask for the child's or parent's name, date of birth, phone number, address or school.
  If the parent volunteers any of it, do not repeat it and do not store it (there is no tool that accepts it).
- **Red-flag questions first.** The `{{questions}}` list starts with the 6 safety questions; ask them in order
  before the 15 development questions.
- **Fixed safety message.** On any red flag: call `record_red_flag`, say the safety message below word for word,
  then end the call. No further questions, no result, no booking.
- **Never say whether the child has autism**, never diagnose, never give medical advice. The result is a
  developmental check-in, not a diagnosis; the page shows it.
- English, Hindi or Telugu (the page language, when enabled; 049). Max 6 minutes (ticket 051; was 8).

Fixed safety message (identical to the page, `lib/screen/questions.ts` `URGENT_MESSAGE`; Hindi and Telugu: `screen.urgent`
in `messages/{hi,te}.json`):

```
Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.
```

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Developmental Check-in`
3. **Agent language (default):** English. **Additional languages:** Hindi and Telugu, configured as language presets
   (section "Hindi and Telugu (ticket 049)" below).
4. **Voice:** a calm, clear English voice (Indian English if available). **LLM:** any current low-latency model;
   temperature low (0.2-0.3) so the questions are read as written.

## 2. Security (private agent)

Agent > **Security**:

1. **Enable authentication** = on. The browser connects only with a conversation token that our server gets from
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_SCREEN_AGENT_ID>` (header
   `xi-api-key`, `lib/elevenlabs/agent.ts` `startAgentSession(agentId)`). The API key never reaches the browser.
2. **Overrides:** **Language** on (049; the page sends it for Hindi and Telugu only); prompt, first message and voice
   overrides **off**.
3. **Allowed hosts** (if shown): the deployed domain and `localhost`.

## 3. Limits and privacy

Agent > **Advanced**:

- **Max conversation duration:** `360` seconds (6 minutes, ticket 051 FR-6; was 8). The page also ends the call at 6
  minutes. These are the seconds reserved against the parent's voice quota and the platform budget
  (`docs/voice-cost-guard.md`).
- **Silence end call timeout:** `30` seconds (ticket 051 FR-6). The page also ends the call after 30 seconds without
  speech from the parent and continues by tapping ("We ended the call because it went quiet.").
- **Conversation retention / privacy:** choose the **shortest retention the plan allows** (zero-retention mode if
  available, otherwise the minimum number of days), and turn **off** "store call audio" / audio saving. DoctorNearMe
  stores no audio (`/screen` disclosure: "Your voice is processed by ElevenLabs (USA) and is not stored by
  DoctorNearMe"). Record the chosen value in `docs/privacy/processors.md` when you set it.
- **Post-call webhook:** **none** for this agent (do not attach the intake webhook; nothing from this call is
  processed after it ends).
- **Analysis > Data collection:** **none**. Do not add data-collection items or evaluation criteria: the answers
  reach us only through the client tools below, as `never/sometimes/often/always` or `yes/no` per item id. Data
  collection would make ElevenLabs extract free text from the call, which the check-in must not keep.

## 4. Dynamic variables

The server sends these with every call (`POST /api/screen/sessions` with `mode: "voice"`). Use them exactly as
written, with double curly braces. If the dashboard asks for test values, use obviously fake ones.

| Variable | Example | Meaning |
|----------|---------|---------|
| `{{screen_session_id}}` | `3f1c...` (uuid) | Anonymous check-in session (not linked to any person) |
| `{{age_band}}` | `18 to 30 months`, `2 and a half to 5 years`, `6 to 8 years` | Age band the parent picked, in words in the call language (048/049; `SPOKEN_AGE_BAND[language]` in `lib/screen/questions.ts`, e.g. `రెండున్నర నుండి 5 సంవత్సరాల`) |
| `{{language}}` | `en`, `hi` or `te` | Call language (049); the Hindi/Telugu prompts use it |
| `{{questions}}` | numbered list (below) | The questions to ask, red flags first, each with its item id and answer scale |

`{{questions}}` looks like this (`lib/screen/questions.ts` `agentQuestionList`):

```
1. [rf_skill_regression] (red flag, yes/no) Has your child stopped using words or skills that they used to have?
2. [rf_self_injury] (red flag, yes/no) Does your child hurt themselves on purpose, ...
...
7. [q1] (never/sometimes/often/always) Does your child look at your face or eyes when you talk or play together?
...
21. [q15] (never/sometimes/often/always) Does your child turn to look at you when you call their name?
```

With `MCHAT_LICENSED=true` and `18 to 30 months`, items 7-26 look like `7. [mchat_1] (yes/no) ...` (20 M-CHAT-R/F
items, licensed wording only).

## 5. First message

English (base configuration). Copy exactly:

```
Hello, I am DoctorNearMe's AI assistant. I will ask you about 20 short questions about your child, aged {{age_band}}. This is a developmental check-in, not a diagnosis. Please do not tell me your child's name or any contact details. Shall we start?
```

## 6. System prompt

English (base configuration). Copy exactly:

```
You are DoctorNearMe's developmental check-in assistant. You are an AI, not a doctor or therapist, and you say so if asked. You speak English only. Use simple, warm, short sentences. Ask one question at a time.

Purpose: a parent answers a short, ISAA-derived developmental check-in about their child (age band {{age_band}}). This is a developmental check-in, not a diagnosis.

Privacy rules (always):
- Never ask for the child's or the parent's name, date of birth, phone number, address, school or any other identifying detail.
- If the parent says any of these, do not repeat them, do not write them anywhere, and continue with the next question.

Questions: ask exactly these, in this order, reading each question as written. The red-flag (safety) questions come first.
{{questions}}

After each answer:
- For a development question, map the parent's words to one of the answers in round brackets after its item id: never, sometimes, often or always, or yes or no for the yes/no questions. If unclear, ask one short follow-up ("Would you say never, sometimes, often or always?" or "Would you say yes or no?"). Then call record_answer with the item id in square brackets and the answer.
- For a red-flag question, map the answer to yes or no. If no, call record_answer with the item id and "no". If yes, or if the parent describes an emergency, self-harm, a seizure, breathing trouble, not eating or drinking, or a child in danger at ANY point, call record_red_flag with the matching code (skill_regression, self_injury, seizure, breathing, not_eating_drinking or safety_concern), then say exactly: "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today." and end the call. Do not ask any more questions after a red flag.
- Follow the instruction in each tool result (for example "Ask the next one" or "end the call").

Never say whether the child has autism or any condition, never diagnose, never give medical advice, never interpret the answers. If asked, say the result appears on the screen and only a qualified professional can assess the child.

When every question is answered (the tool result says so), thank the parent, say the result and nearby specialists are now on their screen, and end the call. Keep the call under 6 minutes.
```

## 7. Tools

### Client tools (run in the parent's browser)

Agent > **Tools** > Add tool > **Client tool**. For both: **Wait for response = on** (the tool result tells the agent
what to do next). The page implements them in `lib/screen/client.ts` (`screenClientTools`) and posts to
`/api/screen/sessions/:id/answers` and `/api/screen/sessions/:id/red-flag`.

**`record_answer`**

- Description: `Save the parent's answer to one check-in question. Call once per question.`
- Parameters:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `item_id` | string | yes | The item id in square brackets in the question list, e.g. `q3` or `rf_seizure`. |
| `answer` | string | yes | `never`, `sometimes`, `often` or `always` for development questions; `yes` or `no` for red-flag questions and the M-CHAT-R/F (`mchat_*`) questions. |

**`record_red_flag`**

- Description: `A safety concern: stops the check-in. Call immediately when a red-flag question is answered yes or the parent describes an emergency.`
- Parameters:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string (enum) | yes | One of `skill_regression`, `self_injury`, `seizure`, `breathing`, `not_eating_drinking`, `safety_concern`. |

The page shows the 108/112 message the moment `record_red_flag` (or a `yes` to a red-flag item) arrives, without
waiting for the agent; an unknown code is stored as `safety_concern`.

### System tools

- **End call:** on (the agent ends the call after the safety message or the closing line). The page also ends the
  call 20 seconds after a red flag or the last answer if the agent has not.
- Everything else (transfer, language detection, skip turn) off.

No server (webhook) tools: the check-in sends nothing from ElevenLabs to our server.

## 8. Values for the environment

| Variable | Where to find it |
|----------|------------------|
| `ELEVENLABS_SCREEN_AGENT_ID` | Agent page > agent id (starts with `agent_`) |
| `ELEVENLABS_API_KEY` | Already set for the intake agent (server only); it must be allowed to mint tokens for this agent |

`DEMO_MODE=false` is needed for real calls. The CSP for `/screen` already allows the ElevenLabs API and WebRTC
(LiveKit) endpoints (`lib/csp.ts`); nothing else is loaded from third parties.

## 9. Manual smoke test (human, once the agent exists)

1. `/screen` on a phone (375 px), pick `2½-5 years`, optionally a worry, tick the box, `Start voice check-in`, allow
   the microphone. The agent says "aged 2 and a half to 5 years".
2. The agent greets you, asks the 6 safety questions first, then the development questions. Answer in your own
   words; the page shows "N of 21 questions answered".
3. Say your (synthetic) child's name: the agent does not repeat it.
4. Answer everything with no red flags: the call ends, the page shows the band, the domains, the "not a diagnosis"
   line, who can help first (048), up to 3 bookable providers with free times and the free government options.
5. Start again and answer `yes` to "Has your child stopped using words or skills...": the page shows only the
   108/112 message at once; the agent says the same message and ends the call.
6. In the ElevenLabs conversation list, check the retention setting and that no audio is stored.

## Hindi and Telugu (ticket 049)

One agent serves English, Hindi and Telugu. The page asks for the viewer's UI language; the server checks that it is
enabled on this agent (`ELEVENLABS_SCREEN_LANGUAGES`) and the browser starts the call with the language override (Hindi/Telugu only;
English uses the base configuration above). The Hindi and Telugu first message and system prompt are the agent's
**language presets**, generated from `lib/agents/screen/prompts/` (instructions in English; every Hindi/Telugu
word, including the safety message, comes from `messages/{hi,te}.json`, identical to the page and listed in
`messages/REVIEW.md`). Tool calls stay language-neutral: codes and English place names, never translated words.

Until the steps below are done, keep `ELEVENLABS_SCREEN_LANGUAGES` empty (English only). On a page in a language that is not enabled
`/screen` shows "Voice is available in English. You can also answer by tapping in Telugu." with `Voice in English` and `Tap in Telugu` (the tap-through form, chrome in Telugu); the call never falls back to English by itself (`409 language_unavailable` from
the start route). DEMO_MODE enables all three: the page runs a scripted voice check-in in the call language (agent lines from the catalogue, the questions in English with a note, reply buttons with the Telugu/Hindi answer words mapped to the same `record_answer` codes).

### Steps (human, in the ElevenLabs dashboard)

1. Agent > **Languages** (Additional languages): add **Hindi** and **Telugu**. Pick a voice per language that sounds
   natural in it (a multilingual voice works); note the voice ids.
2. Fill both language presets (first message + system prompt per language) from the code, either:
   - print them and paste into each language's settings:
     `npm run -s agents:presets -- screen --md`, or
   - apply them through the API (no secrets in the file; the key stays in your shell):
     `npm run -s agents:presets -- screen --voice-hi=<voice id> --voice-te=<voice id> > presets.json` then
     `curl -X PATCH "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" -d @presets.json`
     (only `conversation_config.language_presets` changes; check the result in the dashboard, then delete the file).
3. Agent > **Security** > **Overrides**: turn on **Language** (`overrides.agent.language`) only. Prompt, first message
   and voice overrides stay off.
4. Run the smoke test below, then set `ELEVENLABS_SCREEN_LANGUAGES=en,hi,te` in Vercel (and `.env.local`) and redeploy. To switch a
   language off again, remove it from the list: the page then offers the English/tap choice.

### Smoke test in Telugu and Hindi (human)

1. Switch the page to `తెలుగు`, open `/screen`, pick `2½-5 years`, tick the box, `Start voice check-in`
   (the page says the assistant speaks Telugu). The agent greets in Telugu and says the age as "రెండున్నర నుండి 5
   సంవత్సరాల".
2. Answer a few questions in Telugu ("కొన్నిసార్లు", "ఎప్పుడూ లేదు", "తరచుగా"): the page counts them as answered.
3. Answer "అవును" to the first safety question: the page shows only the Telugu 108/112 message; the agent says the
   same sentence in Telugu and ends the call.
4. Repeat 1-3 in हिन्दी.
5. Remove `te` from `ELEVENLABS_SCREEN_LANGUAGES`, reload in Telugu: the page offers `Voice in English` or `Tap in
   Telugu` and never starts an English call by itself.

### Language review checklist (human, native speakers, before the real pilot; NFR-2)

- [ ] First message (`voiceAgents.screen.firstMessage`) and the safety message (`screen.urgent`) in
      messages/REVIEW.md: natural, polite, and the 108/112 sentence identical to the page.
- [ ] Listen to one full call per language in a quiet room and one on a phone in a noisy room: the voice sounds natural
      in that language (change the preset's voice if not), the AI disclosure and "not a diagnosis"/no-advice rules hold,
      and the agent never switches to English unless the parent does.
- [ ] Each of the 21 check-in questions (6 safety + 15) as the agent asks it in Telugu and in Hindi: same meaning as
      the English item, no added examples, no softened wording (the agent translates at call time until clinically
      reviewed question translations exist; record any problem item id).
- [ ] Spoken answers in everyday Telugu/Hindi map to the right code (never / sometimes / often / always, yes / no):
      the words in `voiceAgents.lexicon.answers` and any common words that are missing.
- [ ] The age band as spoken (`voiceAgents.screen.ageBands`).
- [ ] Set the reviewed rows to `approved` in messages/REVIEW.md (reviewer name), or `changes-requested` with notes.
      Rerun `npx tsx scripts/i18n-review.ts` after any catalogue change and re-apply the presets (step 2).
