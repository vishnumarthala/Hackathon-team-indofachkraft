# 025: IEP plans, SMART goals and progress tracking - Results

Branch: `ticket/025-iep-goals-progress` (base `3c8e272`: 017-024, 028, 029, 032 merged). Tested against the isolated
local Supabase stack `dnmslot4` (all 17 migrations applied by `db reset`), `DEMO_MODE=true`, dev server on port 3040,
own headless Chromium (playwright-core + cached chrome-headless-shell; not the shared browser). Accounts from
`npm run -s seed:users -- --prefix acct --extra-member`; synthetic data only. Raw evidence in `evidence/`:
`acceptance.txt` (scripted API/HTML run, 42 checks, all PASS), `browser.txt` + screenshots, `vitest-025-verbose.txt`
(the eval test command, 31 tests).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002500_iep.sql` | PASS | `db reset` applies all 17. New tables only (`iep_plans`, `iep_goals`, `goal_progress`, `iep_publications`), so nothing to backfill; RLS on, care team read only |
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0; new routes in the build (`/cases/[id]/goals`, `/family/children/[id]/plan`, `/api/iep-plans/**`, `/api/iep-goals/**`). The Turbopack "dynamic filesystem access" warning is pre-existing (`lib/demo.ts`) |
| `npx vitest run` | PASS | 65 files, 961 passed, 10 skipped (the pre-existing ticket 010 `CT_DB_TESTS` block); every other DB suite ran against slot 4. Two consecutive full runs green after the flake fix below |
| `npx vitest run tests/iep.test.ts tests/iep-access.test.ts --reporter=verbose` | PASS | 2 files, 31 passed, 0 skipped (`vitest-025-verbose.txt`): FR-2 validation per measure type, SMART fields, plan/target dates; `goalTrend` with 0/1/2+ points and decreasing targets; markdown rendering and escaping; chart + `Show data`; single active plan per case (archive on publish, unique index); guardian responses without draft text; version conflicts; authz; `iep` share loader; outbox event; RLS |
| E-1.1 create plan, add goal, missing `Measurable` | PASS | `acct Term 1` -> 201 draft v1; goal without `measurable` -> 400 `details.measurable`; Communication goal (count, baseline 1, target 5, target date + 90 days) -> 201. Browser: field error `Fill in this field (3 to 300 characters).` with `aria-invalid` (`provider-add-goal-missing-measurable.png`) |
| E-1.2 publish, guardian view | PASS | `Publish to parent` -> 200 `{ published_version: 1 }`, plan `active`; outbox `iep.published` committed in the publish transaction, fanned out (drainSoon) to guardian_a only, link `/family/children/<id>/plan`; guardian page shows the plan text |
| E-1.3 unpublished edit, republish | PASS | goal statement edited: Goals tab shows `Unpublished changes` + `Publish changes`; guardian page/API keep the old text, no draft text; republish -> version 2, guardian sees the new text; `published_versions` versions `[1, 2]` (browser: `provider-goals-tab.png`, then `Publish changes` clicked in the UI clears the badge) |
| E-2 progress | PASS | values 1, 2, 3 on three past dates -> 201 each; provider and guardian charts have 3 points + baseline and target lines; `On track`; `Show data` tables list 1, 2, 3 (provider also shows notes, guardian never); future date -> 400 `The date cannot be in the future` |
| E-3 concurrent edit | PASS | provider_a and provider_a2 PATCH from version 5: 200 then 409 `This plan was changed by someone else. Reload to see the latest version.` |
| E-4.1 other org | PASS | provider_b: plan API 404; after guardian_a's `iep` grant the plan appears under `Shared with us` (published title and text + live progress table, no notes, no edit controls; audit `sharing.viewed`); PATCH plan/goal still 404 (`provider-b-shared-iep.png`) |
| E-4.2 other guardian / unassigned member | PASS | guardian_b: plan API and page 404; provider_a2 unassigned (before assignment and after removal) -> 404 |
| E-4.3 guardian on provider APIs | PASS | GET plan, POST plan, POST progress -> 403; anonymous -> 401 |
| FR-6 empty state | PASS | child without a published plan: `Your child's therapist has not shared a plan yet.` |
| FR-8 sharing scope | PASS | `iep` loader registered (`lib/sharing/loaders/iep.ts`); `tests/sharing-grants.test.ts` updated (5 loaders; `iep` now available) |
| NFR-1 guardian sees published content only | PASS | API/page tests assert draft statement and SMART text never appear; goal wording comes from the `iep_publications` snapshot; notes excluded |
| NFR-2 accessible charts | PASS | SVG `role="img"` + `<title>`; `<details>` `Show data` table with caption |
| NFR-3 translated, 375 px | PASS | all chrome in en/hi/te (namespace `iep`, `caseTabs.goals`; `messages/REVIEW.md` regenerated, 1433 rows); goal text as written; guardian page in English and Telugu at 375 px: `scrollWidth = innerWidth = 375` (`family-plan-te-375.png`, `family-plan-en-375.png`) |
| Static gates | PASS | new `app/api/cases/[id]/iep-plans` passes the 022 case-gate scan; `app/api/family/children/[id]/plan` and the `/family` plan page pass the 019 guardian scans |

## Deviations

- **Goal snapshot table `iep_publications`** (not in FR-1): the published markdown alone cannot drive the guardian's
  per-goal charts without exposing live (possibly unpublished) goal wording. Each publish stores the published title
  and a goal snapshot next to `publishVersion`, in the same transaction. It has no FK to `published_versions` so 024's
  append-only truncate guard keeps raising its own error (a FK made `truncate published_versions` fail with a FK error
  instead, breaking `tests/clinical-contracts.test.ts`).
- **Plan `version` covers goals too**: every plan or goal write must send the plan version and bumps it (D-4, "later
  edits to an active plan bump version"); progress entries do not. `DELETE /api/iep-goals/:id` takes it as optional
  `?version=`.
- **`Unpublished changes`** = the current plan renders to a different `content_hash` than the latest published
  version (edit-and-revert shows no badge). Republishing identical content -> 409 `There are no changes to publish`.
- **Extra endpoints**: `GET /api/cases/:id/iep-plans`, `GET /api/iep-plans/:planId`, `GET /api/iep-plans/:planId/goals`,
  `GET /api/iep-goals/:goalId/progress`; plan status `completed` / `archived` via PATCH (`active` only by publishing);
  closed plans are read only (409). Goal `baseline_value`, `target_value`, `target_date` are required (SMART goals
  need them; FR-1 left them nullable) and the target must differ from the baseline.
- **Progress notes stay with the care team**: guardians and other organisations see dates and values only.
- **Guardian view = latest published plan per organisation**, even if the provider later archives it (no withdraw flow
  in scope). The published document is English chrome around the provider's text (like 024's summaries).
- **No AI goal suggestions** (out of scope in rd.md), so no Gemini call and no new consent feature. 038 records
  confirmed suggestions through `recordProgress({ source: "ai_suggested_confirmed", recordingId })`; its own consent
  gate applies.
- **`iep_published` notification link** now opens `/family/children/<id>/plan` (was the child page);
  `tests/outbox.test.ts` expectation updated.
- **Pre-existing flaky assertion fixed**: `tests/clinical-contracts.test.ts` (backfill) counted every final report in
  the database, so it failed when `tests/sharing-grants.test.ts` (which publishes v2 of its report) ran in parallel
  (2 of 4 full runs before the fix). The check is now scoped to the suite's own case.

## Notes

- **For 026 (home program):** `listCasePlans(caseId)` (active plan first), `getPlanDetail(planId)`, `listPlanGoals(planId)`
  in `lib/iep`; goal ids are stable across publishes.
- **For 038 (AI scribe):** `recordProgress({ goalId, actorUserId, observedOn, value, note, source: "ai_suggested_confirmed",
  recordingId })` checks the measure range, plan state and that the recording belongs to the same case; returns
  `{ ok, entry, trend }` or a typed `Failure`. Gate with `requireIepGoalActor` (or case access) first.
- **For 040 (follow-up agent):** published plan text via `listGuardianVisible(sql, childId, "iep_plan")` or
  `getGuardianPlans(childId)` (adds the goal snapshot and live progress).
- **New helpers:** `lib/authz.ts` `requireIepPlanActor`, `requireIepGoalActor`; `lib/iep/{schema,markdown,progress,index}.ts`;
  `components/iep/{GoalsPanel,ProgressChart,view}`; SQL `iep_value_in_range`, `iep_plans_match_case`,
  `iep_plans_child_follow`, `goal_progress_check_value`.
- No new env vars, no new dependencies. Docs: `docs/iep.md` (new), `docs/system-design.md`, `docs/sharing.md`,
  `docs/notifications.md`.
