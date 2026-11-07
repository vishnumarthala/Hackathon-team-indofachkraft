# 008: Upload and process panel, speaker swap - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`, `mkdir -p .tmp`, `cp -R demo/fixtures .tmp/ct-fx-<port>`.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/ct-fx-<port> npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none needed.
- Seed / reset: `npm run -s seed:demo -- --new` -> note `case=` (C). Test files:
  `node -e "require('fs').writeFileSync('.tmp/ct-big-<port>.wav',Buffer.alloc(51*1024*1024))"` and
  `cp demo/README.md .tmp/ct-notes-<port>.txt`.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Upload and process end to end (covers FR-1, FR-2, FR-3, NFR-1)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>/sessions/new`
  2. `agent-browser snapshot -i` (check `Upload and process` is disabled)
  3. `agent-browser upload "input[type=file]" demo/audio/sample-short.wav`
  4. `agent-browser find label "The parent consented to recording this session" check`
  5. `agent-browser find role button click --name "Upload and process"` (note the time)
  6. `agent-browser wait --url "**/sessions/*-*-*-*-*"`
  7. `agent-browser get url` (note the time; recording id S = last path part)
  8. `agent-browser eval "document.querySelectorAll('[data-item]').length"`
  9. `npm run -s db:sql -- "select count(*)::int as n from audit_events where case_id='<C>' and action='recording.consent'"`
  10. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 2 shows the button disabled; step 7 is `/cases/<C>/sessions/<uuid>` and at most 15 s
  after step 5; step 8 returns `40`; step 9 `[{"n":1}]`.

### E-2: Step states are visible (covers FR-2)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>/sessions/new`
  2. `agent-browser eval "[...document.querySelectorAll('[data-step]')].map(e=>e.dataset.step+':'+e.dataset.state).join(',')"`
- **Expected:** returns `upload:waiting,transcribe:waiting,extract:waiting`.

### E-3: Swap speakers re-runs extraction (covers FR-6, FR-7)

- **Type:** Browser
- **Steps:**
  1. On the review page from E-1 (session S; in DEMO_MODE items 5 and 24 are confirmed by voice note, no
     manual decisions): `npm run -s db:sql -- "select speaker_map, (select count(*)::int from audit_events where entity_id='<S>' and action='extraction.completed') as runs from recordings where id='<S>'"`
  2. `agent-browser find role button click --name "Swap speakers"`
  3. Repeat every 1 s for up to 15 s until `runs` is one higher than in step 1:
     `npm run -s db:sql -- "select speaker_map, (select count(*)::int from audit_events where entity_id='<S>' and action='extraction.completed') as runs from recordings where id='<S>'"`
  4. `npm run -s db:sql -- "select count(*)::int as n from audit_events where entity_id='<S>' and action='recording.speakers_swapped'"`
  5. `npm run -s db:sql -- "select count(*)::int as n from facts where recording_id='<S>' and source='therapist_voice'"`
- **Expected:** step 3 reaches `runs` + 1 within 15 s and its map has `therapist` and `parent` exchanged
  compared with step 1; step 4 `[{"n":1}]`; step 5 `[{"n":0}]` (the `Note:` lines now belong to the
  parent, so no voice note applies).
- Add automated coverage that checks all prior mapping-dependent values, AI values, evidence and red
  flags are cleared before re-extraction, that a failed re-extraction exposes a retry without stale
  values, and that concurrent extraction or a manual decision cannot race the swap.

## Edge cases

### E-4: Swap blocked after a manual decision; unknown id (covers FR-6)

- **Type:** API
- **Steps:**
  1. `npm run -s seed:demo -- --new` -> session S2
  2. `npm run -s db:sql -- "select id from facts where recording_id='<S2>' and status='suggested' and value is not null limit 1"` -> F
  3. `curl -s -o /dev/null -w "%{http_code}" -X PATCH http://localhost:<port>/api/facts/<F> -H "Content-Type: application/json" -d '{"action":"confirm"}'`
  4. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/sessions/<S2>/speakers -H "Content-Type: application/json" -d '{"swap":true}'`
  5. `npm run -s seed:demo -- --new` -> session S3, then `npm run -s db:sql -- "update facts set status='edited', value='2'::jsonb where recording_id='<S3>' and source='therapist_voice' and item_id='5' returning id"`
  6. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/sessions/<S3>/speakers -H "Content-Type: application/json" -d '{"swap":true}'`
  7. `curl -s -w " %{http_code}" -X PATCH http://localhost:<port>/api/sessions/00000000-0000-4000-8000-00000000ffff/speakers -H "Content-Type: application/json" -d '{"swap":true}'`
- **Expected:** step 3 `200`; step 4 `{"error":"Speakers can't be swapped after items are confirmed"} 409`;
  step 6 the same 409 (an edited voice-note item is a manual decision); step 7 `{"error":"Session not found"} 404`.

### E-5: Client-side file checks (covers FR-5)

- **Type:** Browser
- **Steps:**
  1. `npm run -s db:sql -- "select count(*)::int as n from recordings where case_id='<C>'"` (baseline B)
  2. `agent-browser open http://localhost:<port>/cases/<C>/sessions/new`
  3. `agent-browser upload "input[type=file]" .tmp/ct-big-<port>.wav`
  4. `agent-browser find label "The parent consented to recording this session" check`
  5. `agent-browser find role button click --name "Upload and process"`
  6. `agent-browser get text body`
  7. `agent-browser upload "input[type=file]" .tmp/ct-notes-<port>.txt`
  8. `agent-browser find role button click --name "Upload and process"`
  9. `agent-browser get text body`
  10. `npm run -s db:sql -- "select count(*)::int as n from recordings where case_id='<C>'"`
- **Expected:** step 6 contains `File too large (max 50 MB)`; step 9 contains `Unsupported audio type`;
  step 10 equals baseline B (no recording was created).

### E-6: Failures show Retry and recover without re-uploading (covers FR-4)

- **Type:** Browser
- **Steps:**
  1. `mv .tmp/ct-fx-<port>/scribe-response.json .tmp/ct-fx-<port>/scribe-response.json.off`
  2. Run E-1 steps 1-5
  3. `agent-browser wait 3000`
  4. `agent-browser get text body`
  5. `agent-browser eval "[...document.querySelectorAll('[data-step]')].map(e=>e.dataset.step+':'+e.dataset.state).join(',')"`
  6. `mv .tmp/ct-fx-<port>/scribe-response.json.off .tmp/ct-fx-<port>/scribe-response.json`
  7. `mv .tmp/ct-fx-<port>/gemini/extract.json .tmp/ct-fx-<port>/gemini/extract.json.off`
  8. `agent-browser find role button click --name "Retry"`
  9. `agent-browser wait 3000`
  10. `agent-browser eval "[...document.querySelectorAll('[data-step]')].map(e=>e.dataset.step+':'+e.dataset.state).join(',')"`
  11. `agent-browser get text body`
  12. `mv .tmp/ct-fx-<port>/gemini/extract.json.off .tmp/ct-fx-<port>/gemini/extract.json`
  13. `agent-browser find role button click --name "Retry"`
  14. `agent-browser wait --url "**/sessions/*-*-*-*-*"`
  15. `agent-browser eval "document.querySelectorAll('[data-item]').length"`
  16. `npm run -s db:sql -- "select count(*)::int as n from recordings where case_id='<C>' and status='created'"`
- **Expected:** step 4 contains `Failed`, `Transcription failed` and a `Retry` button; step 5
  `upload:done,transcribe:failed,extract:waiting`; step 10 `upload:done,transcribe:done,extract:failed`;
  step 11 contains `Extraction failed`; step 15 returns `40`; step 16 `[{"n":0}]` (no second upload
  left a dangling recording).

### E-7: Browser only uses public env (covers NFR-2)

- **Type:** CLI
- **Steps:**
  1. `node scripts/dev/check-client-imports.mjs`
- **Expected:** prints `clean`.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1 |
| FR-2 | E-1, E-2, E-6 |
| FR-3 | E-1 |
| FR-4 | E-6 |
| FR-5 | E-5 |
| FR-6 | E-3, E-4 |
| FR-7 | E-3 |
| NFR-1 | E-1 |
| NFR-2 | E-7 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-3 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
