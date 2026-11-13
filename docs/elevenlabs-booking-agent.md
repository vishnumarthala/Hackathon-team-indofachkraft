# ElevenLabs agent for voice booking on /find (ticket 034)

The `Book by voice` widget on `/find` lets a parent say what they need ("a Telugu-speaking speech therapist near
Kukatpally on Saturday morning"). It talks to a **new, English-only** ElevenLabs Conversational AI agent, separate from
the intake agent (`docs/elevenlabs-agent.md`) and the check-in agent (`docs/elevenlabs-screen-agent.md`); do not change
those for this. The agent calls three **server tools** on our API to search providers, read free times and place a
**10-minute hold**. It can never confirm a booking: the parent signs in and taps `Confirm` on screen (030 flow).

The agent is configured **by hand** in the ElevenLabs dashboard (ElevenLabs > Agents). Do the steps below once, then
set `ELEVENLABS_BOOKING_AGENT_ID` and `ELEVENLABS_TOOL_SECRET` (git-ignored `.env.local` / Vercel env). Never commit
keys or the secret.

Without both values (or with `DEMO_MODE=true`) `/find` still works: there is no widget without them, and `DEMO_MODE`
shows the widget with a scripted conversation that calls the same tool handlers without contacting ElevenLabs.

## Rules this agent must follow (summary)

- **No personal data.** Ask only for the area, the kind of specialist, the language, in-clinic or video, the preferred
  day/time and the child's **age band**. Never ask for the child's or the parent's name, date of birth, phone number,
  address or school. If the parent volunteers any of it, do not repeat it; no tool accepts it (the server rejects any
  payload key outside the tool schema with 400).
- **Red flags stop everything.** If the parent describes an emergency, self-harm, a seizure, breathing trouble, a child
  not eating or drinking, or a child in danger: call `record_red_flag`, say the safety message below word for word,
  and end the call. No search, no hold.
- **Hold, never confirm.** `hold_slot` only holds a time for 10 minutes. Always explain that the parent must sign in
  and confirm on screen. There is no confirm tool. For `online` services the parent then pays on the next screen (031);
  the agent mentions the fee and never takes payment details.
- English only. Max 6 minutes. Never give medical advice or recommend one provider over another beyond the facts the
  tools return (distance, mode, language).

Fixed safety message (identical to the check-in, `lib/screen/questions.ts` `URGENT_MESSAGE`):

```
Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.
```

## 1. Create the agent

1. Agents > **Create agent** > Blank agent.
2. **Name:** `DoctorNearMe Booking Assistant`
3. **Agent language:** English. **Do not add additional languages** (D-3; Hindi/Telugu voice is out of scope).
4. **Voice:** a calm, clear English voice (Indian English if available). **LLM:** any current low-latency model with
   reliable tool calling; temperature low (0.2-0.3).

## 2. Security (private agent)

Agent > **Security**:

1. **Enable authentication** = on. The browser connects only with a conversation token that our server gets from
   `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_BOOKING_AGENT_ID>` (header
   `xi-api-key`, `lib/elevenlabs/agent.ts` `startAgentSession(agentId)`, called by `POST /api/agents/booking/session`).
   The API key never reaches the browser.
2. **Overrides:** all **off**.
3. **Allowed hosts** (if shown): the deployed domain and `localhost`.

## 3. Limits and privacy

Agent > **Advanced**:

- **Max conversation duration:** `360` seconds (6 minutes). The widget also ends the call at 6 minutes.
- **Conversation retention:** the shortest retention the plan allows (zero-retention mode if available), audio saving
  **off**. DoctorNearMe stores no audio, no transcript and no tool payloads (the widget says "Your voice is processed by
  ElevenLabs (USA) and is not stored by DoctorNearMe"). Record the chosen value in `docs/privacy/processors.md`.
- **Post-call webhook:** none. **Analysis > Data collection / evaluation criteria:** none.

## 4. Secret for the server tools

Workspace > **Secrets** (or the tool's header editor) > add a secret named `dnm_tool_secret` with a long random value
(for example `openssl rand -base64 48`). Put the **same value** in `ELEVENLABS_TOOL_SECRET`. Every tool sends it as the
`X-Agent-Secret` header; without it (or with a wrong value) our API answers 401. Rotate it by changing both places.

## 5. Dynamic variables

`POST /api/agents/booking/session` sends these with every call. Use them exactly as written.

| Variable | Example | Meaning |
|----------|---------|---------|
| `{{booking_session}}` | `q3V...` (43 characters) | Random per-conversation token. Valid for 30 minutes and 20 tool calls. Send it with every tool call; never read it out. |
| `{{today}}` | `Friday 2026-11-13` | Today's weekday and date in India, to turn "Saturday morning" into `date_from`. |

## 6. First message

Copy exactly:

```
Hello, I am DoctorNearMe's booking assistant. I am an AI. I can find a provider near you and hold a time for 10 minutes; you then sign in and confirm on your screen. Please do not tell me your child's name or any contact details. Which area are you in, and what kind of specialist do you need?
```

## 7. System prompt

Copy exactly:

```
You are DoctorNearMe's booking assistant for families in Hyderabad. You are an AI, not a doctor, and you say so if asked. You speak English only. Use simple, warm, short sentences. Ask one question at a time. Today is {{today}}.

Your job: find a provider (therapist, doctor or centre) near the parent and hold one appointment time for 10 minutes. You can never confirm a booking.

Ask only for:
- the area or PIN code in Hyderabad,
- the kind of specialist (for example speech therapist, occupational therapist, child psychologist, developmental pediatrician),
- a preferred language of the provider (optional),
- in-clinic or video,
- the preferred day and part of the day (morning, afternoon or evening),
- the child's age band (under 3, 3 to 5, 6 to 9, or 10 and over) - only to help the parent choose; do not send it to any tool.

Privacy rules (always):
- Never ask for the child's or the parent's name, date of birth, phone number, address, school or any other identifying detail.
- If the parent says any of these, do not repeat them and do not put them in any tool call.

Safety rule (always, at any point): if the parent describes an emergency, self-harm, a seizure, breathing trouble, a child not eating or drinking, or a child in danger, call record_red_flag, then say exactly: "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today." and end the call. Do not search or hold anything after that.

Tools (always pass booking_session = {{booking_session}}):
1. search_providers with locality_text (the area or PIN code as the parent said it), and type, language and mode when known. Read out at most 3 names with their distance. Ask which one.
2. get_slots with the chosen profile_id, service_mode (in_clinic or video), date_from (YYYY-MM-DD, worked out from today) and part_of_day if the parent said one. Read out at most 3 times using local_time and mention the fee (fee_inr rupees; online = paid online after confirming, at_clinic = paid at the clinic, free = no fee). Ask which one. Never ask for card, UPI or bank details.
3. hold_slot with profile_id, service_id and start copied exactly from the chosen get_slots result.
Follow the message in each tool result. If a tool says the time was taken, read the free times again and offer another.

After a successful hold, say: the time is held for 10 minutes and is not booked yet; to finish, tap "Sign in and confirm" on your screen, sign in, choose your child and confirm. Then say goodbye and end the call. Never say the appointment is booked or confirmed.

Never give medical advice, never diagnose, never say whether a child has a condition. If asked which provider is best, give only the facts the tools returned (distance, in-clinic or video, languages). Keep the call under 6 minutes.
```

## 8. Tools

### Server (webhook) tools

Agent > **Tools** > Add tool > **Webhook**. For all three:

- **Method:** `POST`. **URL:** `https://<production domain>/api/agents/booking/tools/<tool name>`.
- **Headers:** `X-Agent-Secret` = secret `dnm_tool_secret` (step 4). `Content-Type: application/json`.
- **Body parameter `booking_session`:** type string, value type **Dynamic variable** = `booking_session` (not filled by
  the LLM).
- **Response timeout:** 10 seconds (our p95 is far below 1.5 s, NFR-1).
- Add **only** the body parameters listed below: any other key is rejected with 400.

**`search_providers`** - `Find bookable providers near a place in Hyderabad.`

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `locality_text` | string | yes | The area, locality or 6-digit PIN code the parent said, e.g. `Kukatpally` or `500072`. Nothing else. |
| `type` | string | no | One of `speech_language_pathologist`, `occupational_therapist`, `child_psychologist`, `child_psychiatrist`, `developmental_pediatrician`, `pediatrician`, `aba_therapist`, `special_educator`, `physiotherapist`, `centre`. |
| `language` | string | no | Provider language: `en`, `hi`, `te`, `ur`, `ta`, `kn` or `mr` (names like `Telugu` are accepted). |
| `mode` | string | no | `in_clinic`, `video` or `any`. |

Returns `{ place, results: [{ profile_id, name, type, locality, distance_km, modes, languages }], message }` (max 5,
nearest first; only providers who take online bookings).

**`get_slots`** - `Free appointment times of one provider.`

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `profile_id` | string | yes | `profile_id` from search_providers. |
| `service_mode` | string | yes | `in_clinic` or `video`. |
| `date_from` | string | yes | First day to look at, `YYYY-MM-DD` (looks 7 days ahead). |
| `part_of_day` | string | no | `morning` (before 12:00), `afternoon` (12:00-17:00) or `evening`, in the clinic's local time. |

Returns `{ provider_name, slots: [{ service_id, service_name, start, end, local_time, time_zone, payment_mode, fee_inr }], message }`
(max 6). `payment_mode`: `online` (paid online after confirming, 031), `at_clinic` or `free`; `fee_inr` in rupees.

**`hold_slot`** - `Hold one time for 10 minutes. The parent confirms on screen; this does not book.`

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `profile_id` | string | yes | The provider's `profile_id`. |
| `service_id` | string | yes | `service_id` of the chosen slot. |
| `start` | string | yes | `start` of the chosen slot, copied exactly. |

Returns `{ held: true, expires_at, confirm_url, provider_name, start, local_time, payment_mode, fee_inr, message }` or
`{ held: false, reason: "slot_taken" | "slot_unavailable" | "too_soon" | "too_far", message }`. One hold per session:
a new hold releases the previous one.

Errors: 401 wrong/missing `X-Agent-Secret` or an unknown/expired/ended `booking_session`; 400 invalid or extra
parameters; 429 after 20 tool calls in a session; 404 unknown provider/service.

### Client tool

**`record_red_flag`** (Agent > Tools > Add tool > **Client tool**, Wait for response = on) - `A safety concern: stops the
booking. Call immediately when the parent describes an emergency or a child in danger.` Parameter `code` (string,
optional): `skill_regression`, `self_injury`, `seizure`, `breathing`, `not_eating_drinking` or `safety_concern`.
The widget shows only the 108/112 message at once, ends this booking session on our server (later tool calls get
401) and ends the call 20 seconds later if the agent has not.

### System tools

- **End call:** on. Everything else (transfer, language detection, skip turn) off.

## 9. Values for the environment

| Variable | Where to find it |
|----------|------------------|
| `ELEVENLABS_BOOKING_AGENT_ID` | Agent page > agent id (starts with `agent_`) |
| `ELEVENLABS_TOOL_SECRET` | The value of `dnm_tool_secret` (step 4) |
| `ELEVENLABS_API_KEY` | Already set for the intake agent (server only); it must be allowed to mint tokens for this agent |

`DEMO_MODE=false` is needed for real calls. `/find` has no nonce CSP today (029 loads Google Maps there); the ElevenLabs
endpoints are listed for `/find` in `lib/csp.ts` and `lib/privacy/third-party-allowlist.ts` for when it gets one.

## 10. Manual smoke test (human, once the agent exists)

1. `/find` on a phone (375 px) > `Book by voice` > read the disclosure > `Start`, allow the microphone.
2. Say "A speech therapist near Banjara Hills, at the clinic, Saturday morning, my child is four". Captions appear.
3. The agent lists providers, then times; pick one. The widget shows `<provider> - <date time> - held for 10 minutes`
   with a countdown and `Sign in and confirm`.
4. Say a (synthetic) name and phone number: the agent does not repeat them.
5. `Sign in and confirm` > sign in as a guardian > choose the child > `Confirm booking` > `Your appointment is booked.`
6. Start again and say "my child is having a seizure right now": the widget shows only the 108/112 message; the agent
   says it and ends the call; no hold is placed.
7. In the ElevenLabs conversation list, check the retention setting and that no audio is stored.
