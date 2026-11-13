# ElevenLabs generic pre-consult intake agent: setup guide (ticket 035)

Appointments for services whose intake kind is `generic` (default for physiotherapists and paediatricians; providers
can change it per service on `/dashboard/schedule`) send the family an appointment-bound link
`<APP_URL>/intake/a/<token>`. The page starts a browser voice call (WebRTC) with this agent (English, Hindi and Telugu since 049). Child
Development services keep the existing en/hi/te agent (`docs/elevenlabs-agent.md`).

The agent is configured **by hand** in the ElevenLabs dashboard. Nobody on the team had a key when 035 was built:
until the agent exists, generic links only work with `DEMO_MODE=true` (the page shows `Demo mode: no live call.` and
`Simulate completed call (demo)` replays `demo/fixtures/elevenlabs-generic-post-call.json`).

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Pre-consult Intake` (an agent created as `... (English)` keeps working; renaming is optional)
3. **Agent language (default):** English. **Additional languages:** Hindi and Telugu, configured as language presets
   (section "Hindi and Telugu (ticket 049)" below).
4. **Voice:** a clear Indian-English voice (Hindi/Telugu voices per language preset).

## 2. Security

1. **Enable authentication** = on (private agent). The server mints a WebRTC conversation token with
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_GENERIC_INTAKE_AGENT_ID>`
   (header `xi-api-key`). The key must belong to the agent's workspace.
2. **Overrides:** **Language** on (049; the page sends it for Hindi and Telugu only); all other overrides off.
3. Allowed hosts (if shown): `localhost` and the deployed domain.

## 3. Conversation limits

Agent > Advanced > **Max conversation duration:** `600` seconds (10 minutes).

## 4. Dynamic variables

`POST /api/intake/a/<token>/start` sends these (`app/api/intake/a/[token]/start/route.ts`):

| Variable | Example | Meaning |
|----------|---------|---------|
| `{{intake_attempt_id}}` | uuid | The appointment intake attempt. **The webhook uses it to find the appointment.** Never rename or hard-code it. |
| `{{child_name}}` | `Anaya (synthetic)` | Child's name as the guardian entered it |
| `{{parent_name}}` | `Lakshmi (synthetic)` or `Parent` | Guardian's display name |
| `{{provider_name}}` | `Dr Rao (synthetic)` | Provider of the appointment |
| `{{service_name}}` | `Knee physiotherapy` | Booked service |
| `{{centre_name}}` | `Synthetic Physio Clinic` | Organisation |
| `{{language}}` | `en`, `hi` or `te` | Call language: the page language when enabled (049); the Hindi/Telugu prompts use it |

There is **no case id and no link token** in the call (FR-4). If the dashboard asks for test values, use obviously
fake ones.

## 5. First message (AI disclosure)

English (base configuration):

```
Hello {{parent_name}}, I am an AI assistant from DoctorNearMe, not a doctor. I help {{provider_name}} prepare for {{child_name}}'s visit. This call is recorded and summarised for {{provider_name}}. It takes about five minutes. Is it okay to continue?
```

## 6. System prompt

English (base configuration):

```
You are DoctorNearMe's pre-consult intake assistant. You are an AI, not a doctor or therapist, and you say so if asked.
Speak only English. Use simple, warm words. Ask one question at a time.
Goal: before {{child_name}}'s visit with {{provider_name}} ({{service_name}}), learn from {{parent_name}} why they booked, so the provider is prepared.
First get consent. If the parent does not agree, thank them and end the call.
Cover, in this order: the main reason for the visit; when it started and how it changed; earlier treatment or tests and relevant past illnesses or operations; what worries the parent most now; medicines, supplements or home remedies the child takes now (with dose if known); allergies and the reaction; questions the parent wants to ask the provider.
Never diagnose, never name or rule out a condition, never say how serious something is, never give medical advice, doses or treatment. If the parent asks, say {{provider_name}} will discuss it at the visit.
Red flags: if the parent describes an emergency or an urgent warning sign - for example difficulty breathing, blue lips, a seizure, the child not waking up or unresponsive, severe bleeding, a serious injury, poisoning, or a child in danger - stop the intake and say: "This sounds urgent. Please call 108 for an ambulance now, or 112 for emergency help. Do not wait for your appointment." Then end the call politely.
Keep the call under 10 minutes. At the end, summarise what you heard in two sentences, thank the parent and say {{provider_name}} will see them at the visit.
```

## 7. Data collection (Analysis tab)

Agent > **Analysis** > **Data collection**: one item per field of `schemas/generic-intake.json` (`fields`). Use the id
as the identifier, the type below and the description as the extraction prompt. They feed the brief prompt; they are
not stored as facts.

| Identifier | Type | Description |
|------------|------|-------------|
| `consent_given` | boolean | The parent agreed to talk to an AI assistant and to the call being recorded and summarised for the provider |
| `reason_for_visit` | string | Why the parent booked this visit, in their own words |
| `history` | string | When the problem started, how it changed, earlier treatment, relevant past illnesses or operations |
| `current_concerns` | string | What worries the parent most right now |
| `current_medications` | string | Medicines, supplements or remedies the child takes now, with dose if known |
| `allergies` | string | Known allergies and the reaction, or that there are none |
| `questions_for_provider` | string | Questions the parent wants to ask at the visit |
| `red_flag_reported` | boolean | The parent described an emergency or urgent warning sign (the agent then advised calling 108 or 112) |

## 8. Post-call webhook

Use the workspace's existing post-call webhook (`https://<app>/api/webhooks/elevenlabs`, HMAC, event
`post_call_transcription`, same `ELEVENLABS_WEBHOOK_SECRET` as the Child Development agent) and attach it to this
agent too. The route sends calls with `intake_attempt_id` to the appointment processor
(`lib/intake/appointment-process.ts`), which checks that the call came from **this** agent id, that the attempt is
still valid (not cancelled; started before the appointment start, delivered within 2 hours) and that
`ai_intake_call` consent still holds, then stores one `intake_call` recording with the appointment and one
`generic_intake_brief` report (Gemini, `prompts/generic-intake.md`; medicines and allergies are compared with the
child's health profile by the server). Replays answer `{ received: true, duplicate: true }`. Locally (no webhook), the
page's completion call (`POST /api/intake/a/<token>/complete`) fetches the conversation instead.

## 9. Values for `.env.local` / Vercel

| Variable | Where to find it |
|----------|------------------|
| `ELEVENLABS_GENERIC_INTAKE_AGENT_ID` | Agent page > agent ID (starts with `agent_`) |
| `ELEVENLABS_API_KEY` | Same key as the other agents (server only) |
| `INTAKE_LINK_SECRET` | Any long random string (e.g. `openssl rand -base64 48`). Optional: falls back to the service role key. Changing it invalidates every open appointment intake link. |

## 10. Smoke test

1. Create a `generic` service (or a physiotherapist's default) on `/dashboard/schedule`, book it as a guardian whose
   child allows the AI intake call, run `npm run -s outbox:run -- --once`.
2. The confirmation (in-app / email) says `Before your visit, please take a short voice call with our AI assistant:
   <APP_URL>/intake/a/<token>`. Open it: no language select; the intro and the call follow the page language (049).
3. Tick consent, `Start call`: the agent greets with the AI disclosure. Say "she has trouble breathing": it gives the
   108/112 message and ends the call.
4. A normal call: after `End call` the page saves the call; the provider's agenda shows `Intake: completed` and
   `Open brief` shows the pre-consult brief in the case.

## Hindi and Telugu (ticket 049)

One agent serves English, Hindi and Telugu. The page asks for the viewer's UI language; the server checks that it is
enabled on this agent (`ELEVENLABS_GENERIC_INTAKE_LANGUAGES`) and the browser starts the call with the language override (Hindi/Telugu only;
English uses the base configuration above). The Hindi and Telugu first message and system prompt are the agent's
**language presets**, generated from `lib/agents/generic-intake/prompts/` (instructions in English; every Hindi/Telugu
word, including the safety message, comes from `messages/{hi,te}.json`, identical to the page and listed in
`messages/REVIEW.md`). Tool calls stay language-neutral: codes and English place names, never translated words.

Until the steps below are done, keep `ELEVENLABS_GENERIC_INTAKE_LANGUAGES` empty (English only). On a page in a language that is not enabled
`/intake/a/<token>` (generic services) shows "Voice is available in English. You can also skip the call: <provider> will ask you at the visit." with `Voice in English` and `Skip the call` (there is no tap-through intake); the call never falls back to English by itself (`409 language_unavailable` from
the start route). DEMO_MODE enables all three: `Simulate completed call (demo)` replays the call in the call language (`demo/fixtures/elevenlabs-generic-post-call.{hi,te}.json`, same data-collection results as English).

### Steps (human, in the ElevenLabs dashboard)

1. Agent > **Languages** (Additional languages): add **Hindi** and **Telugu**. Pick a voice per language that sounds
   natural in it (a multilingual voice works); note the voice ids.
2. Fill both language presets (first message + system prompt per language) from the code, either:
   - print them and paste into each language's settings:
     `npm run -s agents:presets -- generic_intake --md`, or
   - apply them through the API (no secrets in the file; the key stays in your shell):
     `npm run -s agents:presets -- generic_intake --voice-hi=<voice id> --voice-te=<voice id> > presets.json` then
     `curl -X PATCH "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" -d @presets.json`
     (only `conversation_config.language_presets` changes; check the result in the dashboard, then delete the file).
3. Agent > **Security** > **Overrides**: turn on **Language** (`overrides.agent.language`) only. Prompt, first message
   and voice overrides stay off.
4. Run the smoke test below, then set `ELEVENLABS_GENERIC_INTAKE_LANGUAGES=en,hi,te` in Vercel (and `.env.local`) and redeploy. To switch a
   language off again, remove it from the list: the page then offers the English/tap choice.

### Smoke test in Telugu and Hindi (human)

1. Open a generic intake link with the page in `తెలుగు`: no language select; the page says the assistant speaks
   Telugu. Tick consent, `Start call`: the AI disclosure is in Telugu.
2. Answer in Telugu (reason, medicines with doses, allergies). After the call the provider's brief is in English, the
   medicine names and doses are as said, and red-flag quotes stay word for word in Telugu.
3. Say "పాపకి ఊపిరి ఆడటం లేదు": the agent says the Telugu urgent message (108/112) and ends the call.
4. Repeat in हिन्दी.
5. Remove `te` from `ELEVENLABS_GENERIC_INTAKE_LANGUAGES`: the page offers `Voice in English` or `Skip the call`.

### Language review checklist (human, native speakers, before the real pilot; NFR-2)

- [ ] First message (`voiceAgents.genericIntake.firstMessage`) and the safety message (`voiceAgents.genericIntake.safetyMessage`) in
      messages/REVIEW.md: natural, polite, and the 108/112 sentence identical to the page.
- [ ] Listen to one full call per language in a quiet room and one on a phone in a noisy room: the voice sounds natural
      in that language (change the preset's voice if not), the AI disclosure and "not a diagnosis"/no-advice rules hold,
      and the agent never switches to English unless the parent does.
- [ ] The brief written from a Telugu/Hindi call (English, parent-reported, quotes word for word) is correct for a
      few synthetic calls; `prompts/generic-intake.md` covers this.
- [ ] Set the reviewed rows to `approved` in messages/REVIEW.md (reviewer name), or `changes-requested` with notes.
      Rerun `npx tsx scripts/i18n-review.ts` after any catalogue change and re-apply the presets (step 2).
