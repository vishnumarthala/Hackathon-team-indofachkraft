# 010: Intake webhook and pre-session brief

**Status:** draft
**Mode:** solo
**Runs:** waits for 002, 009: needs the post-call and brief fixtures and adds to 009's Brief tab and intake page

## Summary

When the parent's browser call ends, the browser polls our completion endpoint, which retrieves the
conversation from ElevenLabs; a webhook is optional when deployed or tunnelled. Both paths use the
same processor. Store the transcript and case-sheet facts and ask Gemini for a parent-reported brief.
In demo mode a button simulates a finished call.

## Functional requirements

- **FR-1** - `POST /api/webhooks/elevenlabs` reads the raw body (`await req.text()`), verifies header
  `elevenlabs-signature` with `verifySignature(rawBody, header, ELEVENLABS_WEBHOOK_SECRET)`, and on
  failure returns 401 `{ error: "Invalid signature" }`. For `type` other than
  `post_call_transcription` it returns 200 `{ received: true, ignored: "<type>" }`. Otherwise it calls
  `processPostCall(payload.data)` and returns 200 with its result. Exports `maxDuration = 60`,
  `runtime = "nodejs"`.
- **FR-2** - `lib/intake/signature.ts` `verifySignature(rawBody, header, secret)` mirrors the ElevenLabs
  SDK: header `t=<unix seconds>,v0=<hex>`; valid when `v0=<hex>` equals
  `"v0=" + hex(HMAC-SHA256(secret, "<t>.<rawBody>"))` (constant-time compare) and `t` is not older than
  30 minutes and not in the future. Missing header/secret, malformed timestamp, wrong scheme, old or
  future timestamp, invalid hex or mismatch -> false.
- **FR-3** - `lib/intake/process.ts` `processPostCall(data)`:
  1. `intake_token` = `data.conversation_initiation_client_data.dynamic_variables.intake_token`; no case
     with that token -> audit `intake.unknown_token` (case null, details `{ conversation_id }`) and
     return `{ received: true, ignored: "unknown token" }`.
  2. A recording with `external_id` = `data.conversation_id` exists -> return
     `{ received: true, duplicate: true }`. Concurrent webhook and completion requests must not
     create duplicate recordings or facts.
  3. Insert the intake recording: `kind` `intake_call`, `status` `transcribed`, `external_id`,
     `duration_sec` = `data.metadata.call_duration_secs` if present, segments from `data.transcript`:
     for index i (0-based) with a non-empty `message`: `{ id: "t<i+1>", speaker: role === "agent" ?
     "agent" : "parent", speaker_label: role, start_sec: time_in_call_secs, end_sec: next turn's
     time_in_call_secs or start + 5, text: message }` (turns without a message are skipped, ids keep the
     original index).
  4. Insert one `CASE_SHEET` fact per field of `schemas/case-sheet.json` found in
     `data.analysis.data_collection_results` (other keys ignored): `item_id` = field id, `value` =
     `ai_value` = result value (null allowed), `rationale`, `source` `parent_call`, `status`
     `suggested`, `evidence` null, `confidence` null.
  5. Gemini `generateJson({ task: "brief", system: prompts/brief.md, prompt, schema: BriefSchema })`;
     prompt = lines `[t3 | 00:42 | PARENT] text` (agent lines labelled `AI`) + the collected fields as
     `<label>: <value>`. Drop red flags whose `turn_id` is not an existing segment id. Insert a
     `pre_session_brief` report (`recording_id` = intake recording, `content` = brief, `content_md` =
     FR-4 rendering, `status` `draft`).
  6. Set `cases.status` = `intake_done` when it was `booked`. Audit `intake.received` (actor `parent`).
     Insert the recording, facts, case status and receipt audit atomically in one database transaction;
     on failure roll them all back and return a non-2xx error. Use the `external_id` unique constraint
     to arbitrate concurrent requests. Generate the brief only after that transaction commits.
  7. Return `{ received: true, case_id, recording_id, brief: true }`. If step 5 fails, keep steps 3-4,
     audit `intake.brief_failed` and return `{ received: true, case_id, recording_id, brief: false }`.
- **FR-4** - `content_md`: `## Pre-session brief (parent-reported)`, the summary, `### Red flags`
  (each `- <type label>: "<quote>" (<mm:ss>)` or `- None reported`), `### Questions to verify`
  (numbered), `### What the parent reported` (table `| Topic | Answer |` from `parent_reported`).
  Type labels: `Lost speech`, `Self-injury`, `Other`.
- **FR-5** - `prompts/brief.md` follows `docs/system-design.md` section 10 (document never diagnose;
  everything is parent-reported; 3-6 questions to verify; red flags cite `turn_id`; quotes verbatim).
- **FR-6** - `POST /api/dev/simulate-intake/:token`: when `DEMO_MODE` is not true -> 404
  `{ error: "Not found" }`. Unknown token -> 404 `{ error: "This link is not valid." }`. Otherwise loads
  `demo/fixtures/elevenlabs-post-call.json`, sets `dynamic_variables.intake_token` = token and
  `conversation_id` = `demo-<Date.now()>`, and returns `processPostCall(data)`.
- **FR-7** - The intake page (009) fills `#demo-actions` with a button `Simulate completed call (demo)`
  that calls FR-6 and then shows `Call ended. Thank you! You can close this page.`
- **FR-8** - The Brief tab (009) fills `#brief-section`: when a brief exists, `<h2>Pre-session brief</h2>`
  with a badge `Parent-reported`, the summary, red flags in red (`<type label>: "<quote>" at <mm:ss>`),
  `Questions to verify` (numbered), a table `What the parent reported` (label, value), and a button
  `Mark brief reviewed` (hidden once `status` is `final`, replaced by `Reviewed by <therapist_name>`).
  When an intake recording exists but no brief: `The call was received but the brief could not be
  generated.` When there is no intake recording: nothing.
- **FR-9** - `POST /api/cases/:id/brief/reviewed`: 404 `{ error: "No brief for this case" }` when the
  case has no `pre_session_brief`; sets `status` `final`, `updated_at` now; audit `brief.reviewed`;
  200 `{ report }`.
- **FR-10** - `tests/intake.test.ts`: signature valid/invalid/old timestamp/missing parts; segment
  building from the fixture (ids, speakers, end times, skipped empty turns); case-sheet mapping; red flag
  turn-id filtering; Markdown rendering headings.
- **FR-11** - `POST /api/intake/:token/complete` accepts `{ conversation_id: string }`. Validate the
  body and look up the case by token; return 400 for invalid input and 404 for an unknown token. In
  live mode retrieve the conversation from `GET /v1/convai/conversations/<conversation_id>` with the
  server-only API key. Verify its agent ID equals `ELEVENLABS_AGENT_ID` and its returned dynamic
  `intake_token` equals the URL token before processing; a mismatch is 403 and must not persist data.
  Return 202 `{ status: "processing" }` for `initiated`, `in-progress`, or `processing`; return 502
  with an explicit error for `failed`, unexpected statuses, malformed responses, or provider failures.
  For `done`, pass the verified conversation to `processPostCall` and return its result as 200.
  In demo mode use the existing simulated-call path, not a live provider request.
- **FR-12** - Preserve the conversation ID returned by `startSession`; after a connected session ends,
  post it to FR-11. Poll every 3 seconds on 202 for at most 120 seconds. On success show completion;
  on failure or timeout show an actionable error and allow the parent to retry completion without
  starting a second call. Stop the timer on unmount and avoid overlapping requests. Do not claim that
  the call was saved while processing or after failure.
- **FR-13** - Automated tests cover provider verification, all statuses, timeout and retry, concurrent
  webhook/completion delivery, rollback on a fact insertion error and the absence of duplicate facts.

## Non-functional requirements

- **NFR-1** - The webhook answers in < 10 s in DEMO_MODE (ElevenLabs retries slow webhooks).
- **NFR-2** - Unknown tokens and duplicates return 200 so ElevenLabs does not retry or disable the webhook.

## Affected areas

- `app/api/webhooks/elevenlabs/route.ts`, `app/api/dev/simulate-intake/[token]/route.ts`,
  `app/api/cases/[id]/brief/reviewed/route.ts`, `app/api/intake/[token]/complete/route.ts` (new)
- `lib/intake/signature.ts`, `lib/intake/process.ts`, `lib/intake/briefMarkdown.ts`, `prompts/brief.md` (new)
- `components/intake/BriefSection.tsx`, `components/intake/SimulateCallButton.tsx` (new)
- `app/cases/[id]/brief/page.tsx` (changed: render `BriefSection` in `#brief-section`)
- `components/intake/IntakeCall.tsx` (changed: render `SimulateCallButton` in `#demo-actions`)
- `tests/intake.test.ts`, `tests/intake-completion.test.ts` (new)
- A new additive migration for a transaction helper if needed; do not edit an existing migration.

## Don't touch

- `components/intake/IntakeLinkCard.tsx`, `app/api/intake/[token]/start/**`,
  `app/api/cases/[id]/intake-link/**` (009)
- `lib/types.ts`, `lib/gemini.ts`, `demo/fixtures/**`, existing migrations, `package.json`

## Out of scope

- `post_call_audio` webhooks (no call audio is stored), call-initiation-failure webhooks.
- Retrying a failed brief from the UI.
- Editing the brief text.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Verify with the SDK or our own code? | Own `verifySignature` that mirrors SDK `webhooks.constructEvent` (checked in `@elevenlabs/elevenlabs-js` dist/wrapper/webhooks.js) | no API key needed, unit-testable |
| D-2 | Unknown token / duplicate | 200 with `ignored` / `duplicate` | grill section 13; avoids auto-disable |
| D-3 | Turn ids | `t<index+1>` over the original transcript array | matches the brief fixture (002 FR-6) |
| D-4 | Brief failure | Keep recording + facts, show a message | parent's answers are not lost |

## Open questions

None.
