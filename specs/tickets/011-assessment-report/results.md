# 011: Draft assessment report - Results

Branch: `ticket/011-assessment-report` (base `int/a-voice`). Tested against the shared Supabase cloud
project, `DEMO_MODE=true` with a per-worker fixture copy, port 3003, headless Chrome (playwright-core
installed outside the repo). Test cases were deleted afterwards.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, tests, build) | PASS | 198 tests - `evidence/verify.log` |
| `tests/report.test.ts` extension | PASS | unconfirmed ratings/quotes never in the prompt, report or domain sums; unsupported / out-of-domain item IDs rejected; evidence-free and unverified quotations rejected; score/band claims in model text dropped - `evidence/E-2.txt` |
| E-1 generate, edit, finalize | PASS | Generate 2.3 s in the browser (< 5 s); body has `Assessment report - Ravi (synthetic)`, `Session 1`, `ISAA total: 83 · ` (DB sum 83), `Observations`, `Red flags`, `Lost speech`, `Suggested next steps`, exact footer; Save -> `Saved`; Mark final -> `Final`, read-only textarea, no Save; DB `final` + `# Edited by therapist`; audits `report.drafted` (ai), `report.edited`, `report.finalized` (therapist); still final after reload - `evidence/E-1-browser.txt`, `evidence/E-1-db.txt`, `evidence/E-1-draft.png`, `evidence/E-1.png` |
| E-2 composer rules | PASS | vitest verbose exits 0 (headings, domain table, provisional wording, red flags, footer); `grep -ciE "total score\|band" prompts/report.md` -> 1 - `evidence/E-2.txt` |
| E-3 preconditions and errors | PASS | S3 422 `Confirm at least one ISAA item first`; final S 409 `Report is final`; unknown report 404; brief report 422 `Only assessment reports can be edited here`; C3 page shows `Confirm ISAA items in a session first.`; S2 (2 confirmed) 200 with `ISAA total: at least 46 (provisional - 2 of 40 confirmed)` - `evidence/E-3-api.txt`, `evidence/E-3-browser.txt`, `evidence/E-3-*.png` |
| E-4 Gemini failure | PASS | route test: 502 `Report could not be generated`, `saveAssessmentDraft` never called, existing draft untouched. Extra live check: removing `report.json` from the per-worker fixture copy -> 502 and `updated_at` unchanged; server kept running - `evidence/E-4-live.txt` |
| Don't touch | PASS | `lib/scoring.ts`, `lib/types.ts`, `lib/gemini.ts`, other tabs, migrations, `package.json` unchanged |
| Live Gemini call | NOT RUN | no live credentials in this run; DEMO_MODE fixture + mocked `generateJson` only |

## Decisions made while building

- Red flags in the report come only from confirmed/edited ISAA items (items 15 and 29 rated 2+), per
  D-1. Extraction and intake red flags are not used, so a provisional report can show `- None` even
  when the review screen (which also counts AI suggestions) shows a red flag.
- Output filter (FR-3): an observation is kept only if every cited item is a confirmed/edited fact of
  this session in the same domain, its text has no quotation that is not in a confirmed fact's
  verified evidence, and it makes no score/total/band claim; otherwise the whole observation is
  dropped (not trimmed), so unconfirmed behaviour is never presented as observed. Background is
  filtered per sentence, recommendations per item. Rejection counts go into the `report.drafted`
  audit. `content` stores the filtered draft.
- Recommendations are only checked for score claims and unsupported quotes; their content relies on
  the prompt (they may reflect the parent-reported brief summary, which is part of the input).
- The date line uses the session recording's `created_at` date.
- Provisional reports add the line `Domain scores are sums of confirmed items only; they are not domain totals.`
- `Mark final` also saves unsaved textarea edits in the same PATCH.
- Extra file `lib/report/draft.ts` (prompt building, filter, number composition) next to the listed
  `lib/report/markdown.ts`, to keep the composer pure.

## Bugs found and fixed

- None reached the browser run. The first test draft had a wrong expected band (fixture total 80 is
  Mild, not Moderate); the test was corrected, not the code.
