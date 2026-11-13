# 024: Assessment portal and shared clinical contracts - Results

Branch: `ticket/024-assessment-portal-contracts` (base `87571ad`: 017-020, 022, 028, 029 merged). Tested against the
isolated local Supabase stack `dnmslot4` (all 12 migrations applied by `db reset`), `DEMO_MODE=true`, dev server on
port 3040, integrated browser. Accounts from `npm run -s seed:users -- --prefix acct`; synthetic data only. Raw
evidence in `evidence/`: `acceptance.txt` (scripted API/HTML run, 44 checks, all PASS), `vitest-024-verbose.txt` (the
eval test command, 55 tests), `regression-diff.txt`, `migration-on-existing-db.txt`, `browser.txt` + screenshots.

| Check | Result | Evidence |
|-------|--------|----------|
| Migrations `20261113002400_clinical_contracts.sql`, `20261113002401_assessments.sql` | PASS | `db reset` applies all 12. Also applied on top of a populated base DB (seed + one legacy final assessment report + one final parent summary): backfill published 2, re-run 0, `facts_instrument_check` replaced by `facts_instrument_fkey` (added `not valid`, validated, old check dropped) (`migration-on-existing-db.txt`) |
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0; vitest 57 files, 808 passed, 10 skipped (the pre-existing ticket 010 `CT_DB_TESTS` block); every other DB suite ran against slot 4. Baseline before 024: 54 files, 752 passed, 10 skipped - no existing test removed |
| `npx vitest run tests/clinical-contracts.test.ts tests/assessments.test.ts tests/regression-child-dev.test.ts --reporter=verbose` | PASS | 3 files, 55 passed, 0 skipped (`vitest-024-verbose.txt`) |
| Registry loads ISAA / CASE_SHEET / ISAA_PARENT_CHECKIN; unknown instrument fails (FK) | PASS | tests: typed items (ISAA 40 items, red flags 15/29; case sheet fields; check-in 21 items), DB `definition` deep-equals `schemas/*.json`; `insert into facts (... 'MCHAT' ...)` -> `facts_instrument_fkey` violation; `score("ISAA", facts)` equals `scoreIsaa(facts)` |
| `published_versions` update/delete raise; hash = sha256(content_md) | PASS | tests: update, delete, truncate -> `published_versions is append-only`; `service_role` insert -> permission denied (only `publish_version()` writes); hash checked in SQL and TS; versions 1, 2, 3 per entity; case/org/child mismatch rejected; RLS (guardian: visible only; care team: own cases; others: nothing; `authenticated` cannot call `publish_version`) |
| Speaker swap leaves `child` / `other_adult` untouched, still swaps therapist <-> parent | PASS | tests on `swapRole`, `swapSpeakerMap`, `swapSegments`; `SpeakerRoleSchema` accepts the six roles |
| Parent check-in scoring and red-flag detection per band | PASS | tests: totals 0/9 -> `no_strong_signs`, 10/19 -> `discuss_with_professional`, 20/45 -> `see_professional_soon`; each of the 6 red-flag codes `yes` -> `see_professional_soon` at total 0; reverse-worded items; incomplete -> no band + missing ids; every band copy contains `This is a developmental check-in, not a diagnosis.` |
| Regression (DEMO fixtures): intake -> brief, transcribe, speaker swap, extract, ISAA score/band, report draft + finalise, referral packet, parent voice note | PASS | `tests/regression-child-dev.test.ts` drives the real route handlers; baseline captured on the pre-024 code (commit `099bd80`) and deep-equal after 024 incl. every Gemini prompt; `diff .tmp/baseline-3040/baseline.json .tmp/regression-child-dev/actual.json` empty (`regression-diff.txt`) |
| E-1.1 finalise publishes | PASS | seeded case: draft via `POST /api/sessions/:id/report`, `PATCH { status: "final" }` -> 200; one row `entity_type report`, `version 1`, `content_md` = `reports.content_md`, `visible_to_guardian false`, `content_hash` = sha256, `published_by` = the provider (`acceptance.txt`; also DB test) |
| E-1.2 second PATCH | PASS | 409 `Report is final`; still one published row |
| E-1.3 backfill | PASS | `migration-on-existing-db.txt` (2 pre-existing final reports -> exactly 1 version each); test simulating a pre-024 final report (trigger bypassed) -> `backfill_published_reports()` publishes 1, second run 0; `npm run db:check` -> `final reports without a published version: 0` |
| E-2.1 send questionnaire | PASS | provider_a `Assessments` tab, `Send questionnaire` `Parent developmental check-in` to guardian_a due in 7 days -> 201; audit `assessment.assigned`; browser `provider-assessments-tab.png` |
| E-2.2 save and continue later, 422, submit | PASS | 5 answers saved (version 1 -> 2), reload resumes at `Question 6 of 21` (API + browser); submit with missing -> 422 `Please answer all questions` listing the 16 missing ids; all answered -> 200 `submitted` |
| E-2.3 review and share | PASS | provider detail shows score `21 of 45 points`, band and `This is a developmental check-in, not a diagnosis.`; `Mark reviewed` + `Share result with parent` (API and browser form, `provider-review-shared.png`) -> published version `entity_type assessment`, visible; guardian sees the summary on `/family/assessments/[id]`; the reviewer note is never in it |
| E-3 red flag | PASS | `rf_skill_regression` `yes`: 108/112 message immediately (browser, Telugu, `family-redflag-te-375.png`) and auto-saved; audit `assessment.red_flag`; `notifyLater("assessment.red_flag", ...)` logged once (032 not merged: no outbox row, see Deviations); provider list badge `1 red flag`, detail highlights the answer |
| E-4.1 concurrency | PASS | two saves with the same `version`: 200 then 409 (stale), value of the first kept |
| E-4.2 other guardian / other org | PASS | guardian_b page/PUT/submit -> 404; provider_b GET/review/cancel/detail page -> 404; unassigned org member -> 404; revoked guardian link -> 404 on the next request; guardians on provider APIs 403, providers on family APIs 403, anonymous 401 |
| E-4.3 not linked / submit twice | PASS | assigning guardian_b -> 422 `This parent is not linked to the child`; second submit -> 409 `Already submitted`; save after submit -> 409; duplicate open questionnaire -> 409 |
| E-5 docs | PASS | `docs/system-design.md` section 7 "Clinical contracts (ticket 024)" names every module and the `content_md`-is-authoritative rule; `docs/assessments.md` (portal); `docs/sharing.md` (loaders read published versions) |
| FR-6 legacy seeds | PASS | instrument rows seeded by the migration; `npm run -s seed:demo -- --final-report` adds the session's final assessment report (built like the report route from the demo fixture) -> `published versions=1` |
| FR-10 sharing | PASS | `assessments` loader registered (reviewed questionnaires only, SQL-filtered by child + source orgs); `reports` loader now reads the current published version (item id = report id, so 022 links stay valid); provider_b opens a shared summary after guardian_a's grant (`acceptance.txt`) |
| NFR-2 static gates | PASS | new `app/api/cases/[id]/assessments` passes the 022 case-gate scan; new `app/api/family/**` routes and `/family/assessments` pages pass the 019 guardian scans |
| NFR-3 translated, 375 px | PASS | all new UI strings in en/hi/te (`messages/REVIEW.md` regenerated, key + copy-rule test pass); question text stays English (`lang="en"`); guardian form in Telugu at 375 px: `scrollWidth = innerWidth = 375` |

## Deviations

- **Report finalisation publishes through a DB trigger** (`reports_publish_final`, same statement/transaction as the
  status change) instead of the route calling `publishVersion` itself. Every path that makes a report final (PATCH
  route, `seed:demo --final-report`, test fixtures, future code) therefore publishes exactly once; the route sets the
  transaction actor (`setActor`) so `published_by` is the provider. The SQL function `publish_version(jsonb)` is the
  single writer and `publishVersion(tx, input)` (TS) is its wrapper; `service_role` cannot insert directly.
- **Parent summaries** are inserted as `final` by 015, so they are published too (visible to the guardian, per FR-3);
  a regenerated voice-note summary (changed `content_md` of a final row) becomes the next version.
- **Append-only exceptions**: rows are deleted only by the cascade of their case (data deletion, 041), and `child_id`
  follows its case when 020's claim merges a placeholder child into the guardian's child (`cases_child_follow`;
  without this, reports published before a claim would be invisible to the guardian and to sharing). Content,
  hash, version and visibility never change. `published_by` has no FK (provenance survives account deletion).
- **The latest version decides guardian visibility** (`listGuardianVisible`): publishing a hidden version withdraws
  an older visible one. Assessment summaries are always published on review (so the `assessments` share scope has
  a document); `Share result with parent` only sets `visible_to_guardian`.
- **Check-in bands and wording are drafts**: 15 questions (5 reverse-worded), points 0-3, bands 0-9 / 10-19 / 20-45,
  any red flag -> `see_professional_soon`; `age_bands` cover 18-215 months for every question (no age-specific
  items yet). Clinical review pending (rd.md open question). Answer labels (Never ... Always, Yes/No) are translated
  as UI chrome; question text is not.
- **Notifications**: 032 is not on this base, so `notifyLater` (only logs, `[notify:pending-032]`) is used for
  `assessment.assigned` (guardian), `assessment.submitted` and `assessment.red_flag` (care team). Topics added to
  `lib/notify/topics.ts` (`ASSESSMENT_TOPICS`); 032 should enqueue them in the producing transactions.
- **Guardians do not see the score at submit**; they see the published summary once the care team shares it.
- **No consent gate for questionnaires**: answers stay with the treating organisation and no AI or external
  processor touches them (020's feature list has no matching feature). 033's public screen must use
  `screen_result_save` as 020 documents.
- **Extra endpoints**: `GET /api/cases/:id/assessments`, `GET /api/assessments/:id`, `POST /api/assessments/:id/cancel`;
  duplicate open questionnaire (same template + guardian) -> 409. `due_on` must be today or later (India) and within
  a year.
- **Speaker labels**: the session transcript (`AudioTranscript`) now shows the translated contract labels
  (`Clinician`, `Parent or caregiver`, ...); prompts still use the stored values, so model input is unchanged.
- **Existing tests touched** (contract changes only): `tests/report.test.ts` (authz mock gains `requireReportActor`),
  `tests/sharing-grants.test.ts` (registry now lists `reports` and `assessments`), `tests/fixtures.test.ts`
  (`parseArgs` gains `finalReport`).

## Notes

- **For 025/026/039/040 (published versions):** call `publishVersion(tx, { entityType, entityId, caseId, contentMd,
  visibleToGuardian, publishedBy })` inside the transaction that changes the plan/program/prescription; read with
  `getLatestPublished` / `listGuardianVisible` (guardian) and register a share loader that joins the live entity
  (see `lib/sharing/loaders/assessments.ts`). 039 adds signing on top (extra columns or a signature table; keep the
  row append-only).
- **For 033:** `lib/clinical/checkin.ts` (`CHECKIN`, `scoreCheckin`, `checkinRedFlags`, `URGENT_COPY`,
  `CHECKIN_DISCLAIMER`) and `schemas/isaa-parent-checkin.json` are the parent question set; `getInstrument("ISAA_PARENT_CHECKIN")`
  gives the generic item view.
- **For 035/038:** reserved report kinds are in `lib/clinical/reports.ts`; extend the `reports.kind` check in your
  migration and set `inUse: true`. Speaker roles: `lib/clinical/speakers.ts` (`child`, `other_adult` available).
- **New helpers:** `lib/authz.ts` `requireReportActor`, `requireAssessmentActor`; `lib/assessments/*`;
  `lib/clinical/*`; SQL `publish_version`, `backfill_published_reports`, `cases_child_follow`. Global template id
  `00000000-0000-4000-8024-000000000001` (`PARENT_CHECKIN_TEMPLATE_ID`).
- **Seed / ops:** `npm run -s seed:demo -- --final-report`; `npm run db:check` reports final reports without a
  published version (expected 0). `UPDATE_REGRESSION_BASELINE=1` rewrites the regression baseline (only on a
  commit before a deliberate behaviour change).
- No new env vars, no new dependencies.
- The integrated browser reported a hydration warning (`caret-color` style) caused by its own screenshot tooling,
  not by the app.
