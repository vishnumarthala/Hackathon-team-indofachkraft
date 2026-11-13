# ElevenLabs generic pre-consult intake agent: setup guide (ticket 035)

Appointments for services whose intake kind is `generic` (default for physiotherapists and paediatricians; providers
can change it per service on `/dashboard/schedule`) send the family an appointment-bound link
`<APP_URL>/intake/a/<token>`. The page starts a browser voice call (WebRTC) with this **English-only** agent. Child
Development services keep the existing en/hi/te agent (`docs/elevenlabs-agent.md`).

The agent is configured **by hand** in the ElevenLabs dashboard. Nobody on the team had a key when 035 was built:
until the agent exists, generic links only work with `DEMO_MODE=true` (the page shows `Demo mode: no live call.` and
`Simulate completed call (demo)` replays `demo/fixtures/elevenlabs-generic-post-call.json`).

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Pre-consult Intake (English)`
3. **Agent language:** English. **No additional languages** (decision record: new agents are English only).
4. **Voice:** a clear Indian-English voice.

## 2. Security

1. **Enable authentication** = on (private agent). The server mints a WebRTC conversation token with
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_GENERIC_INTAKE_AGENT_ID>`
   (header `xi-api-key`). The key must belong to the agent's workspace.
2. **Overrides:** leave **all** overrides off. The page never sends a language override for this agent.
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
| `{{language}}` | `en` | Always `en` |

There is **no case id and no link token** in the call (FR-4). If the dashboard asks for test values, use obviously
fake ones.

## 5. First message (AI disclosure)

```
Hello {{parent_name}}, I am an AI assistant from DoctorNearMe, not a doctor. I help {{provider_name}} prepare for {{child_name}}'s visit. This call is recorded and summarised for {{provider_name}}. It takes about five minutes. Is it okay to continue?
```

## 6. System prompt

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
   <APP_URL>/intake/a/<token>`. Open it: no language select, English intro.
3. Tick consent, `Start call`: the agent greets with the AI disclosure. Say "she has trouble breathing": it gives the
   108/112 message and ends the call.
4. A normal call: after `End call` the page saves the call; the provider's agenda shows `Intake: completed` and
   `Open brief` shows the pre-consult brief in the case.
