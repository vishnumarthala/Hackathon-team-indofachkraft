# 008: Upload and process panel, speaker swap

**Status:** draft
**Mode:** solo
**Runs:** waits for 005, 006, 007: calls their APIs and adds a button to 007's review page

## Summary

Closes the Phase 2 loop in the UI: the therapist picks a recording, confirms consent, and watches three
steps run (upload, transcribe, fill ISAA form) before landing on the review screen. If diarization got
therapist and parent the wrong way round, a "Swap speakers" button fixes it and re-runs the AI.

## Functional requirements

- **FR-1** - Page `/cases/<id>/sessions/new` (404 for unknown case): heading `New session`; file input
  labelled `Session recording` (`accept="audio/*"`); checkbox labelled
  `The parent consented to recording this session`; button `Upload and process`, disabled until a file
  is chosen and the box is ticked.
- **FR-2** - A step list with three rows `Upload`, `Transcribe (ElevenLabs Scribe v2)`,
  `Fill ISAA form (Gemini)`, each showing one state: `Waiting`, `Running…`, `Done` or `Failed`
  (`data-step="upload|transcribe|extract"` and `data-state="waiting|running|done|failed"`).
- **FR-3** - Flow on click: `POST /api/cases/<id>/sessions` with the file's name, MIME type, size and
  `consent: true` (005 writes the `recording.consent` audit) ->
  upload with `createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY).storage
  .from("recordings").uploadToSignedUrl(path, token, file, { contentType })` -> `POST
  /api/sessions/<recording_id>/transcribe` -> `POST /api/sessions/<recording_id>/extract` -> navigate
  to `/cases/<id>/sessions/<recording_id>`.
- **FR-4** - When a step fails, its row shows `Failed` and the API's `error` text in red, and a
  `Retry` button appears that restarts from the failed step (upload is not repeated once it is done).
- **FR-5** - Files over 52,428,800 bytes are rejected in the browser with `File too large (max 50 MB)`
  before any request; files whose MIME type is not in 005's list show `Unsupported audio type`.
- **FR-6** - `PATCH /api/sessions/:id/speakers` body `{ swap: true }`: 404 `{ error: "Session not found" }`;
  409 `{ error: "Speakers can't be swapped after items are confirmed" }` when the recording has a manual
  therapist decision: any fact with `status` `edited`, or with `status` `confirmed` and a `source`
  other than `therapist_voice` (an untouched voice-note confirmation is not a manual decision).
  Otherwise atomically invalidate every ISAA fact derived from the previous mapping: clear `value`,
  `ai_value`, evidence, confidence, rationale and confirmation fields, set `source` `session` and
  `status` `suggested`; clear extraction red flags tied to that mapping. Swap `therapist` <-> `parent`
  in `speaker_map` and every segment's `speaker`, and audit `recording.speakers_swapped` (`entity`
  `recording`, `entity_id` = recording id) in the same transaction. Serialize this change against
  extraction and manual decisions; reject the swap if extraction is running. Returns 200
  `{ speaker_map, segments_count }`.
- **FR-7** - On the review page (007), the transcript header gets a button `Swap speakers`. It calls
  FR-6; on success it calls `POST /api/sessions/<id>/extract` and reloads the page. If extraction
  fails, show the error and a retry action; never display invalidated ratings as current. On 409 show
  the error text next to the button.

## Non-functional requirements

- **NFR-1** - With `DEMO_MODE=true` the whole flow for `demo/audio/sample-short.wav` ends on the review
  page in < 15 s.
- **NFR-2** - Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are used in the browser.

## Affected areas

- `app/cases/[id]/sessions/new/page.tsx` (new)
- `components/session/UploadPanel.tsx`, `components/session/SwapSpeakersButton.tsx` (new)
- `lib/supabase-browser.ts` (new: browser client with the anon key)
- `app/api/sessions/[id]/speakers/route.ts` (new)
- An additive migration for transactional swap coordination if needed.
- `app/cases/[id]/sessions/[recordingId]/page.tsx` or the transcript component in `components/session/`
  (changed: add the `Swap speakers` button only)

## Don't touch

- `lib/transcript.ts`, `lib/extraction.ts`, `lib/scoring.ts`, `app/api/facts/**`, `app/api/sessions/[id]/bulk/**`,
  `app/api/cases/[id]/sessions/**`
- Transcribe/extract route behaviour (only call them)

## Out of scope

- Live microphone recording in the browser, drag-and-drop, upload progress percentage.
- Re-processing a session that already has confirmed items.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Where does consent live? | Audit event `recording.consent`; no new column | additive-only DB; audit log is the record |
| D-2 | After swap | Invalidate all mapping-dependent extraction results, then re-run extraction | neither old AI suggestions nor voice notes are trustworthy after roles change |
| D-3 | Browser upload method | `uploadToSignedUrl` from `@supabase/supabase-js` | signed upload URL from 005 (grill A-2) |

## Open questions

None.
