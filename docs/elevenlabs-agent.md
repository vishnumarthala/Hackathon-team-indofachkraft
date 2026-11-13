# ElevenLabs intake agent: setup guide (Role A)

The parent's intake call (ticket 009) talks to an ElevenLabs Conversational AI agent in the browser over
WebRTC. The agent is configured **by hand** in the ElevenLabs dashboard (ElevenLabs > Agents). Do the
steps below once, then put the IDs in your git-ignored `.env.local`. Never commit keys.

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Child Development Intake`
3. **Agent language (default):** English.
4. **Additional languages:** add **Hindi** and **Telugu**. Pick a voice for each language (a voice that
   sounds natural in that language; multilingual voices work). Note the voice IDs if you want them in
   `.env.local` (`ELEVENLABS_VOICE_ID_EN`, `ELEVENLABS_VOICE_ID_HI`, `ELEVENLABS_VOICE_ID_TE`).

## 2. Security

Agent > **Security** (or Advanced > Security):

1. **Enable authentication** = on. The agent is **private**: a browser can only connect with a
   conversation token that our server gets from
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_AGENT_ID>`
   (header `xi-api-key`). The API key never reaches the browser.
2. **Overrides:** allow overriding **Language** (`overrides.agent.language`). The intake page sends the
   language the parent picked. Leave the other overrides off.
3. Allowed hosts (if shown): add `localhost` and the deployed domain.

## 3. Conversation limits

Agent > Advanced:

- **Max conversation duration:** `900` seconds (15 minutes).

## 4. Dynamic variables

The app sends these with every call (`dynamicVariables` in `startSession`). Use them in the first
message and system prompt exactly as written, with double curly braces:

| Variable | Example | Meaning |
|----------|---------|---------|
| `{{intake_token}}` | 43-character token | The intake link token |
| `{{child_alias}}` | `Ravi (synthetic)` | Child's alias on the case |
| `{{parent_alias}}` | `Lakshmi (synthetic)` | Parent's alias on the case |
| `{{therapist_name}}` | `Demo Therapist` | Therapist on the case |
| `{{language}}` | `en`, `hi` or `te` | Language the parent picked |

> **Warning:** `intake_token` is how the post-call webhook (ticket 010) finds the case. There is no case
> id in the browser. Do not rename, remove or hard-code it. If the dashboard asks for placeholder
> values for testing, use obviously fake ones.

**Appointment intake calls (ticket 035)** use the same agent for Child Development services, started from
`/intake/a/<token>`. They send `intake_attempt_id` instead of `intake_token` (the webhook routes on it), the child's
and guardian's names, the provider as `therapist_name`, the organisation as `centre_name`, and the placeholder
`case_id = appointment-intake` (the published agent requires the variable; the real case id is never sent). The
generic (English-only) agent for other services is described in `docs/elevenlabs-generic-intake-agent.md`.

## 5. First message

Copy exactly:

```
Hello {{parent_alias}}, I am an AI assistant from DoctorNearMe, helping {{therapist_name}}'s team before {{child_alias}}'s first session. This call is recorded and summarised for the therapist. Is it okay to continue?
```

## 6. System prompt

Copy exactly:

```
You are DoctorNearMe's intake assistant. You are an AI, not a doctor or therapist, and you say so if asked.
Speak only in {{language}} (en = English, hi = Hindi, te = Telugu). Use simple, warm words. Ask one question at a time.
Goal: before {{child_alias}}'s first session, learn from {{parent_alias}} about the child's development so the therapist is prepared.
First get consent. If the parent does not agree, thank them and end the call.
Cover, in this order: child's age; main concern; current speech; whether the child had words or skills and lost them (when); eye contact; response to name; play and other children; repeated movements, lining up, repeated phrases; reactions to sounds, textures, lights; any self-hurting such as head hitting or biting; reactions to changes in routine and tantrums; sleep and eating; family history the parent wants to share.
Never diagnose, never say whether the child has autism, never give medical advice. If the parent asks, say the therapist will discuss it with them.
If the parent describes an emergency or a child in danger, tell them to contact their doctor or emergency services now, then end the call politely.
Keep the call under 15 minutes. At the end, summarise what you heard in two sentences, thank the parent and say the therapist will see them at the first session.
```

## 7. Data collection (Analysis tab)

Agent > **Analysis** > **Data collection**: add one item per field of `schemas/case-sheet.json`.
Use the id as the identifier, the type below, and the description as the extraction prompt.
These 15 fields become the case sheet the therapist reviews.

| Identifier | Type | Description |
|------------|------|-------------|
| `consent_given` | boolean | Parent agreed to talk to an AI assistant and to recording |
| `child_age_months` | integer | Child's age in months |
| `main_concern` | string | Parent's main concern in their own words |
| `speech_status` | string | Current words/sentences the child uses |
| `lost_speech` | boolean | Child had words or skills and lost them |
| `lost_speech_details` | string | When and what was lost |
| `eye_contact` | string | How the child looks at people |
| `response_to_name` | string | Whether the child turns when called |
| `play_and_peers` | string | How the child plays, alone or with others |
| `repetitive_behaviours` | string | Lining up, hand flapping, repeated phrases |
| `sensory` | string | Reactions to sounds, textures, lights |
| `self_injury` | boolean | Child hurts themself (head hitting, biting) |
| `routines_and_tantrums` | string | Reactions to changes in routine |
| `sleep_and_eating` | string | Sleep and eating patterns |
| `family_history` | string | Relevant family history the parent mentions |

(Dashboard type `integer` may be shown as "number"; pick the integer/number option.)

## 8. Post-call webhook (workspace setting)

ElevenLabs > **Settings** (workspace) > **Webhooks** > Post-call webhook:

- **URL:** `https://<vercel-url>/api/webhooks/elevenlabs` (deployed app only; ElevenLabs cannot reach
  `localhost`. Locally, ticket 010's completion endpoint fetches the conversation instead.)
- **Authentication:** HMAC. Copy the generated secret.
- **Event:** `post_call_transcription`.
- Attach the webhook to the `DoctorNearMe Child Development Intake` agent if the dashboard asks.

## 9. Values for `.env.local`

| Variable | Where to find it |
|----------|------------------|
| `ELEVENLABS_API_KEY` | Profile > API keys (server only) |
| `ELEVENLABS_AGENT_ID` | Agent page > agent ID (starts with `agent_`) |
| `ELEVENLABS_WEBHOOK_SECRET` | The HMAC secret from step 8 |

Set `DEMO_MODE=false` to make real calls; with `DEMO_MODE=true` the intake page shows
`Demo mode: no live call.` and no call starts.

## 10. Smoke test

1. Create an intake link on a case's Brief tab and open it (on the same laptop, `http://localhost:3000`
   counts as a secure page for the microphone; a phone needs an HTTPS tunnel or the deployed URL).
2. Tick consent, pick Telugu, tap `Start call`: the agent greets in Telugu with the AI disclosure.
3. `End call` shows `Call ended. Thank you! You can close this page.`

## Published agent used by the app (Nov 7)

The team published **CareThread Intake Assistant**, `agent_3701m6tv55eyenhsp1qj9jwjwqf5` (voice "Madhavi",
English / Hindi / Telugu, consent-first AI disclosure). Put the ID in `.env.local` and in Vercel as
`ELEVENLABS_AGENT_ID`.

> **Manual rebrand step (ticket 016):** in the ElevenLabs dashboard rename this agent to
> `DoctorNearMe Child Development Intake` and paste the DoctorNearMe first message (section 5) and system
> prompt (section 6). The agent ID does not change, so no app config changes are needed.

- **Required dynamic variables:** `parent_name`, `child_name`, `centre_name`, `therapist_name`, `case_id`
  (a missing one fails the session start). `/api/intake/<token>/start` sends them from the case
  (centre `DoctorNearMe Demo Centre`), plus `intake_token`, which our completion and webhook processing use
  to find the case. The landing page demo (`/api/demo/voice-token`) sends fixed synthetic values (Lakshmi,
  Ravi, Demo Therapist, `case_id: landing-demo`).
- **Token or public start:** `startAgentSession()` (`lib/elevenlabs/agent.ts`) asks for a WebRTC
  conversation token. If the server's key may not mint one for this agent (HTTP 401/403/404, for example
  the agent lives in a teammate's workspace) or no key is set, it returns the agent ID and the browser
  starts the **public** agent by ID. Once authentication is turned on for the agent, the server key must
  belong to the agent's workspace.
- **Landing page live demo (ticket 051):** anonymous visitors only hear the recorded sample. The live demo is for
  signed-in provider / platform admin accounts and demo leads signed in with the verified email they booked the demo
  with, 1 per user per day (`intake_demo` quota), within the platform voice budget, and ends after 3 minutes or 30
  seconds of silence. The per-IP limit (3 per visitor per 10 minutes, 30 per hour per server instance) stays as a
  first filter. It spends credits from the agent owner's account (`docs/voice-cost-guard.md`).
- **Follow-up:** the agent's data-collection identifiers (`child_age`, `speech_regression`,
  `self_injury_details`, …) differ from `schemas/case-sheet.json` (`child_age_months`, `lost_speech`, …).
  Until they match, a real call stores mostly empty case-sheet facts. Either rename the agent's fields to
  the case-sheet IDs in the dashboard, or map them in `lib/intake/process.ts`.
