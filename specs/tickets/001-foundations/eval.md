# 001: Foundations - Evaluation

## Setup

- Start Docker Desktop and install dependencies with `npm install`; in 001's worktree run
  `npx supabase start`, then `npm run db:env` to create `.env.local` with the local values.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none needed.
- Seed / reset: none.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `node scripts/dev/build-without-env.mjs` exits 0 (NFR-1) and `.env.local` exists again afterwards

## Acceptance checks

### E-1: Scripts and dependencies exist (covers FR-1, FR-2)

- **Type:** CLI
- **Steps:**
  1. `node -e "const p=require('./package.json');const s=['dev','build','start','lint','typecheck','test','verify','prepare','db:migrate','db:reset','db:env','db:check','db:sql','seed:demo','fixtures:scribe'];const d=['@supabase/supabase-js','@google/genai','@elevenlabs/elevenlabs-js','@elevenlabs/react','resend','zod','postgres','react-markdown','remark-gfm','@next/env'];const dev=['tsx','vitest','supabase'];const miss=[...s.filter(x=>!p.scripts[x]).map(x=>'script '+x),...d.filter(x=>!p.dependencies[x]).map(x=>'dep '+x),...dev.filter(x=>!(p.devDependencies||{})[x]).map(x=>'dev '+x)];console.log(miss.length?miss.join(','):'all present')"`
  2. `node -e "const p=require('./package.json');console.log(p.scripts.lint+' | '+p.scripts.test+' | '+p.scripts.typecheck)"`
- **Expected:** step 1 prints `all present`; step 2 prints `eslint . | vitest run | tsc --noEmit`.

### E-2: Migration applies and is idempotent (covers FR-7, NFR-3)

- **Type:** CLI
- **Steps:**
  1. `npm run -s db:migrate`
  2. `npm run -s db:migrate`
- **Expected:** both commands exit 0; the second reports no pending migrations. Inspect the local
  migration list if output differs by Supabase CLI version; the initial migration must be applied once.

### E-3: All tables, RLS and the bucket exist (covers FR-7, FR-8, FR-9)

- **Type:** CLI
- **Steps:**
  1. `npm run -s db:check`
  2. `npm run -s db:sql -- "select count(*)::int as n from pg_tables where schemaname='public' and rowsecurity and tablename in ('cases','recordings','facts','reports','referrals','case_questions','audit_events','pilot_signups')"`
  3. `npm run -s db:sql -- "select public, file_size_limit from storage.buckets where id='recordings'"`
- **Expected:** step 1 prints 8 lines `<table> ok` and `bucket recordings ok`, exit 0; step 2 prints
  `[{"n":8}]`; step 3 prints `[{"public":false,"file_size_limit":52428800}]`.

### E-4: Layout, banner and placeholder home (covers FR-3, FR-4)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/`
  2. `agent-browser get text body`
  3. `agent-browser screenshot evidence/E-4.png`
  4. `agent-browser find role link click --name "Open dashboard"`
  5. `agent-browser get url`
- **Expected:** step 2 contains `CareThread`, `The AI assistant for early intervention therapists.`,
  `Demo - synthetic data only. AI documents, the clinician decides.` and `Dashboard`; step 5 ends with
  `/dashboard` (a 404 page there is fine until 004).

### E-5: .env.example is complete (covers FR-5)

- **Type:** CLI
- **Steps:**
  1. `node -e "const t=require('fs').readFileSync('.env.example','utf8');const need='NEXT_PUBLIC_APP_URL DEMO_MODE NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY DATABASE_URL ELEVENLABS_API_KEY ELEVENLABS_AGENT_ID ELEVENLABS_WEBHOOK_SECRET ELEVENLABS_VOICE_ID_EN ELEVENLABS_VOICE_ID_HI ELEVENLABS_VOICE_ID_TE GEMINI_API_KEY GEMINI_MODEL RESEND_API_KEY EMAIL_FROM DEMO_EMAIL_TO'.split(' ');const miss=need.filter(v=>!new RegExp('^'+v+'=','m').test(t));const vals=['NEXT_PUBLIC_APP_URL','DEMO_MODE','GEMINI_MODEL','EMAIL_FROM'].map(v=>((t.match(new RegExp('^'+v+'=(.*)$','m'))||[])[1]||'').replace(/^\"|\"$/g,''));console.log(miss.length?'missing '+miss.join(','):'complete', JSON.stringify(vals))"`
- **Expected:** prints `complete ["http://localhost:3000","true","gemini-3.8-flash","CareThread <onboarding@resend.dev>"]`

### E-6: Schema files match Appendix C (covers FR-11, FR-12)

- **Type:** CLI
- **Steps:**
  1. `node -e "const j=require('./schemas/isaa.json');const ids=j.items.map(i=>i.id);console.log(j.items.length,new Set(ids).size,Math.min(...ids),Math.max(...ids),j.domains.map(d=>d.id+':'+d.items.length).join(','),JSON.stringify(j.red_flag_items),j.bands.map(b=>b.id+'/'+b.min+'-'+b.max+'/'+b.label).join('|'),j.scale.map(s=>s.value+':'+s.label+':'+s.range).join('|'))"`
  2. `node -e "const j=require('./schemas/case-sheet.json');console.log(j.fields.length, j.fields.map(f=>f.id+'='+f.label).join(','))"`
  3. `node -e "const j=require('./schemas/facp.json');console.log(j.instrument, j.bands.map(b=>b.id+'/'+b.min+'-'+b.max+'/'+b.action).join('|'))"`
  4. `node -e "const j=require('./schemas/isaa.json');console.log(j.items.find(i=>i.id===1).text,'|',j.items.find(i=>i.id===15).text,'|',j.items.find(i=>i.id===40).text)"`
- **Expected:**
  step 1 `40 40 1 40 social:9,emotional:5,speech:9,behaviour:7,sensory:6,cognitive:4 {"15":"lost_speech","29":"self_injury"} no_autism/40-69/Below cut-off (under 70)|mild/70-106/Mild (70-106)|moderate/107-153/Moderate (107-153)|severe/154-200/Severe (154-200) 1:Rarely:up to 20%|2:Sometimes:21-40%|3:Frequently:41-60%|4:Mostly:61-80%|5:Always:81-100%`;
  step 2 `15 consent_given=Consent given,child_age_months=Age (months),main_concern=Main concern,speech_status=Speech now,lost_speech=Lost speech,lost_speech_details=When speech was lost,eye_contact=Eye contact,response_to_name=Response to name,play_and_peers=Play and other children,repetitive_behaviours=Repetitive behaviours,sensory=Sensory reactions,self_injury=Self-injury,routines_and_tantrums=Routines and tantrums,sleep_and_eating=Sleep and eating,family_history=Family history`;
  step 3 `FACP typical/80-100/Home program and parent counselling, re-screen in 3 months|borderline/60-79/IEP and home program, review in 3 months|moderate/40-59/IEP and regular therapy sessions|severe/0-39/IEP and referral to specialist (Phase 3)`;
  step 4 `Has poor eye contact | Acquired speech and lost it | Has 'savant' ability`.

### E-7: Library behaviour is unit tested (covers FR-6, FR-10, FR-12..FR-18, FR-21, NFR-4)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/isaa.test.ts tests/gemini.test.ts tests/email.test.ts tests/tokens.test.ts tests/env.test.ts tests/http.test.ts tests/types.test.ts --reporter=verbose`
  2. `node -e "const s=require('fs').readFileSync('lib/types.ts','utf8');console.log((s.match(/\bany\b/g)||[]).length)"`
- **Expected:** step 1 exits 0 and the verbose list includes tests for: missing env var message,
  DEMO_MODE fixture load, missing fixture error, invalid fixture error, Gemini schema-rejection fallback
  without using the retry, Gemini retry after non-JSON output then success, `GeminiError` after two
  invalid answers, email demo skip, `DEMO_EMAIL_TO` redirect with the `Originally to:` line, audit
  with no caseId stores null, token length 43 and url-safe, `parseJson` 400 with a field -> message
  map and `body: "Body must be JSON"`, `ratingLabel(3)` = `Frequently`, a 121-word Brief summary
  rejected; step 2 prints `0`.

### E-8: Missing fixture becomes a GeminiError (covers FR-13, FR-14)

- **Type:** CLI
- **Steps:**
  1. `DEMO_MODE=true DEMO_FIXTURES_DIR=tests/fixtures npx tsx -e "import('./lib/gemini.ts').then(async m=>{const {z}=await import('zod');try{await m.generateJson({task:'does-not-exist',system:'s',prompt:'p',schema:z.object({a:z.string()})})}catch(e){console.log(e.constructor.name, e.message.includes('Missing fixture'))}})"`
- **Expected:** prints `GeminiError true`.

## Edge cases

### E-9: No secrets in client code; copy rules (covers NFR-2, FR-19)

- **Type:** CLI
- **Steps:**
  1. `node scripts/dev/check-client-imports.mjs`
  2. `node scripts/dev/check-copy.mjs app lib`
  3. `node scripts/dev/check-env-usage.mjs SUPABASE_SERVICE_ROLE_KEY lib/env.ts lib/db.ts`
- **Expected:** step 1 `clean`; step 2 `clean`; step 3 `server only`.

### E-10: Env getters (covers FR-6)

- **Type:** CLI
- **Steps:**
  1. `GEMINI_API_KEY= npx tsx -e "import('./lib/env.ts').then(m=>{try{console.log(m.env.GEMINI_API_KEY)}catch(e){console.log(e.message)}})"`
  2. `GEMINI_MODEL= DEMO_MODE=yes DEMO_EMAIL_TO= npx tsx -e "import('./lib/env.ts').then(m=>console.log(m.env.GEMINI_MODEL, m.env.DEMO_MODE, m.env.DEMO_EMAIL_TO))"`
- **Expected:** step 1 prints `Missing env var: GEMINI_API_KEY`; step 2 prints `gemini-3.8-flash false undefined`.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1 |
| FR-2 | E-1 |
| FR-3 | E-4 |
| FR-4 | E-4 |
| FR-5 | E-5 |
| FR-6 | E-7, E-10 |
| FR-7 | E-2, E-3 |
| FR-8 | E-3 |
| FR-9 | E-3 |
| FR-10 | E-7 |
| FR-11 | E-6 |
| FR-12 | E-6, E-7 |
| FR-13 | E-7, E-8 |
| FR-14 | E-7, E-8 |
| FR-15 | E-7 |
| FR-16 | E-7 |
| FR-17 | E-7 |
| FR-18 | E-7 |
| FR-19 | E-9, Automated checks; hook installer inspection |
| FR-20 | CI workflow inspection and a successful PR run |
| FR-21 | E-7 |
| NFR-1 | Automated checks (build without .env.local) |
| NFR-2 | E-9 |
| NFR-3 | E-2 |
| NFR-4 | E-7 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-8 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
