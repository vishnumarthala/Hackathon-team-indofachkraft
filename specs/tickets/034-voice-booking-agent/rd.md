# 034: Voice booking agent (web widget on /find)

**Status:** draft
**Mode:** solo
**Runs:** waits for 030, 033: uses slots/holds (030) and the screen's safety rules and agent patterns (033)

## Summary

A voice widget on `/find` lets a parent say what they need ("a Telugu-speaking speech therapist near
Kukatpally on Saturday morning"). An English-only ElevenLabs agent calls server tools to search
providers, read slots and place a **hold**; the parent then signs in and taps `Confirm` on screen -
the agent can never confirm a booking itself. No identifiable child data is collected by the agent.

## Functional requirements

- **FR-1** - Agent `DoctorNearMe Booking Assistant` (English), configured by hand from
  `docs/elevenlabs-booking-agent.md`: private; max 6 minutes; dynamic variable `{{booking_session}}`;
  server (webhook) tools `search_providers`, `get_slots`, `hold_slot`; prompt rules: ask for area,
  specialty, language, mode, preferred day/time and child's age band only; never ask names, phone, DOB;
  red-flag statements -> fixed 108/112 message (033 wording) and end without booking; explain that the
  parent must sign in and confirm on screen.
- **FR-2** - Booking session: `POST /api/agents/booking/session` (public, rate limited 5/hour/IP) -> 201
  `{ conversation_token, booking_session }` where `booking_session` = random 32-byte id; its sha256 is
  set as an HttpOnly cookie-bound value (`dnm_booking_session`) and used as `hold_owner_session` (030).
- **FR-3** - Tool endpoints `POST /api/agents/booking/tools/{search_providers|get_slots|hold_slot}`:
  authenticated by header `X-Agent-Secret: <ELEVENLABS_TOOL_SECRET>` (401 otherwise) **and** a valid,
  unexpired (30 min) `booking_session` in the body. `search_providers { locality_text, type?, language?,
  mode? }` -> geocodes the locality server-side (029) -> top 5 results `{ profile_id, name, type,
  locality, distance_km }`; `get_slots { profile_id, service_mode, date_from, part_of_day? }` -> max 6
  slots; `hold_slot { profile_id, service_id, start }` -> 030 `booking_hold` with owner session ->
  `{ held: true, expires_at, confirm_url }` or `{ held: false, reason: "slot_taken" }`. Max 1 hold per
  session; max 20 tool calls per session.
- **FR-4** - Widget on `/find`: button `Book by voice` -> disclosure (`You will talk to an AI assistant
  in English. It will not ask for your child's name.`) + `Start`; live transcript captions; when a hold
  exists the widget shows a card `<provider> - <date time> - held for 10 minutes` with `Sign in and
  confirm` -> `/book/[profileId]?appointment=<id>` (030 flow attaches the hold via the cookie session).
- **FR-5** - Audit `booking_agent.hold_created` (actor `ai`, session hash only). Tool payloads and
  transcripts are not stored by DoctorNearMe.

## Non-functional requirements

- **NFR-1** - Tool endpoints respond < 1.5 s p95 (agent latency).
- **NFR-2** - No PII in tool payloads; the server rejects payload keys outside the schema (400).
- **NFR-3** - DEMO_MODE: widget runs a scripted fake conversation calling the same tool handlers.

## Affected areas

- `lib/agents/booking/**`, `app/api/agents/booking/**` (new); `app/find/**` (widget); `components/voice/BookingWidget.tsx` (new)
- `docs/elevenlabs-booking-agent.md` (new); `.env.example` (`ELEVENLABS_BOOKING_AGENT_ID`, `ELEVENLABS_TOOL_SECRET`)
- `lib/auth-access.ts`, `messages/*.json`; `tests/booking-agent-tools.test.ts` (new)

## Don't touch

- 030 state machine (call only), 033 screen flow, Child-Dev intake agent, existing migrations, `BOARD.md`

## Out of scope

- Hindi/Telugu voice, phone/WhatsApp voice booking, payments by voice, cancellation/reschedule by voice.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Tools | `search_providers`, `get_slots`, `hold_slot` | plan §4 voice agents table |
| D-2 | Final confirmation | Signed-in guardian taps Confirm | plan §4 "final confirm requires signed-in guardian" |
| D-3 | Language | English only | plan §2 |
| D-4 | Tool auth | Shared secret + per-session token | public agent cannot be trusted alone |

## Open questions

None.
