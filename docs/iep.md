# IEP plans, SMART goals and progress (ticket 025)

Providers write an individualised plan (IEP) per case with SMART goals by developmental domain, record progress
data points per goal and publish the plan to the guardian. Guardians, other organisations (share scope `iep`) and
later the follow-up agent (040) only ever see **published snapshots** of the plan text; progress values are live
(decision D-3). Built on 022 (case access, care team, sharing grants), 024 (published versions) and 032 (outbox).

## Model (`supabase/migrations/20261113002500_iep.sql`)

| Table | What |
|-------|------|
| `iep_plans` | `case_id`, `child_id`, `org_id` (copied from the case by trigger `iep_plans_match_case`; `child_id` follows the case on a 020 claim merge, trigger `cases_iep_child_follow`), `title` (1-120), `start_date`, `review_date` (on/after start, at most 12 months later), `status` `draft` / `active` / `completed` / `archived`, `version` (optimistic concurrency, D-4), `created_by`. **At most one `active` plan per case** (partial unique index `iep_plans_one_active_per_case`). |
| `iep_goals` | `plan_id` (cascade), `domain` (`communication`, `social`, `behaviour`, `fine_motor`, `gross_motor`, `self_care`, `cognitive`, `sensory`, `academic`), `statement` (10-500), `specific` / `measurable` / `achievable` / `relevant` / `time_bound` (3-300 each, all required), `measure_type` (`percent`, `count`, `rating_1_5`, `yes_no`), `baseline_value`, `target_value`, `target_date`, `status` `active` / `achieved` / `discontinued`, `sort`. Baseline and target must fit the measure (check constraints via `iep_value_in_range`). |
| `goal_progress` | `goal_id` (cascade), `recorded_by`, `observed_on` (not in the future, India), `value` (fits the goal's measure: trigger `goal_progress_check_value`), `note` (<= 500, care team only), `source` `manual` / `ai_suggested_confirmed` (038), `recording_id` (038; must be a recording of the same case). |
| `iep_publications` | One row per published version of a plan (`published_version_id` = `published_versions.id`): the published `title` and a `goals` jsonb snapshot (`id, domain, statement, measure_type, baseline_value, target_value, target_date, status, sort`). Guardian charts and shared views take goal wording from here, never from the live (possibly edited) `iep_goals`. No FK to `published_versions` (keeps 024's append-only truncate guard); both rows are written in one transaction and go only with their case. |

Value ranges (`lib/iep/schema.ts` `valueInRange`, repeated in SQL): `percent` 0-100, `rating_1_5` 1-5, `yes_no` 0 or
1, `count` >= 0. Max 20 goals per plan. A goal's target date lies between the plan's start and review dates
(changing the plan dates so a goal falls outside -> 422).

RLS (browser reads only): the case's care team (`can_access_case`) reads all four tables; guardians and other
organisations read nothing directly (NFR-1); no client writes.

## Access

- Providers: 022 case access. `requireCaseActor(caseId)` for `/api/cases/:id/iep-plans`,
  `requireIepPlanActor(planId)` (`lib/authz.ts`) for `/api/iep-plans/:planId/**`, `requireIepGoalActor(goalId)` for
  `/api/iep-goals/:goalId/**`. Missing, malformed and other tenants' ids -> 404; guardians -> 403; anonymous -> 401.
- Guardians: `requireGuardian()` + `requireChildGuardian(childId)` (active link to a live child, else 404).
- Other organisations: only through an `iep` sharing grant (read only, `Shared with us` tab).

## API

| Route | Body | Answer |
|---|---|---|
| `GET /api/cases/:id/iep-plans` | - | 200 `{ plans: PlanSummary[] }` (active first, then newest; `published`, `has_unpublished_changes`, `goal_count`) |
| `POST /api/cases/:id/iep-plans` | `{ title, start_date, review_date }` | 201 `{ plan }` (`draft`, `version 1`) |
| `GET /api/iep-plans/:planId` | - | 200 `{ plan, goals: GoalWithProgress[], published_md }` (goals with `progress` and `trend`) |
| `PATCH /api/iep-plans/:planId` | `{ title?, start_date?, review_date?, status?: "completed" \| "archived", version }` | 200 `{ plan }`; stale -> 409 `{ error: "This plan was changed by someone else. Reload to see the latest version.", details: { version } }`; closed plan / bad transition -> 409; goal dates outside -> 422 |
| `POST /api/iep-plans/:planId/publish` | `{ version }` | 200 `{ published_version, published_at, plan, archived_plan_id }`; 409 stale / closed / `There are no changes to publish`; 422 no goals |
| `GET /api/iep-plans/:planId/goals` | - | 200 `{ goals }` |
| `POST /api/iep-plans/:planId/goals` | all goal fields + plan `version` | 201 `{ goal, plan_version }`; 400 field errors (e.g. missing `measurable`, target date outside the plan); 422 more than 20 goals |
| `PATCH /api/iep-goals/:goalId` | any goal field, `status`, `sort`, plan `version` | 200 `{ goal, plan_version }`; 409 stale / closed / measure change after progress |
| `DELETE /api/iep-goals/:goalId?version=` | - | draft plan: 200 `{ deleted: true, goal: null }`; active plan: 200 `{ deleted: false, goal }` (`discontinued`, progress kept); closed: 409 |
| `GET /api/iep-goals/:goalId/progress` | - | 200 `{ progress }` (oldest first) |
| `POST /api/iep-goals/:goalId/progress` | `{ observed_on, value, note? }` | 201 `{ entry, trend }`; future date or value outside the measure -> 400; closed plan / discontinued goal -> 409 |
| `GET /api/family/children/:id/plan` | - | 200 `{ plans: PublishedPlanView[] }` (latest published plan per organisation, newest first) |

Every plan or goal write bumps the plan `version` and must send the version it was based on (D-4). Progress entries
do not bump it (they are observations, not plan wording). Plans in `completed` / `archived` are read only.

Audit (`audit_events`, entity `iep_plan` / `iep_goal` / `goal_progress`, actor `therapist`, same transaction as the
change): `iep.plan_created`, `iep.plan_updated`, `iep.plan_completed`, `iep.plan_archived` (also with
`reason: "replaced"` when another plan of the case is published), `iep.goal_added`, `iep.goal_updated`,
`iep.goal_deleted`, `iep.goal_discontinued`, `iep.progress_recorded`, `iep.published`. Details hold ids, field
names and dates, never goal text or values.

## Publishing (FR-4)

`publishPlan` (one transaction, case row locked so publishes of one case serialise):

1. checks the plan `version`, that it is `draft` or `active` and has at least one goal;
2. renders the markdown (`lib/iep/markdown.ts` `iepPlanMarkdown`: title, dates, goals grouped by domain in registry
   order with the five SMART texts, `How we measure`, `Baseline to target`, non-active goal status; provider text is
   escaped so it cannot change the document structure; plan status is not part of the document);
3. refuses an identical republish (`There are no changes to publish`);
4. archives the case's other active plan, sets this plan `active` (version + 1);
5. `publishVersion(tx, { entityType: "iep_plan", visibleToGuardian: true, ... })` (024), the `iep_publications`
   snapshot, audit `iep.published` and outbox `iep.published` (`{ plan_id, child_id, case_id }`, dedup
   `iep:<plan id>:v<published version>`); the route calls `drainSoon`.

`Unpublished changes` = the plan has a published version and the current plan renders to a different
`content_hash`. Later edits to an active plan therefore show the badge and `Publish changes`; the guardian keeps
the last published snapshot until then.

## Progress summary (FR-7)

`lib/iep/progress.ts` `goalTrend(points, goal)` -> `{ latest, change_from_baseline, percent_to_target, on_track }`:
latest = most recent observation; change = latest - baseline; percent = share of the baseline -> target distance
covered (rounded, clamped 0-100; works for decreasing targets); `on_track` is `null` with fewer than 2 points, else
true when the target is reached or the least-squares slope of the last 5 observations points towards the target.

## UI

- Provider: case workspace `Goals` tab (`app/cases/[id]/goals`, `components/iep/GoalsPanel.tsx`): plan picker
  (`?plan=<id>`), `Create a plan`, plan header (title, dates, status, `Unpublished changes`, `Publish to parent` /
  `Publish changes`, `Edit plan`, `Mark completed`, `Archive`), goals with SMART text, `Record progress` inline form,
  chart + trend text, `Edit goal`, `Mark achieved`, `Delete goal` (draft) / `Discontinue goal` (active), `Add goal`
  with labelled fields `Domain`, `Goal`, `Specific`, `Measurable`, `Achievable`, `Relevant`, `Time-bound`,
  `How we measure`, `Baseline`, `Target`, `Target date`. A 409 shows the reload message with a `Reload` button.
- Guardian: `/family/children/[id]/plan` (linked from the child page as `Plan and goals`): per organisation the
  published plan markdown, then per published goal its trend text and live chart. Empty state `Your child's
  therapist has not shared a plan yet.` Progress notes are not shown to guardians.
- Charts (`components/iep/ProgressChart.tsx`): inline SVG, no chart library, baseline (grey dashed) and target
  (green dashed) lines, `role="img"` with a `<title>`, and a `<details>` `Show data` table (NFR-2).
- UI chrome is translated (en/hi/te, namespace `iep`); goal and plan text are shown as written (NFR-3).

## Sharing (FR-8)

Share scope `iep` (`lib/sharing/loaders/iep.ts`): the latest published version of each plan of the source
organisations' cases for the child (item id = plan id, title = published title). The item body is the published
markdown followed by `## Progress` with one `Date | Value` table per published goal (live values, no notes).

## For later tickets

- **026 home program**: link activities to goals with `listPlanGoals(planId)` / `getPlanDetail(planId)`
  (`lib/iep`); the case's active plan is `listCasePlans(caseId).find((p) => p.status === "active")`.
- **038 AI scribe**: after a provider confirms an AI suggestion, call
  `recordProgress({ goalId, actorUserId, observedOn, value, note, source: "ai_suggested_confirmed", recordingId })`
  (value range, case of the recording and plan state are checked; returns `{ ok, entry, trend }` or a `Failure`).
  AI suggestions themselves need the consent gate of the feature that produces them (`docs/consent.md`); 025 has no
  AI path.
- **040 follow-up agent**: plan text = `listGuardianVisible(sql, childId, "iep_plan")` (024) or
  `getGuardianPlans(childId)` (adds the goal snapshot and live progress).

Tests: `tests/iep.test.ts` (validation, `goalTrend`, markdown, chart, UI), `tests/iep-access.test.ts` (database:
routes, publishing, concurrency, authz, sharing, RLS).
