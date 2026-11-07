# 006: ISAA extraction with Gemini - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`, `mkdir -p .tmp`, `cp -R demo/fixtures .tmp/ct-fx-<port>`.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/ct-fx-<port> npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none needed.
- Seed / reset: `npm run -s seed:demo -- --new --stage transcribed` -> note `case=` (C) and `session=` (S).

## Automated checks

- Add automated integration checks for transactional rollback after an upsert failure and concurrent
  extraction/therapist decisions: no partial result persists and confirmed decisions are not overwritten.
- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Extraction fills 40 items with verified evidence (covers FR-1, FR-2, FR-3, FR-5, NFR-1, NFR-2)

- **Type:** API
- **Steps:**
  1. `npm run -s db:sql -- "update cases set status='booked' where id='<C>' returning status"`
  2. `curl -s -o .tmp/ext-<port>.json -w "%{http_code} %{time_total}" -X POST http://localhost:<port>/api/sessions/<S>/extract`
  3. `node -e "const r=require('./.tmp/ext-<port>.json');const f=r.facts;console.log(f.length, f.filter(x=>x.value!==null).length>=12, f.filter(x=>x.evidence&&x.evidence.verified).length>=12, f.filter(x=>x.value===null&&x.evidence!==null).length, r.red_flags.map(x=>x.type).sort().join(','), r.therapist_notes_applied, f.map(x=>Number(x.item_id)).join(',')===Array.from({length:40},(_,i)=>i+1).join(','))"`
  4. `npm run -s db:sql -- "select r.status, c.status as case_status, (select count(*)::int from facts where recording_id=r.id and instrument='ISAA') as n from recordings r join cases c on c.id=r.case_id where r.id='<S>'"`
  5. `npm run -s db:sql -- "select f.item_id from facts f where f.recording_id='<S>' and f.evidence is not null and not exists (select 1 from jsonb_array_elements((select segments from recordings where id='<S>')) s where s->>'id' = f.evidence->>'segment_id' and (s->>'start_sec')::numeric = (f.evidence->>'start_sec')::numeric and (s->>'end_sec')::numeric = (f.evidence->>'end_sec')::numeric)"`
- **Expected:** step 2 prints `200` and a time below `5`; step 3 `40 true true 0 lost_speech,self_injury 2 true`;
  step 4 `[{"status":"extracted","case_status":"in_assessment","n":40}]`; step 5 `[]` (every evidence
  points at an existing segment with the same start and end).

### E-2: Voice notes override items (covers FR-4, FR-5)

- **Type:** API
- **Steps:**
  1. `npm run -s db:sql -- "select item_id, value, source, status, confirmed_by from facts where recording_id='<S>' and item_id in ('5','24') order by item_id::int"`
- **Expected:** `[{"item_id":"5","value":4,"source":"therapist_voice","status":"confirmed","confirmed_by":"Demo Therapist (voice note)"},{"item_id":"24","value":4,"source":"therapist_voice","status":"confirmed","confirmed_by":"Demo Therapist (voice note)"}]`

### E-3: Post-processing and note parsing rules (covers FR-3, FR-4, FR-7)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/extraction.test.ts --reporter=verbose`
  2. `npx tsx -e "import('./lib/extraction.ts').then(m=>console.log(JSON.stringify(m.parseVoiceNotes([{id:'s1',speaker:'therapist',speaker_label:'speaker_0',start_sec:0,end_sec:3,text:'Note: rate item twenty-four as five.'},{id:'s2',speaker:'parent',speaker_label:'speaker_1',start_sec:5,end_sec:8,text:'Note: rate item 3 as 2'},{id:'s3',speaker:'therapist',speaker_label:'speaker_0',start_sec:10,end_sec:12,text:'Note: rate item 24 as 3'}]).map(n=>[n.item_id,n.rating,n.segment_id]))))"`
- **Expected:** step 1 exits 0 with tests for unknown segment (rating null, confidence 0), wrong quote
  (`verified: false`, confidence <= 0.5), duplicate item, missing items filled, digits and words,
  merge with Gemini notes; step 2 prints `[[24,3,"s3"]]` (parent notes ignored, last note wins).

## Edge cases

### E-4: Re-extraction keeps therapist decisions and the first AI value (covers FR-5)

- **Type:** API
- **Steps:**
  1. `npm run -s db:sql -- "update facts set value='1'::jsonb, status='edited', confirmed_by='Demo Therapist' where recording_id='<S>' and item_id='1' returning item_id"`
  2. `npm run -s db:sql -- "update facts set ai_value='2'::jsonb where recording_id='<S>' and item_id='2' and status='suggested' returning item_id"`
  3. `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:<port>/api/sessions/<S>/extract`
  4. `npm run -s db:sql -- "select item_id, value, status, ai_value from facts where recording_id='<S>' and item_id in ('1','2') order by item_id::int"`
- **Expected:** step 3 `200`; step 4 shows item 1 `"value":1,"status":"edited"` and, if step 2 returned a
  row, item 2 still has `"ai_value":2`.

### E-5: Wrong state, running and unknown id (covers FR-1)

- **Type:** API
- **Steps:**
  1. `npm run -s db:sql -- "insert into recordings (case_id, kind, session_number) values ('<C>','session',9) returning id"` -> R
  2. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<R>/extract`
  3. `npm run -s db:sql -- "update recordings set status='extracting' where id='<R>' returning status"`
  4. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<R>/extract`
  5. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/00000000-0000-4000-8000-00000000ffff/extract`
- **Expected:** step 2 `{"error":"Transcribe the session first"} 409`; step 4
  `{"error":"Extraction already running"} 409`; step 5 `{"error":"Session not found"} 404`.

### E-6: Gemini failure leaves data untouched (covers FR-6)

- **Type:** API
- **Steps:**
  1. `npm run -s seed:demo -- --new` -> session S2 (extracted, 40 facts, items 5 and 24 confirmed)
  2. `mv .tmp/ct-fx-<port>/gemini/extract.json .tmp/ct-fx-<port>/gemini/extract.json.off`
  3. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/sessions/<S2>/extract`
  4. `npm run -s db:sql -- "select status, error is not null as has_error, (select count(*)::int from facts where recording_id='<S2>') as n, (select status from facts where recording_id='<S2>' and item_id='5') as item5 from recordings where id='<S2>'"`
  5. `mv .tmp/ct-fx-<port>/gemini/extract.json.off .tmp/ct-fx-<port>/gemini/extract.json`
- **Expected:** step 3 body has `"error":"Extraction failed"` and ends ` 502`; step 4
  `[{"status":"extracted","has_error":true,"n":40,"item5":"confirmed"}]`.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-5 |
| FR-2 | E-1 |
| FR-3 | E-1, E-3 |
| FR-4 | E-2, E-3 |
| FR-5 | E-1, E-2, E-4 |
| FR-6 | E-6 |
| FR-7 | E-3 |
| NFR-1 | E-1 |
| NFR-2 | E-1 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-3 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
