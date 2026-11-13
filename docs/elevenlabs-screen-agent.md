# ElevenLabs agent for the public developmental check-in (ticket 033)

The public `/screen` page lets a parent answer the ISAA-derived parent check-in (024, `ISAA_PARENT_CHECKIN`) by
voice. It talks to a **new, English-only** ElevenLabs Conversational AI agent, separate from the Child-Dev intake
agent (`docs/elevenlabs-agent.md`, which stays en/hi/te and must not be changed for this). The agent is configured
**by hand** in the ElevenLabs dashboard (ElevenLabs > Agents). Do the steps below once, then put the agent id in
`ELEVENLABS_SCREEN_AGENT_ID` (git-ignored `.env.local` / Vercel env). Never commit keys.

Without `ELEVENLABS_SCREEN_AGENT_ID` (or with `DEMO_MODE=true`) the page still works: the tap-through form asks the
same questions, and `DEMO_MODE` answers `{ demo: true }` without contacting ElevenLabs.

## Rules this agent must follow (summary)

- **No personal data.** Never ask for the child's or parent's name, date of birth, phone number, address or school.
  If the parent volunteers any of it, do not repeat it and do not store it (there is no tool that accepts it).
- **Red-flag questions first.** The `{{questions}}` list starts with the 6 safety questions; ask them in order
  before the 15 development questions.
- **Fixed safety message.** On any red flag: call `record_red_flag`, say the safety message below word for word,
  then end the call. No further questions, no result, no booking.
- **Never say whether the child has autism**, never diagnose, never give medical advice. The result is a
  developmental check-in, not a diagnosis; the page shows it.
- English only. Max 8 minutes.

Fixed safety message (identical to the page, `lib/screen/questions.ts` `URGENT_MESSAGE`):

```
Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.
```

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Developmental Check-in`
3. **Agent language:** English. **Do not add additional languages** (product decision D-2; Hindi/Telugu voice is
   out of scope until clinically reviewed translations exist).
4. **Voice:** a calm, clear English voice (Indian English if available). **LLM:** any current low-latency model;
   temperature low (0.2-0.3) so the questions are read as written.

## 2. Security (private agent)

Agent > **Security**:

1. **Enable authentication** = on. The browser connects only with a conversation token that our server gets from
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_SCREEN_AGENT_ID>` (header
   `xi-api-key`, `lib/elevenlabs/agent.ts` `startAgentSession(agentId)`). The API key never reaches the browser.
2. **Overrides:** all **off** (no language, prompt, first message or voice overrides).
3. **Allowed hosts** (if shown): the deployed domain and `localhost`.

## 3. Limits and privacy

Agent > **Advanced**:

- **Max conversation duration:** `480` seconds (8 minutes). The page also ends the call at 8 minutes.
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
| `{{age_band}}` | `18-36m`, `3-5y`, `6-9y`, `10y+` | Age band the parent picked |
| `{{questions}}` | numbered list (below) | The questions to ask, red flags first, each with its item id |

`{{questions}}` looks like this (`lib/screen/questions.ts` `agentQuestionList`):

```
1. [rf_skill_regression] (red flag, yes/no) Has your child stopped using words or skills that they used to have?
2. [rf_self_injury] (red flag, yes/no) Does your child hurt themselves on purpose, ...
...
7. [q1] (never/sometimes/often/always) Does your child look at your face or eyes when you talk or play together?
...
21. [q15] (never/sometimes/often/always) Does your child turn to look at you when you call their name?
```

## 5. First message

Copy exactly:

```
Hello, I am DoctorNearMe's AI assistant. I will ask you about 20 short questions about your child, aged {{age_band}}. This is a developmental check-in, not a diagnosis. Please do not tell me your child's name or any contact details. Shall we start?
```

## 6. System prompt

Copy exactly:

```
You are DoctorNearMe's developmental check-in assistant. You are an AI, not a doctor or therapist, and you say so if asked. You speak English only. Use simple, warm, short sentences. Ask one question at a time.

Purpose: a parent answers a short, ISAA-derived developmental check-in about their child (age band {{age_band}}). This is a developmental check-in, not a diagnosis.

Privacy rules (always):
- Never ask for the child's or the parent's name, date of birth, phone number, address, school or any other identifying detail.
- If the parent says any of these, do not repeat them, do not write them anywhere, and continue with the next question.

Questions: ask exactly these, in this order, reading each question as written. The red-flag (safety) questions come first.
{{questions}}

After each answer:
- For a development question, map the parent's words to one of: never, sometimes, often, always. If unclear, ask one short follow-up ("Would you say never, sometimes, often or always?"). Then call record_answer with the item id in square brackets and the answer.
- For a red-flag question, map the answer to yes or no. If no, call record_answer with the item id and "no". If yes, or if the parent describes an emergency, self-harm, a seizure, breathing trouble, not eating or drinking, or a child in danger at ANY point, call record_red_flag with the matching code (skill_regression, self_injury, seizure, breathing, not_eating_drinking or safety_concern), then say exactly: "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today." and end the call. Do not ask any more questions after a red flag.
- Follow the instruction in each tool result (for example "Ask the next one" or "end the call").

Never say whether the child has autism or any condition, never diagnose, never give medical advice, never interpret the answers. If asked, say the result appears on the screen and only a qualified professional can assess the child.

When every question is answered (the tool result says so), thank the parent, say the result and nearby specialists are now on their screen, and end the call. Keep the call under 8 minutes.
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
| `answer` | string | yes | `never`, `sometimes`, `often` or `always` for development questions; `yes` or `no` for red-flag questions. |

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

1. `/screen` on a phone (375 px), pick `3-5 years`, tick the box, `Start voice check-in`, allow the microphone.
2. The agent greets you, asks the 6 safety questions first, then the development questions. Answer in your own
   words; the page shows "N of 21 questions answered".
3. Say your (synthetic) child's name: the agent does not repeat it.
4. Answer everything with no red flags: the call ends, the page shows the band, the domains, the "not a diagnosis"
   line and nearby specialists.
5. Start again and answer `yes` to "Has your child stopped using words or skills...": the page shows only the
   108/112 message at once; the agent says the same message and ends the call.
6. In the ElevenLabs conversation list, check the retention setting and that no audio is stored.
