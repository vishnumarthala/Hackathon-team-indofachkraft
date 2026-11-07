# 009: Intake link and browser voice call

**Status:** draft
**Mode:** solo
**Runs:** waits for 004: replaces the Brief tab placeholder and uses the case pages

## Summary

Phase 1 without any phone provider: the therapist creates a private intake link and shares it by
WhatsApp or email. The parent opens it on their phone, agrees to talk to an AI assistant, picks Telugu,
Hindi or English, and talks to the ElevenLabs agent in the browser (WebRTC). The ElevenLabs agent
itself is configured by hand by Role A from the guide this ticket writes.

## Functional requirements

- **FR-1** - Brief tab `/cases/<id>/brief` replaces the placeholder with a section `<h2>Intake call</h2>`:
  without a token a button `Create intake link`; with a token a read-only input labelled `Intake link`
  holding the URL, a button `Copy link` (copies, then shows `Copied`), a link `Share on WhatsApp`
  (`target="_blank"`, href = `whatsapp_url`), and a button `Email to parent` (disabled with
  `title="Add a parent email on the case first"` when the case has no `parent_email`; after sending shows
  `Email sent`, `Email not sent (demo mode)` or `Email could not be sent`). A status line:
  `Intake call completed` when the case has an `intake_call` recording, else
  `Waiting for the parent to complete the call`. The page ends with an empty
  `<div id="brief-section"></div>` that ticket 010 fills.
- **FR-2** - `POST /api/cases/:id/intake-link` body `{ send_email?: boolean }`: 404
  `{ error: "Case not found" }`; creates `cases.intake_token` with `newToken()` if it is null (otherwise
  reuses it); `url` = `<NEXT_PUBLIC_APP_URL>/intake/<token>`; message text exactly
  `Hello <parent_alias>, this is <therapist_name>'s team at CareThread. Before <child_alias>'s first session, please take a short voice call (about 15 minutes) with our AI assistant in Telugu, Hindi or English: <url>`;
  `whatsapp_url` = `https://wa.me/<digits of parent_phone>?text=<encodeURIComponent(message)>`, or
  `https://wa.me/?text=<...>` without a phone. `send_email: true` without `parent_email` -> 422
  `{ error: "Add a parent email first" }`; otherwise sends subject
  `Your CareThread intake call for <child_alias>` with the message as text. Returns 200
  `{ url, whatsapp_url, emailed }` (`emailed` = `delivered` from `sendEmail`); a Resend error gives 200
  with `emailed: false` and `email_error: "Email could not be sent"`. Audit `intake.link_created`
  (first time only) and `intake.link_emailed`.
- **FR-3** - Public page `/intake/<token>` (mobile-first). Unknown token -> 404 page with
  `This link is not valid.` If the case already has an `intake_call` recording: only
  `Thank you, your intake call is complete.` Otherwise: `<h1>Intake call for <child_alias>'s family</h1>`;
  the text `You will talk to an AI assistant, not a person. It asks about <child_alias>'s development so the therapist is prepared. The call takes up to 15 minutes and is recorded and summarised for the therapist.`;
  a select labelled `Language` with options `English`, `हिन्दी (Hindi)`, `తెలుగు (Telugu)` (values
  `en`,`hi`,`te`, default = case language); a checkbox labelled
  `I agree to talk to an AI assistant and for this call to be recorded and summarised for the therapist.`;
  a button `Start call`, disabled until the box is ticked.
- **FR-4** - On `Start call`: first `POST /api/intake/<token>/start` with `{ language }`. If the API
  returns `{ demo: true }`, the page shows `Demo mode: no live call.` and an empty
  `<div id="demo-actions"></div>` (010 adds a simulate button there) - no microphone request. A non-2xx
  answer shows the API `error` text. Otherwise request microphone access with
  `navigator.mediaDevices.getUserMedia({ audio: true })` (denied -> `Microphone access is needed for the
  call. Please allow it and try again.`), then `startSession({ conversationToken, dynamicVariables,
  overrides: { agent: { language } } })` from `@elevenlabs/react` inside a `ConversationProvider`.
  Status text follows the SDK status: `connecting` -> `Connecting…`; `connected` ->
  `Connected - speak now` and a button `End call` that calls `endSession()`; `disconnected` after having
  been connected -> `Call ended. Thank you! You can close this page.`; an `onError` callback shows
  `The call failed. Please try again.` and re-enables `Start call`.
- **FR-5** - `POST /api/intake/:token/start` body `{ language: "en" | "hi" | "te" }`: 404
  `{ error: "This link is not valid." }`; 409 `{ error: "This intake call is already complete" }` when an
  `intake_call` recording exists; DEMO_MODE -> 200 `{ demo: true }`; otherwise
  `getConversationToken()` -> 200 `{ conversation_token, agent_id, dynamic_variables: { intake_token,
  child_alias, parent_alias, therapist_name, language } }`; ElevenLabs error -> 502
  `{ error: "Could not start the call" }`. Audit `intake.started` (actor `parent`).
- **FR-6** - `lib/elevenlabs/agent.ts` `getConversationToken()` calls
  `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_AGENT_ID>` with header
  `xi-api-key` and returns `token`.
- **FR-7** - `docs/elevenlabs-agent.md`: the step-by-step agent setup for Role A, containing: agent name
  `CareThread Intake`; authentication enabled (private agent, token required); additional languages
  Hindi and Telugu with a voice per language; overrides allowed for `language`; max conversation
  duration 900 s; the dynamic variables the app sends (`{{intake_token}}`, `{{child_alias}}`,
  `{{parent_alias}}`, `{{therapist_name}}`, `{{language}}`) with a warning that `intake_token` is how
  the webhook finds the case; the system prompt and first message below (copy exactly); the 15
  data-collection fields from `schemas/case-sheet.json` (id, type, description); the workspace post-call
  webhook (`https://<vercel-url>/api/webhooks/elevenlabs`, HMAC, event `post_call_transcription`) and which
  values go into `.env.local` (`ELEVENLABS_AGENT_ID`, `ELEVENLABS_WEBHOOK_SECRET`).
  First message: `Hello {{parent_alias}}, I am an AI assistant from CareThread, helping {{therapist_name}}'s team before {{child_alias}}'s first session. This call is recorded and summarised for the therapist. Is it okay to continue?`
  System prompt (copy into the doc verbatim):
  ```
  You are CareThread's intake assistant. You are an AI, not a doctor or therapist, and you say so if asked.
  Speak only in {{language}} (en = English, hi = Hindi, te = Telugu). Use simple, warm words. Ask one question at a time.
  Goal: before {{child_alias}}'s first session, learn from {{parent_alias}} about the child's development so the therapist is prepared.
  First get consent. If the parent does not agree, thank them and end the call.
  Cover, in this order: child's age; main concern; current speech; whether the child had words or skills and lost them (when); eye contact; response to name; play and other children; repeated movements, lining up, repeated phrases; reactions to sounds, textures, lights; any self-hurting such as head hitting or biting; reactions to changes in routine and tantrums; sleep and eating; family history the parent wants to share.
  Never diagnose, never say whether the child has autism, never give medical advice. If the parent asks, say the therapist will discuss it with them.
  If the parent describes an emergency or a child in danger, tell them to contact their doctor or emergency services now, then end the call politely.
  Keep the call under 15 minutes. At the end, summarise what you heard in two sentences, thank the parent and say the therapist will see them at the first session.
  ```

## Non-functional requirements

- **NFR-1** - `/intake/<token>` has no horizontal scroll at 375 px width; the Start button is at least
  44 px tall.
- **NFR-2** - `ELEVENLABS_API_KEY` is only referenced in `lib/env.ts` and server modules under
  `lib/elevenlabs/`; it never reaches the browser.
- **NFR-3** - Tokens are 43-character base64url strings (from `newToken()`).

## Affected areas

- `app/cases/[id]/brief/page.tsx` (changed: placeholder -> intake section)
- `components/intake/IntakeLinkCard.tsx`, `components/intake/IntakeCall.tsx` (new)
- `app/intake/[token]/page.tsx`, `app/intake/[token]/not-found.tsx` (new)
- `app/api/cases/[id]/intake-link/route.ts`, `app/api/intake/[token]/start/route.ts` (new)
- `lib/elevenlabs/agent.ts`, `lib/queries/intake.ts`, `lib/intake/message.ts` (new)
- `docs/elevenlabs-agent.md` (new)
- `tests/intake-message.test.ts` (new: message text and WhatsApp URL)
- `tests/intake-call.test.ts`, `tests/intake-routes.test.ts` (new: mocked call, route and failure checks
  specified in `eval.md`)

## Don't touch

- `app/cases/[id]/layout.tsx`, other tab pages, `lib/email.ts`, `lib/tokens.ts`, `lib/types.ts`,
  `supabase/migrations/**`, `package.json`

## Out of scope

- The post-call webhook, the brief and the simulate button (010).
- Phone calls of any kind (Twilio, SIP, WhatsApp calling) - roadmap.
- Configuring the ElevenLabs agent through the API (Role A does it by hand).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Telephony | None; browser WebRTC via `@elevenlabs/react` | user chose the browser link; no Twilio |
| D-2 | Private or public agent | Private; server issues a conversation token | the API key stays on the server |
| D-3 | Language | Parent picks on the page; sent as `overrides.agent.language` and the `language` dynamic variable | grill D-6 |
| D-4 | How the webhook finds the case | `intake_token` dynamic variable | no case id in the browser |
| D-5 | Token expiry | None today | grill A-7 |

## Open questions

None.

## Manual live smoke test (Owner A, after merge - not part of eval.md)

1. With `DEMO_MODE=false` and real `ELEVENLABS_API_KEY`/`ELEVENLABS_AGENT_ID`, open an intake link on a
   phone, tick consent, pick Telugu, tap `Start call`: the agent greets in Telugu with the AI disclosure.
2. `End call` ends the session and shows `Call ended. Thank you! You can close this page.`
