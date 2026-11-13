# 025: IEP plans, SMART goals and progress tracking

**Status:** done
**Mode:** solo
**Runs:** waits for 022, 024: plans are case-scoped, use assignments and register the `iep` sharing scope (publishing uses 024's `publishVersion` - see Open questions); publishVersion and the shared clinical contracts (024)

## Summary

Providers write an individualised plan (IEP) per case with SMART goals by developmental domain, record
progress data points per goal, and publish the plan to the guardian. Guardians see the published plan
and simple progress charts. Published snapshots are the only version guardians and the follow-up agent
(040) ever see.

## Functional requirements

- **FR-1** - Migration `<ts>_iep.sql`:
  - `iep_plans(id, case_id, child_id, org_id, title (1-120), start_date, review_date, status text check in
    ('draft','active','completed','archived'), version int not null default 1, created_by, created_at,
    updated_at)`; at most one `active` plan per case (partial unique index).
  - `iep_goals(id, plan_id -> iep_plans on delete cascade, domain text check in ('communication',
    'social','behaviour','fine_motor','gross_motor','self_care','cognitive','sensory','academic'),
    statement (10-500), specific, measurable, achievable, relevant, time_bound (each 3-300 text),
    baseline_value numeric, target_value numeric, measure_type text check in ('percent','count',
    'rating_1_5','yes_no'), target_date date, status text check in ('active','achieved','discontinued')
    default 'active', sort int)`.
  - `goal_progress(id, goal_id, recorded_by, observed_on date, value numeric, note (<= 500), source text
    check in ('manual','ai_suggested_confirmed') default 'manual', recording_id null -> recordings,
    created_at)`.
- **FR-2** - Validation (`lib/iep/schema.ts`): all five SMART fields required; `target_date` between
  `start_date` and `review_date`; `review_date` <= `start_date + 12 months`; value ranges by measure
  type (`percent` 0-100, `rating_1_5` 1-5, `yes_no` 0/1, `count` >= 0). Max 20 goals per plan.
- **FR-3** - Provider APIs (`requireCaseAccess`): `POST /api/cases/:id/iep-plans` -> 201;
  `PATCH /api/iep-plans/:planId` `{ ...fields, version }` (stale -> 409 `{ error: "This plan was changed
  by someone else. Reload to see the latest version." }`); `POST /api/iep-plans/:planId/goals`,
  `PATCH /api/iep-goals/:goalId`, `DELETE /api/iep-goals/:goalId` (draft plans only; active plans ->
  `discontinued` instead); `POST /api/iep-goals/:goalId/progress` `{ observed_on, value, note? }` -> 201
  (future date -> 400). Audit `iep.*` events.
- **FR-4** - Publish: `POST /api/iep-plans/:planId/publish` `{ version }` -> 200 `{ published_version }`:
  sets `status = 'active'` (archiving a previous active plan for the case), renders the plan to markdown
  (`lib/iep/markdown.ts`: title, dates, goals grouped by domain with SMART text, baseline -> target) and
  calls `publishVersion` (`entity_type = 'iep_plan'`, `visible_to_guardian = true`). Later edits to an
  active plan bump `version`; the guardian keeps seeing the last published snapshot until republished.
  Emits outbox event `iep.published` (032, if merged).
- **FR-5** - Provider UI, case workspace `Goals` tab: plan header (title, dates, status, `Publish to
  parent` / `Publish changes`), `Add goal` form with labelled fields `Domain`, `Goal`, `Specific`,
  `Measurable`, `Achievable`, `Relevant`, `Time-bound`, `How we measure`, `Baseline`, `Target`,
  `Target date`; per goal a `Record progress` inline form and a small SVG line chart (no chart library)
  with baseline and target lines; `Unpublished changes` badge when draft differs from published.
- **FR-6** - Guardian UI `/family/children/[id]/plan`: latest published plan per organisation
  (rendered from `published_versions.content_md`), each goal with its live progress chart (D-3),
  empty state `Your child's therapist has not shared a plan yet.`
- **FR-7** - `lib/iep/progress.ts` `goalTrend(points, goal)` returns `{ latest, change_from_baseline,
  percent_to_target, on_track: boolean | null }` (null with < 2 points); shown as text next to charts.
- **FR-8** - Sharing: register scope `iep` (published plans + progress) in the 022 registry.

## Non-functional requirements

- **NFR-1** - Guardian never sees draft plan text; tests assert API responses for guardians contain only
  published content.
- **NFR-2** - Charts accessible: each chart has a text table alternative (`<details>` `Show data`).
- **NFR-3** - Translated UI chrome (en/hi/te); goal text shown as written.

## Affected areas

- `supabase/migrations/<ts>_iep.sql` (new); `lib/iep/**` (new)
- `app/api/cases/[id]/iep-plans/**`, `app/api/iep-plans/**`, `app/api/iep-goals/**` (new)
- `app/api/family/children/[id]/plan/route.ts`, `app/family/children/[id]/plan/**` (new)
- Case workspace `Goals` tab components (new); `lib/sharing/registry.ts`; `messages/*.json`
- `tests/iep.test.ts`, `tests/iep-access.test.ts` (new)

## Don't touch

- `published_versions` schema and `publishVersion` (024 - use only), existing migrations, `BOARD.md`

## Out of scope

- AI-suggested goals; AI progress from session recordings (038 adds `ai_suggested_confirmed` entries);
  goal banks/templates; school IEP document formats; guardian-entered progress (home program logs are 026).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Feature kept | IEP/SMART goals + progress | plan §2 old DRnME features |
| D-2 | Guardian view | Published snapshot only | rule 9 |
| D-3 | Progress data | Live (not snapshotted); plan text snapshotted | progress points are factual observations, not plan wording |
| D-4 | Concurrency | `version` optimistic locking | multiple providers per case (022) |

## Open questions

- Dependency gap: FR-4 uses `publishVersion` from 024, but the plan lists 025 <- 022 only. Run 025
  after 024 merges, or move `published_versions` into 022. Recommended: treat 024 as a prerequisite.
