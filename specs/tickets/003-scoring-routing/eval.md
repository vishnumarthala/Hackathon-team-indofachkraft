# 003: Scoring and routing - Evaluation

## Setup

- `npm install`
- Start: not needed (unit tests only).
- Test account: none needed.
- Seed / reset: none.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0

## Acceptance checks

### E-1: Bands and boundaries (covers FR-1, FR-2, FR-3, FR-9)

- **Type:** CLI
- **Steps:**
  1. `npx tsx -e "import('./lib/scoring.ts').then(m=>console.log([69,70,106,107,153,154].map(m.isaaBand).join(','), [39,40,59,60,79,80].map(m.facpBand).join(','), m.facpBand(null)))"`
- **Expected:** prints `no_autism,mild,mild,moderate,moderate,severe severe,moderate,moderate,borderline,borderline,typical null`

### E-2: Provisional and final score (covers FR-4, FR-7)

- **Type:** CLI
- **Steps:**
  1. `npx tsx -e "import('./lib/scoring.ts').then(m=>{const all=Array.from({length:40},(_,i)=>({item_id:String(i+1),value:3,status:'confirmed'}));const f=m.scoreIsaa(all);const p=m.scoreIsaa(all.map((x,i)=>i<10?{...x,value:null,status:'suggested'}:i<20?{...x,status:'suggested'}:x));console.log(f.total,f.band,m.formatIsaaScore(f));console.log(p.total,p.minimum_total,p.suggested_total,p.confirmed,p.rated);console.log(m.formatIsaaScore(p));console.log(m.formatIsaaScore(p,{showSuggested:true}))})"`
- **Expected:** prints exactly:
  `120 moderate ISAA total: 120 · Moderate (107-153)`
  `null 80 100 20 30`
  `ISAA total: at least 80 (provisional - 20 of 40 confirmed)`
  `ISAA total: at least 80 (provisional - 20 of 40 confirmed; AI-suggested total 100)`

### E-3: Red flags and recommendation texts (covers FR-5, FR-6, FR-8)

- **Type:** CLI
- **Steps:**
  1. `npx tsx -e "import('./lib/scoring.ts').then(m=>{const facts=Array.from({length:40},(_,i)=>({item_id:String(i+1),value:i===14?3:1,status:'confirmed'}));const isaa=m.scoreIsaa(facts);const rf=m.collectRedFlags({isaaFacts:facts,intake:{self_injury:true,lost_speech:true,brief_red_flags:[{type:'self_injury',turn_id:'t7',quote:'he hits his head'}]}});console.log(rf.map(r=>r.type+':'+r.source+':'+(r.turn_id||'-')).join(','));const r=m.recommend({isaa,facpScore:65,redFlags:rf});console.log(r.referral_recommended,r.reasons.join(' | '));console.log(r.action);console.log(m.recommend({isaa,facpScore:null,redFlags:[]}).action);console.log(m.SUGGESTION_LABEL)})"`
- **Expected:** prints exactly:
  `lost_speech:isaa_item:-,self_injury:intake:t7`
  `true Red flag: lost speech | Red flag: self-injury`
  `IEP and home program, review in 3 months + referral to specialist (Phase 3)`
  `Enter the FACP score to get a suggested action`
  `Suggested by CareThread - the therapist decides`

### E-4: Coverage (covers NFR-2, FR-9)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/scoring.test.ts --coverage --coverage.include=lib/scoring.ts`
- **Expected:** exits 0 and the `lib/scoring.ts` line coverage is >= 95%.

## Edge cases

### E-5: Provisional ISAA reason and FACP severe (covers FR-6)

- **Type:** CLI
- **Steps:**
  1. `npx tsx -e "import('./lib/scoring.ts').then(m=>{const facts=Array.from({length:40},(_,i)=>({item_id:String(i+1),value:i<5?null:2,status:i<5?'suggested':'confirmed'}));const isaa=m.scoreIsaa(facts);const r=m.recommend({isaa,facpScore:30,redFlags:[]});console.log(r.provisional,isaa.minimum_total,r.reasons.join(' | '));console.log(r.action)})"`
- **Expected:** prints `true 75 ISAA total at least 75 is 70 or more | FACP score 30 is below 40` and
  `IEP and referral to specialist (Phase 3)`

### E-6: AI suggestions alone never trigger the ISAA rule (covers FR-4, FR-6)

- **Type:** CLI
- **Steps:**
  1. `npx tsx -e "import('./lib/scoring.ts').then(m=>{const facts=Array.from({length:40},(_,i)=>({item_id:String(i+1),value:5,status:'suggested'}));const isaa=m.scoreIsaa(facts);const r=m.recommend({isaa,facpScore:null,redFlags:[]});console.log(isaa.minimum_total,isaa.suggested_total,r.referral_recommended,r.isaa_band,r.action)})"`
- **Expected:** prints `40 200 false null Enter the FACP score to get a suggested action`

### E-7: No I/O (covers NFR-1)

- **Type:** CLI
- **Steps:**
  1. `node -e "const s=require('fs').readFileSync('lib/scoring.ts','utf8');const imps=[...s.matchAll(/(?:import|from)\s*\(?\s*['\"]([^'\"]+)['\"]/g)].map(m=>m[1]);const bad=imps.filter(i=>!/^(@\/schemas\/|\.\.?\/schemas\/|@\/lib\/(isaa|types)$|\.\/(isaa|types)$|zod$)/.test(i));const io=/fetch\(|process\.env|supabase|readFile|createClient/.test(s);console.log(bad.length||io?'impure '+bad.join(','):'pure')"`
- **Expected:** prints `pure`

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1 |
| FR-2 | E-1 |
| FR-3 | E-1 |
| FR-4 | E-2, E-6 |
| FR-5 | E-3 |
| FR-6 | E-3, E-5, E-6 |
| FR-7 | E-2 |
| FR-8 | E-3 |
| FR-9 | E-1, E-4 |
| NFR-1 | E-7 |
| NFR-2 | E-4 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-4 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
