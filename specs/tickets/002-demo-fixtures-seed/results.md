# 002: Demo fixtures and seed - Results

**Branch:** `ticket/002-demo-fixtures-seed` (base `int/b-backend`)
**Database:** shared Supabase cloud project (no local Docker), schema already applied.

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | `evidence/gates.txt` (exit 0) |
| `npm run typecheck` | PASS | `evidence/gates.txt` (exit 0) |
| `npm test` | PASS | `evidence/gates.txt` (10 files, 106 tests) |
| `npm run build` | PASS | `evidence/gates.txt` (exit 0) |
| E-1 Fixture rules (Vitest verbose) | PASS | `evidence/E-1-vitest.txt` (28 tests: schemas, gaps, alternation, words, `Note:` lines, verbatim quotes, null items, brief turn ids, ask citations, post-call aliases/age, parent-summary ending, copy rules, scribe determinism, plus seed helpers) |
| E-2 Fixture numbers | PASS | `evidence/E-2.txt`: `true true true all signs 2` / `40 true true true true lost_speech,self_injury 24:4,5:4` / `post_call_transcription true 1 true 40 true true 15 demo-intake-token` / `te false true` |
| E-3 Scribe fixture deterministic | PASS | `evidence/E-3.txt`: no diff after regeneration, `eng true 2 true` |
| E-4 Seed creates full case, < 20 s | PASS | `evidence/E-4.txt`: `real 1.48`; `[{"isaa":40,"sheet":15,"confirmed":2,"unrated":24,"briefs":1,"st":"extracted","turns":21}]`, transcript turns with a message = 21 |
| E-5 Seed options | PASS | `evidence/E-5.txt`: `[{"n":40,"at":40,"edited":24}]`, `[{"status":"transcribed","facts":0}]` |
| E-6 Test audio | PASS | `evidence/E-6.txt`: `1 1 16000 16 10.2088125 330778`; `demo/README.md` lists the `say`/`afconvert` commands and the synthetic-data notice |
| E-7 Canonical reset repeatable | PASS | `evidence/E-7.txt`: both runs print the canonical ids and `token=demo-intake-token`; `[{"n":1}]` |
| E-8 Size and synthetic data | PASS | `evidence/E-8.txt`: `true 124542`, `synthetic only` |
| Copy rules (`scripts/dev/check-copy.mjs demo scripts/seed-demo.ts scripts/make-scribe-fixture.ts tests/fixtures.test.ts`) | PASS | prints `clean` |
| Failure path (FR-8 error handling) | PASS | manual: a temporarily injected error after the audio upload and session insert printed `seed failed: ...` to stderr, no `seeded` line, exit 1; the case row and its Storage object were gone afterwards (code reverted) |
| Audio upload branch (FR-8) | PASS | manual: with a temporary `demo/audio/session-1.mp3`, `--new` set `storage_path` = `<case>/<session>.mp3`, `mime_type` `audio/mpeg`, object present in bucket `recordings` (temporary file and test case removed afterwards) |

## Deviations

- Cloud instead of local Supabase: all DB checks ran against the shared cloud project via
  `npm run -s db:sql`. No eval step needed `supabase db reset`, so no step had to be changed.
- Intake tokens of `--new` runs are replaced by `<redacted>` in the evidence files (they are live link
  tokens in the shared database); the canonical `demo-intake-token` is kept.
- Voice-note facts (items 5 and 24) get `evidence` = the note segment (quote = note text,
  `verified: true`) and keep `ai_value` = the extract rating, matching ticket 006 FR-5. FR-8 does not
  specify their evidence.
- Intake segment `end_sec` uses the next *kept* turn's time (002 FR-8). Ticket 010 FR-3 says "next
  turn's" time; the two differ only for the turn before the null tool-call turn (`t8` ends at 74 here,
  not 72).
- The seed does not write audit events (not required by FR-8).

## Facts for other tickets

- Output: exactly one stdout line `seeded case=<uuid> session=<uuid> intake=<uuid> token=<token>`;
  on error `seed failed: <message>` on stderr, exit 1, the half-built case is deleted.
- Flags: `--new`, `--confirmed`, `--stage transcribed` (also `--stage=transcribed`); unknown flags fail.
- Canonical ids: case `00000000-0000-4000-8000-000000000001`, intake `...0002`, session `...0003`,
  token `demo-intake-token`, intake `external_id` `seed-canonical` (`--new`: `seed-<first 8 of case id>`).
- Role-play: 36 segments `s1..s36`, last `end_sec` 240.43. Notes: `s7` (item 5 -> 4), `s25`
  (item 24 -> 4). Lost speech `s10`, head hitting `s30`.
- Extract: 15 rated items (1, 3, 6, 7, 9, 15, 16, 18, 20, 24, 25, 28, 29, 30, 31), 25 null. After the
  seed: 24 null ISAA facts, 2 confirmed (5, 24), 14 suggested.
- `--confirmed`: the 14 suggested -> `confirmed`; the 24 null -> value 1, `edited`, evidence null; all
  40 have `confirmed_at` (`confirmed_by` `Demo Therapist`; voice notes keep `Demo Therapist (voice note)`).
- `--stage transcribed`: session `status` `transcribed`, `red_flags` `[]`, no ISAA facts (intake,
  case-sheet facts and brief are still created).
- Post-call: 22 turns, turn 9 (`t9`) is the null tool call, 21 kept intake segments; brief red flags
  cite `t8` (lost speech) and `t17` (head hitting). Ask cites `1:s10`.
- `scripts/make-scribe-fixture.ts` exports `buildScribeResponse` and `serializeScribeResponse`;
  `scripts/seed-demo.ts` exports `PostCallSchema`, `buildIntakeSegments`, `renderBriefMarkdown`,
  `buildIsaaFacts` and friends (main only runs when executed directly).
- Session audio: if `demo/audio/session-1.mp3` exists the seed uploads it (upsert) to
  `recordings/<case>/<session>.mp3`.
