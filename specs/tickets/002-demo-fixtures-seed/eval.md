# 002: Demo fixtures and seed - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: not needed (CLI checks only).
- Test account: none needed.
- Seed / reset: this ticket creates the seed; use `--new` in every check except E-7.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Fixture rules hold (covers FR-1, FR-2, FR-4, FR-5, FR-6, FR-9)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/fixtures.test.ts --reporter=verbose`
- **Expected:** exits 0; the verbose list includes a test for each of: schema validity of every
  fixture, role-play gaps >= 2.0 s, speaker alternation, > 300 words, both `Note:` lines, extract quotes
  verbatim, >= 5 null items, brief turn ids, ask citations, post-call aliases/age, parent-summary
  ending, copy rules, scribe fixture determinism.

### E-2: Role-play and fixture numbers, independently (covers FR-1, FR-2, FR-4, FR-5, FR-6)

- **Type:** CLI
- **Steps:**
  1. `node -e "const s=require('./demo/fixtures/roleplay-segments.json');const t=s.map(x=>x.text).join(' ').toLowerCase();const signs=['eye','name','stopped','line','cartoon','mixer','cooker','flap','route','head','point'];const words=t.split(/\s+/).length;console.log(s.length>=30, s[s.length-1].end_sec>=200&&s[s.length-1].end_sec<=260, words>300, signs.filter(w=>!t.includes(w)).join(',')||'all signs', s.filter(x=>x.text.startsWith('Note:')).length)"`
  2. `node -e "const e=require('./demo/fixtures/gemini/extract.json');const r=i=>e.items.find(x=>x.item_id===i).rating;console.log(e.items.length, e.items.filter(x=>x.rating===null).length>=5, e.items.filter(x=>x.rating!==null).length>=12, r(15)>=3, r(29)>=3, e.red_flags.map(f=>f.type).sort().join(','), e.therapist_notes.map(n=>n.item_id+':'+n.rating).sort().join(','))"`
  3. `node -e "const p=require('./demo/fixtures/elevenlabs-post-call.json');const d=p.data;const r=d.analysis.data_collection_results;console.log(p.type, d.transcript.length>=12, d.transcript.filter(t=>t.message===null).length, d.transcript[0].message.includes('I am an AI assistant'), r.child_age_months.value, r.lost_speech.value, r.self_injury.value, Object.keys(r).length, d.conversation_initiation_client_data.dynamic_variables.intake_token)"`
  4. `node -e "const p=require('./demo/fixtures/gemini/parent-summary.json');console.log(p.language, /\d/.test(p.text), p.text.trim().endsWith('మీ థెరపిస్ట్ తదుపరి దశల గురించి మీతో మాట్లాడతారు.'))"`
- **Expected:** step 1 `true true true all signs 2`; step 2 `40 true true true true lost_speech,self_injury 24:4,5:4`;
  step 3 `post_call_transcription true 1 true 40 true true 15 demo-intake-token`; step 4 `te false true`.

### E-3: Scribe fixture is deterministic (covers FR-3)

- **Type:** CLI
- **Steps:**
  1. `npm run -s fixtures:scribe`
  2. `git diff --exit-code --stat demo/fixtures/scribe-response.json`
  3. `node -e "const r=require('./demo/fixtures/scribe-response.json');const w=r.words.filter(x=>x.type==='word');console.log(r.language_code, w.length>300, new Set(w.map(x=>x.speaker_id)).size, r.words.some(x=>x.type==='spacing'))"`
- **Expected:** step 2 prints nothing and exits 0; step 3 prints `eng true 2 true`.

### E-4: Seed creates a full demo case (covers FR-8, NFR-3)

- **Type:** CLI
- **Steps:**
  1. `/usr/bin/time -p npm run -s seed:demo -- --new` and note the printed ids
  2. `npm run -s db:sql -- "select (select count(*)::int from facts where recording_id='<session>' and instrument='ISAA') as isaa, (select count(*)::int from facts where recording_id='<intake>' and instrument='CASE_SHEET') as sheet, (select count(*)::int from facts where recording_id='<session>' and status='confirmed') as confirmed, (select count(*)::int from facts where recording_id='<session>' and value is null) as unrated, (select count(*)::int from reports where case_id='<case>' and kind='pre_session_brief') as briefs, (select status from recordings where id='<session>') as st, (select jsonb_array_length(segments) from recordings where id='<intake>') as turns"`
  3. `node -e "const d=require('./demo/fixtures/elevenlabs-post-call.json').data;console.log(d.transcript.filter(t=>t.message).length)"`
- **Expected:** step 1 prints a last line matching `^seeded case=[0-9a-f-]{36} session=[0-9a-f-]{36} intake=[0-9a-f-]{36} token=\S+$`
  and `real` < 20; step 2 prints `[{"isaa":40,"sheet":15,"confirmed":2,"unrated":<n >= 5>,"briefs":1,"st":"extracted","turns":<T>}]`
  where `<T>` equals step 3's number (the null turn is skipped).

### E-5: Seed options (covers FR-8)

- **Type:** CLI
- **Steps:**
  1. `npm run -s seed:demo -- --new --confirmed` (note session id A)
  2. `npm run -s db:sql -- "select count(*)::int as n, count(confirmed_at)::int as at, count(*) filter (where status='edited' and evidence is null)::int as edited from facts where recording_id='<A>' and instrument='ISAA' and status in ('confirmed','edited') and value is not null"`
  3. `npm run -s seed:demo -- --new --stage transcribed` (note session id B)
  4. `npm run -s db:sql -- "select status, (select count(*)::int from facts where recording_id='<B>') as facts from recordings where id='<B>'"`
- **Expected:** step 2 `[{"n":40,"at":40,"edited":<n >= 5>}]`; step 4 `[{"status":"transcribed","facts":0}]`.

### E-6: Test audio (covers FR-7)

- **Type:** CLI
- **Steps:**
  1. `node -e "const fs=require('fs'),b=fs.readFileSync('demo/audio/sample-short.wav');let p=12,fmt,data;while(p+8<=b.length){const id=b.toString('ascii',p,p+4),n=b.readUInt32LE(p+4);if(id==='fmt ')fmt=p+8;if(id==='data')data=n;p+=8+n+(n%2)}if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE'||fmt===undefined||data===undefined)throw Error('invalid WAV');console.log(b.readUInt16LE(fmt),b.readUInt16LE(fmt+2),b.readUInt32LE(fmt+4),b.readUInt16LE(fmt+14),data/32000,b.length)"`
  2. Review `demo/README.md` for the recorded creation method and synthetic-data notice.
- **Expected:** step 1 prints `1 1 16000 16 <duration> <size>`, where duration is 8-15 seconds and
  size is at most 1048576 bytes.

## Edge cases

### E-7: Canonical reset is repeatable (covers FR-8)

- **Type:** CLI
- **Steps:**
  1. `npm run -s seed:demo`
  2. `npm run -s seed:demo`
  3. `npm run -s db:sql -- "select count(*)::int as n from cases where id='00000000-0000-4000-8000-000000000001'"`
- **Expected:** steps 1 and 2 both end with `seeded case=00000000-0000-4000-8000-000000000001 session=00000000-0000-4000-8000-000000000003 intake=00000000-0000-4000-8000-000000000002 token=demo-intake-token`; step 3 prints `[{"n":1}]`.

### E-8: Size and synthetic data (covers NFR-1, NFR-2)

- **Type:** CLI
- **Steps:**
  1. `node -e "const fs=require('fs'),p=require('path');let n=0;const walk=d=>fs.readdirSync(d).forEach(f=>{const x=p.join(d,f);fs.statSync(x).isDirectory()?walk(x):x.endsWith('.json')&&(n+=fs.statSync(x).size)});walk('demo/fixtures');console.log(n<=300*1024, n)"`
  2. `node -e "const fs=require('fs'),p=require('path');const bad=[];const walk=d=>fs.readdirSync(d).forEach(f=>{const x=p.join(d,f);if(fs.statSync(x).isDirectory())return walk(x);if(!/\.(json|md)$/.test(x))return;const t=fs.readFileSync(x,'utf8');(t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)||[]).filter(e=>!e.endsWith('@example.com')).forEach(e=>bad.push(x+': '+e));(t.match(/\+?\d[\d ]{7,}\d/g)||[]).filter(m=>/[ +]/.test(m)).forEach(m=>bad.push(x+': '+m))});walk('demo');console.log(bad.length?bad.join('\n'):'synthetic only')"`
- **Expected:** step 1 starts with `true`; step 2 prints `synthetic only`.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-2 |
| FR-2 | E-1, E-2 |
| FR-3 | E-3 |
| FR-4 | E-1, E-2 |
| FR-5 | E-1, E-2 |
| FR-6 | E-1, E-2 |
| FR-7 | E-6 |
| FR-8 | E-4, E-5, E-7 |
| FR-9 | E-1 |
| NFR-1 | E-8 |
| NFR-2 | E-8 |
| NFR-3 | E-4 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-6 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
