# ElevenLabs follow-up agent: "ask about my child's plan" (ticket 040)

In the family portal (`/family/children/<id>/ask`) a guardian can ask about their child's **published** plan, home
program, shared session notes and reports, and signed prescriptions, by typing or by voice. `Ask by voice` talks to a
**new, English-only** ElevenLabs Conversational AI agent, `DoctorNearMe Follow-up`, separate from the intake, check-in
and booking agents (`docs/elevenlabs-agent.md`, `docs/elevenlabs-screen-agent.md`, `docs/elevenlabs-booking-agent.md`);
do not change those for this.

The agent has **no knowledge of its own** and never sees the child's documents. It sends the parent's question to one
**server tool**, `answer_question`, and speaks the returned `answer` word for word. The tool runs exactly the same
handler as the text chat (`lib/followup/answer.ts`): red flags first (108/112, no model), the daily limit, the
medicine and condition rules, the consent re-check, then Gemini grounded only on the guardian-authorised published
versions (`lib/followup/context.ts`, design rule 9) with citations.

The agent is configured **by hand** in the ElevenLabs dashboard. Do the steps below once, then set
`ELEVENLABS_FOLLOWUP_AGENT_ID` (and `ELEVENLABS_TOOL_SECRET`, shared with the booking agent) in the git-ignored
`.env.local` / Vercel env. Never commit keys or the secret.

Without both values (and outside `DEMO_MODE`) the page has no voice section: the text chat is the fallback and always
works. With `DEMO_MODE=true` the page shows a **Voice demo** panel instead: no call is made, the guardian types what
they would say, `POST /api/agents/followup/demo/answer_question` runs the same tool handler (authenticated by the
signed-in guardian, who must own the session) and the browser reads the answer aloud (Web Speech, no network).

## Rules this agent must follow (summary)

- **Answer only through the tool.** Every question about the child goes to `answer_question`; the agent says the
  `answer` field exactly as returned and nothing else about the child. It never answers from its own knowledge.
- **Red flags stop everything.** If the tool returns `"safety": "red_flag"` (or the parent describes an emergency),
  the agent says the safety message word for word and ends the call. Our server ends the session too (later tool calls
  get 401).
- **No medicine changes, no diagnosis.** The tool already answers these with fixed sentences
  (`Please don't change any medicine without talking to the prescriber.`); the agent must not add advice of its own.
- English only. Max 10 minutes (ticket 051; was 15). No names: the agent receives only the session token, never the child's or guardian's
  name.

Fixed safety message (identical to the check-in, `lib/screen/questions.ts` `URGENT_MESSAGE`):

```
Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.
```

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Follow-up`
3. **Agent language:** English. **Do not add additional languages** (D-3; Hindi/Telugu voice is out of scope).
4. **Voice:** a calm, clear English voice (Indian English if available). **LLM:** any current low-latency model with
   reliable tool calling; temperature low (0.1-0.2).

## 2. Security (private agent)

Agent > **Security**:

1. **Enable authentication** = on. The browser connects only with a conversation token our server gets from
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_FOLLOWUP_AGENT_ID>` (header
   `xi-api-key`; `lib/elevenlabs/agent.ts` `startAgentSession(agentId)`, called by `POST /api/agents/followup/session`).
   The API key never reaches the browser.
2. **Overrides:** all **off**.
3. **Allowed hosts** (if shown): the deployed domain and `localhost`.

## 3. Limits and privacy

Agent > **Advanced**:

- **Max conversation duration:** `600` seconds (10 minutes, ticket 051 FR-6; was 15). The page also ends the call
  then. The session token stays valid for 15 minutes. 600 seconds are reserved against the guardian's voice quota and
  the platform budget (`docs/voice-cost-guard.md`).
- **Silence end call timeout:** `30` seconds (ticket 051 FR-6). The page also ends the call after 30 seconds without
  speech from the guardian.
- **Conversation retention:** the shortest retention the plan allows (zero-retention if available), audio saving
  **off**. DoctorNearMe keeps the questions and answers for 90 days (`followup_questions`, the guardian's history) and
  the conversation id so erasure can delete the ElevenLabs copy (041). Record the chosen value in
  `docs/privacy/processors.md`.
- **Post-call webhook:** none. **Analysis > Data collection / evaluation criteria:** none.

## 4. Secret for the server tool

Use the same workspace secret `dnm_tool_secret` as the booking agent (`docs/elevenlabs-booking-agent.md` step 4); its
value is `ELEVENLABS_TOOL_SECRET`. The tool sends it as `X-Agent-Secret`; without it (or with a wrong value) our API
answers 401.

## 5. Dynamic variables

`POST /api/agents/followup/session` returns these; the page passes them when it starts the call.

| Variable | Example | Meaning |
|----------|---------|---------|
| `{{followup_session}}` | `q3V...` (43 characters) | Random token bound to this guardian and child. Valid for 15 minutes and 20 tool calls. Send it with every tool call; never read it out. |

## 6. First message

Copy exactly:

```
Hello, I am DoctorNearMe's follow-up assistant. I am an AI, not a doctor. I can answer questions about your child's shared plans, home program and prescriptions. What would you like to know?
```

## 7. System prompt

Copy exactly:

```
You are DoctorNearMe's follow-up assistant for parents. You are an AI, not a doctor, and you say so if asked. You speak English only. Use simple, warm, short sentences.

You know nothing about the child yourself. For EVERY question about the child, their plan, goals, home practice, session notes, reports, appointments or medicines, call the tool answer_question with followup_session = {{followup_session}} and question = the parent's question in their own words (English). Then say the "answer" field of the result exactly as written, word for word. Do not add, remove or change anything in it, and do not add advice of your own. If the result has citations, you may add: "This is from your child's <label>." using the first citation's label.

If the result has "safety": "red_flag", say the answer word for word and end the call. Do not answer anything after that.
If the tool fails or returns an error, say: "Sorry, I could not answer that. Please type your question on the screen or ask your provider using Messages." If the error says the session is invalid or expired, say that and end the call.

Safety rule (always, at any point, even before calling the tool): if the parent describes an emergency, a seizure, breathing trouble, a child who is unconscious or will not wake, an overdose, self-harm, a child in danger, or not eating or drinking, say exactly: "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today." and end the call.

Never give medical advice, never diagnose, never say whether a child has a condition, and never suggest changing, stopping or adding any medicine or dose. Never ask for or repeat names, phone numbers or addresses. Keep the call under 10 minutes.
```

## 8. Tools

### Server (webhook) tool

Agent > **Tools** > Add tool > **Webhook**:

- **Name:** `answer_question`. **Description:** `Answer a parent's question from their child's shared plans, home
  program, notes and signed prescriptions. Always use this for any question about the child.`
- **Method:** `POST`. **URL:** `https://<production domain>/api/agents/followup/tools/answer_question`.
- **Headers:** `X-Agent-Secret` = secret `dnm_tool_secret`. `Content-Type: application/json`.
- **Body parameters:**

| Name | Type | Value | Description |
|------|------|-------|-------------|
| `followup_session` | string | **Dynamic variable** `followup_session` (not filled by the LLM) | The session token. |
| `question` | string | LLM | The parent's question in their own words, in English, 3 to 500 characters. |

- **Response timeout:** 10 seconds (our p95 target is under 6 s, NFR-2).

Returns the same body as the text chat (`POST /api/family/children/:id/ask`):
`{ id?, found, answer, citations: [{ entity_type, entity_id, version, label, excerpt }], safety?: "red_flag" | "medical_advice" }`.

Errors: 401 wrong/missing `X-Agent-Secret`, or an unknown, expired, ended or revoked-guardian session; 400 invalid
question; 422 `ai_follow_up` consent withdrawn (the session ends); 429 after 20 tool calls in a session or 30
questions per guardian per day; 502 the model did not answer.

### Client tools

None.

### System tools

- **End call:** on. Everything else (transfer, language detection, skip turn) off.

## 9. Values for the environment

| Variable | Where to find it |
|----------|------------------|
| `ELEVENLABS_FOLLOWUP_AGENT_ID` | Agent page > agent id (starts with `agent_`) |
| `ELEVENLABS_TOOL_SECRET` | The value of `dnm_tool_secret` (shared with the booking agent) |
| `ELEVENLABS_API_KEY` | Already set (server only); it must be allowed to mint tokens for this agent |

`DEMO_MODE=false` is needed for real calls. The family CSP allows the ElevenLabs API and WebRTC endpoints on
`/family/children/*/ask` only (`lib/csp.ts` `FAMILY_CSP_EXCEPTIONS`, allowlist entry "ElevenLabs SDK (voice agent)" in
`lib/privacy/third-party-allowlist.ts`). The SDK is bundled, so no external script is loaded.

## 10. Manual smoke test (human, once the agent exists)

Use synthetic data only (`npm run -s seed:users`, a child with a published plan, home program and a signed
prescription, and `AI follow-up assistant` allowed in the child's permissions).

1. `/family/children/<id>/ask` on a phone (375 px) > `Ask by voice` > allow the microphone. Captions appear.
2. Say "What should we practise this week?": the agent calls `answer_question` and reads the answer; after the call the
   question appears under `Earlier questions` (`Asked by voice`) with a `Home program` citation chip that opens the
   published version.
3. Say "Can I double the syrup dose?": the agent says `Please don't change any medicine without talking to the
   prescriber.`
4. Say "My child is not breathing properly": the agent says the 108/112 message and ends the call; a new tool call with
   the same session gets 401.
5. Withdraw `AI follow-up assistant` in the child's permissions during a call: the next question gets the consent error
   and the session ends.
6. In the ElevenLabs conversation list, check the retention setting and that no audio is stored.
