# 005: Session upload and Scribe v2 transcription

**Status:** done
**Mode:** solo
**Runs:** waits for 002: needs the Scribe fixture, roleplay-segments.json, the test audio and the seed (002 waits for 001)

## Summary

Backend for Phase 2's first half: create a session recording with a signed upload URL (so audio goes
straight from the browser to Supabase Storage, avoiding Vercel's 4.5 MB limit), then transcribe it with
ElevenLabs Scribe v2 (speaker diarization) and store a clean list of speaker segments with timestamps.
Those segment ids are what Gemini cites as evidence later.

## Functional requirements

- **FR-1** - `POST /api/cases/:id/sessions` body `{ file_name, mime_type, size_bytes, consent? }`
  (unknown keys are ignored). `mime_type`
  must be one of `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`, `audio/x-wav`, `audio/wave`,
  `audio/webm`, `audio/ogg` (else 400 `details.mime_type` = `Unsupported audio type`); `size_bytes`
  integer 1..52428800 (else 400 `details.size_bytes` = `File too large (max 50 MB)`); unknown case ->
  404 `{ error: "Case not found" }`. Creates a `recordings` row (`kind` `session`, `session_number` =
  highest session number of the case + 1, `status` `created`, `mime_type`, `storage_path`
  `<case_id>/<recording_id>.<ext>` where ext comes from the mime type: mpeg->mp3, mp4/x-m4a->m4a,
  wav/x-wav/wave->wav, webm->webm, ogg->ogg) and a signed upload URL with
  `supabaseAdmin().storage.from("recordings").createSignedUploadUrl(path)`. Returns 201
  `{ recording_id, session_number, bucket: "recordings", path, token, signed_url }`. Audit
  `recording.created` (actor `therapist`, entity `recording`, entity_id = recording id); when
  `consent === true` also audit `recording.consent` (same actor/entity, details `{ consent: true }`).
- **FR-2** - `POST /api/sessions/:id/transcribe`: 404 `{ error: "Session not found" }` for unknown ids or
  `kind` other than `session`; 409 `{ error: "Transcription already running" }` when `status` is
  `transcribing`; 409 `{ error: "Items already confirmed; create a new session instead" }` when the
  recording has any `confirmed`/`edited` fact; downloads the audio from Storage - missing object -> 409
  `{ error: "Audio file not uploaded yet" }` with the status unchanged. Then it claims the recording
  with one conditional update (`update recordings set status='transcribing' where id=$1 and status <>
  'transcribing' returning id`; no row -> 409 `Transcription already running`), calls
  `transcribeAudio({ audio, fileName: basename(storage_path), mimeType })`, builds segments, deletes
  the recording's existing ISAA facts (they can only be `suggested` here), and saves `segments`,
  `speaker_map`, `duration_sec` (last word `end`), `language_code`, `red_flags` `[]`, `status`
  `transcribed`, `error` null. If the response has no `word` entries: `status` `failed`, `error`
  `No speech found in the recording`, 422 `{ error: "No speech found in the recording" }`. Returns 200
  `{ recording_id, status: "transcribed", segments_count, duration_sec, speaker_map }`. Audit
  `recording.transcribed`. On a Scribe error: `status` `failed`, `error` = the message, 502
  `{ error: "Transcription failed", details: "<message>" }`.
- **FR-3** - `lib/elevenlabs/stt.ts`: `transcribeAudio({ audio: Buffer, fileName, mimeType })` calls
  `POST https://api.elevenlabs.io/v1/speech-to-text` (multipart; `model_id=scribe_v2`, `diarize=true`,
  `num_speakers=2`, `timestamps_granularity=word`, `file`) with header `xi-api-key`, and returns the
  parsed `{ language_code, text, words }`. In DEMO_MODE it returns `loadFixture("scribe-response.json")`
  without any network call.
- **FR-4** - `lib/transcript.ts`: `buildSegments(words)` - consecutive `word`/`spacing`/`audio_event`
  entries with the same `speaker_id` form a segment; a new segment starts on speaker change, a gap
  > 1.5 s between the end of one word and the start of the next word, or when the segment would exceed
  30 s; ids `s1..sN`; `text` = concatenated entry texts, trimmed; `start_sec`/`end_sec` = first/last
  word times; `speaker_label` = `speaker_id`; `speaker` = `unknown`. `mapSpeakers(segments)` returns
  `{ segments, speaker_map }`: the speaker_id with a segment whose trimmed text starts with `note`
  (case-insensitive) is `therapist`, every other speaker_id is `parent`; if none, the first segment's
  speaker is `therapist`. Also exports `formatTime(sec)` -> `mm:ss` (e.g. `83.4` -> `01:23`) and
  `toPromptLines(segments)` -> lines `[s12 | 01:23-01:30 | PARENT] text`.
- **FR-5** - `tests/transcript.test.ts`: `mapSpeakers(buildSegments(scribe fixture words)).segments`
  equals `demo/fixtures/roleplay-segments.json` (same ids, speakers, labels and texts; times within
  0.01 s); plus synthetic cases for each split rule, the fallback speaker rule, an empty word list
  (returns `[]`), `formatTime` and `toPromptLines`.
- **FR-6** - Both routes export `maxDuration = 300` and `runtime = "nodejs"`.

## Non-functional requirements

- **NFR-1** - In DEMO_MODE, transcribe answers in < 5 s for the 10 s test audio.
- **NFR-2** - The ElevenLabs API key is only referenced in `lib/env.ts` and `lib/elevenlabs/*`
  (server code) and never appears in a response body.

## Affected areas

- `app/api/cases/[id]/sessions/route.ts`, `app/api/sessions/[id]/transcribe/route.ts` (new)
- `lib/elevenlabs/stt.ts`, `lib/transcript.ts`, `lib/queries/recordings.ts` (new)
- `tests/transcript.test.ts`, `tests/stt.test.ts` (new)

## Don't touch

- `lib/types.ts`, `lib/db.ts`, `lib/gemini.ts`, `demo/fixtures/**`, `supabase/migrations/**`, `package.json`
- `app/cases/**` (UI is 008)

## Out of scope

- Upload UI and progress (008), speaker swap (008), extraction (006).
- Async Scribe webhooks; transcription runs inside the request.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | How does audio reach Storage? | Browser PUTs to a signed upload URL | Vercel 4.5 MB request limit (grill F-13) |
| D-2 | How does the server send audio to Scribe? | Download from Storage with the service role, send as multipart `file` | bucket is private; no public URLs |
| D-3 | Language | Not sent (auto-detect) | parents mix English and Telugu |
| D-4 | Speaker mapping | Rule in FR-4; swap button comes in 008 | grill D-4 |
| D-5 | Re-transcribe | Allowed unless facts are confirmed/edited | protects therapist decisions |

## Open questions

None.
