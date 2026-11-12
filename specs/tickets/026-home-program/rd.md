# 026: Home program

**Status:** draft
**Mode:** solo
**Runs:** waits for 023, 025: activities link to IEP goals and publish the same way; activity media/attachments use the document vault (023)

## Summary

Providers prescribe a home program - a short list of activities linked to IEP goals, with
instructions, frequency and duration - and publish it to the guardian. Guardians see "today's
activities", mark them done with a quick difficulty rating, and providers see adherence. This is the
main between-session engagement loop for families.

## Functional requirements

- **FR-1** - Migration `<ts>_home_program.sql`:
  - `home_programs(id, case_id, child_id, org_id, plan_id null -> iep_plans, title (1-120), status text check in
    ('draft','published','archived'), version int default 1, created_by, created_at, updated_at)`; one
    `published` program per case (partial unique).
  - `home_activities(id, program_id on delete cascade, goal_id null -> iep_goals, title (1-120),
    instructions_md (1-4000), frequency_per_week int 1-14, duration_min int 1-120, materials (<= 500),
    document_id null -> documents (a picture/PDF guide, 023), sort int, active boolean)`; max 15 active per program.
  - `home_activity_logs(id, activity_id, child_id, logged_by (guardian), done_on date, duration_min null,
    difficulty text check in ('hard','okay','easy'), note (<= 500), created_at, unique (activity_id,
    done_on, logged_by))`.
- **FR-2** - Provider APIs (`requireCaseAccess`): CRUD under `POST /api/cases/:id/home-programs`,
  `PATCH /api/home-programs/:pid` (version-checked, 409), `POST /api/home-programs/:pid/activities`,
  `PATCH|DELETE /api/home-activities/:aid` (delete only in draft; published -> `active = false`).
  `goal_id` must belong to the case's active plan (422 `{ error: "Choose a goal from this child's plan" }`).
- **FR-3** - Publish: `POST /api/home-programs/:pid/publish` `{ version }` -> 200; renders markdown
  (`lib/home-program/markdown.ts`) and calls 024 `publishVersion` (`entity_type = 'home_program'`,
  `visible_to_guardian = true`); archives the previously published program; emits outbox event
  `home_program.published` (032, if merged). Guardians always see the last published snapshot.
- **FR-4** - Provider UI, case workspace `Home program` tab: activity list with fields `Activity`,
  `Linked goal`, `How to do it`, `Times per week`, `Minutes`, `Materials`, `Attach guide`; `Publish to
  parent`; adherence panel: per activity `done <n> of <expected> times in the last 7 days` and last 4
  weeks sparkline, recent guardian notes.
- **FR-5** - Guardian UI `/family/children/[id]/home-program`: `This week` view grouping activities with
  `<done>/<frequency> this week`, instructions, attached guide download (023 access rules), button
  `Done today` opening a sheet: `How did it go?` (`Hard`, `Okay`, `Easy`), optional `Minutes`, optional
  `Note`, `Save`. `POST /api/family/home-activities/:aid/logs` `{ done_on, difficulty, duration_min?,
  note? }` -> 201; same activity+date -> 200 updating the existing log (idempotent); `done_on` in the
  future or > 14 days ago -> 400. `DELETE /api/family/home-activity-logs/:id` (own logs, same week) -> 200.
  Activities not in the published snapshot (or deactivated) -> 404.
- **FR-6** - `lib/home-program/adherence.ts` `adherence(logs, activity, weekStart)`; weeks start Monday
  in the guardian's time zone (018 `getTimeZone`).
- **FR-7** - Sharing scope `home_program` registered (published snapshot + adherence) in the 022 registry.

## Non-functional requirements

- **NFR-1** - Guardian `Done today` works in one tap + one choice on a 375 px phone; offline-safe retry
  (client resends with the same `activity_id + done_on`; server idempotent).
- **NFR-2** - Guardian responses never include draft activities.
- **NFR-3** - Translated UI chrome (en/hi/te); instructions shown as written.

## Affected areas

- `supabase/migrations/<ts>_home_program.sql` (new); `lib/home-program/**` (new)
- `app/api/cases/[id]/home-programs/**`, `app/api/home-programs/**`, `app/api/home-activities/**`,
  `app/api/family/home-activities/**`, `app/api/family/home-activity-logs/**` (new)
- Case workspace `Home program` tab, `app/family/children/[id]/home-program/**` (new)
- `lib/sharing/registry.ts`, `messages/*.json`; `tests/home-program.test.ts` (new)

## Don't touch

- IEP tables/logic (025) except reading, `published_versions` (024), existing migrations, `BOARD.md`

## Out of scope

- Reminders to do activities (could be added on 032 later), video uploads by guardians, gamification,
  activity library/templates, translation of instructions.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Feature kept | Home program | plan §2 old DRnME features |
| D-2 | Guardian view | Published snapshot | rule 9 |
| D-3 | Logging idempotency | One log per activity/day/guardian, upsert | flaky mobile networks |

## Open questions

- Dependency gap: `document_id` / `Attach guide` uses 023, which is not upstream of 026 in the plan.
  If 023 has not merged, omit the column and UI and add them in a small follow-up migration after 023.
