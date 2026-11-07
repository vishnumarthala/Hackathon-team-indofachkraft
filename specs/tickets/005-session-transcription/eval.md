# 005: Session upload and Scribe v2 transcription - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`, `mkdir -p .tmp`, `cp -R demo/fixtures .tmp/ct-fx-<port>`.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/ct-fx-<port> npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none needed.
- Seed / reset: `npm run -s seed:demo -- --new` -> note `case=` (C) and `session=` (S0). (Works without 004.)

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Create, upload, transcribe (covers FR-1, FR-2, FR-3, FR-6, NFR-1)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/sessions -H "Content-Type: application/json" -d '{"file_name":"sample-short.wav","mime_type":"audio/wav","size_bytes":320000,"consent":true}'` -> note `recording_id` (R) and `signed_url`
  2. `curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: audio/wav" --data-binary @demo/audio/sample-short.wav "<signed_url>"`
  3. `curl -s -w " %{http_code} %{time_total}" -X POST http://localhost:<port>/api/sessions/<R>/transcribe`
  4. `npm run -s db:sql -- "select status, jsonb_array_length(segments) as n, speaker_map, storage_path from recordings where id='<R>'"`
  5. `node -e "console.log(require('./demo/fixtures/roleplay-segments.json').length)"`
  6. `npm run -s db:sql -- "select action from audit_events where entity_id='<R>' order by id"`
- **Expected:** step 1 ends with ` 201`, the body has `"bucket":"recordings"`, `"session_number":2` and
  `"path":"<C>/<R>.wav"`; step 2 `200`; step 3 body
  `{"recording_id":"<R>","status":"transcribed","segments_count":<N>,"duration_sec":<number>,"speaker_map":{"speaker_0":"therapist","speaker_1":"parent"}}`
  then ` 200` and a time below `5`; step 4 `transcribed`, n = N, the same speaker_map, path `<C>/<R>.wav`;
  N equals step 5; step 6 lists `recording.created`, `recording.consent`, `recording.transcribed`.

### E-2: Segmentation matches the role-play fixture (covers FR-4, FR-5)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/transcript.test.ts --reporter=verbose`
  2. `npx tsx -e "import('./lib/transcript.ts').then(m=>console.log(m.formatTime(83.4), m.toPromptLines([{id:'s12',speaker:'parent',speaker_label:'speaker_1',start_sec:83.4,end_sec:90.2,text:'He stopped talking.'}])[0]))"`
- **Expected:** step 1 exits 0 and includes the fixture-equality test and the empty-list test; step 2
  prints `01:23 [s12 | 01:23-01:30 | PARENT] He stopped talking.`

### E-3: Validation of the session request (covers FR-1)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/sessions -H "Content-Type: application/json" -d '{"file_name":"a.txt","mime_type":"text/plain","size_bytes":10}'`
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/<C>/sessions -H "Content-Type: application/json" -d '{"file_name":"a.wav","mime_type":"audio/wav","size_bytes":52428801}'`
  3. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/cases/00000000-0000-4000-8000-00000000ffff/sessions -H "Content-Type: application/json" -d '{"file_name":"a.wav","mime_type":"audio/wav","size_bytes":10}'`
- **Expected:** step 1 ends ` 400` with `"mime_type":"Unsupported audio type"`; step 2 ends ` 400` with
  `"size_bytes":"File too large (max 50 MB)"`; step 3 `{"error":"Case not found"} 404`.

## Edge cases

### E-4: Transcribe before upload (covers FR-2)

- **Type:** API
- **Steps:**
  1. `curl -s -X POST http://localhost:<port>/api/cases/<C>/sessions -H "Content-Type: application/json" -d '{"file_name":"a.wav","mime_type":"audio/wav","size_bytes":10}'` -> note `recording_id` (R2); do not upload
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<R2>/transcribe`
  3. `npm run -s db:sql -- "select status from recordings where id='<R2>'"`
- **Expected:** step 2 `{"error":"Audio file not uploaded yet"} 409`; step 3 `[{"status":"created"}]`.

### E-5: Confirmed items block re-transcription; unknown id (covers FR-2)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<S0>/transcribe`
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/00000000-0000-4000-8000-00000000ffff/transcribe`
- **Expected:** step 1 `{"error":"Items already confirmed; create a new session instead"} 409` (the seed
  confirms items 5 and 24 by voice note); step 2 `{"error":"Session not found"} 404`.

### E-6: STT client (covers FR-3)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/stt.test.ts --reporter=verbose`
- **Expected:** exits 0 and includes tests that (a) DEMO_MODE returns the fixture without calling
  `fetch`, (b) the live request sends `model_id=scribe_v2`, `diarize=true`, `num_speakers=2`,
  `timestamps_granularity=word` and header `xi-api-key`, (c) a non-2xx response throws an error whose
  message contains the HTTP status.

### E-7: Key stays on the server (covers NFR-2)

- **Type:** CLI
- **Steps:**
  1. `node scripts/dev/check-env-usage.mjs ELEVENLABS_API_KEY lib/env.ts lib/elevenlabs`
- **Expected:** prints `server only`.

### E-8: Scribe failure is recorded (covers FR-2)

- **Type:** API
- **Steps:**
  1. Repeat E-1 steps 1-2 to get an uploaded recording R3
  2. `mv .tmp/ct-fx-<port>/scribe-response.json .tmp/ct-fx-<port>/scribe-response.json.off`
  3. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<R3>/transcribe`
  4. `npm run -s db:sql -- "select status, error is not null as has_error from recordings where id='<R3>'"`
  5. `mv .tmp/ct-fx-<port>/scribe-response.json.off .tmp/ct-fx-<port>/scribe-response.json`
  6. `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:<port>/api/sessions/<R3>/transcribe`
- **Expected:** step 3 body contains `"error":"Transcription failed"` and ends ` 502`; step 4
  `[{"status":"failed","has_error":true}]`; step 6 `200` (a failed recording can be retried).

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-3 |
| FR-2 | E-1, E-4, E-5, E-8 |
| FR-3 | E-1, E-6 |
| FR-4 | E-2 |
| FR-5 | E-2 |
| FR-6 | E-1 |
| NFR-1 | E-1 |
| NFR-2 | E-7 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-3 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
