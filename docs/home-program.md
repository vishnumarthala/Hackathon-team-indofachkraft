# Home program (ticket 026)

Providers prescribe a short list of activities for the family to practise at home between sessions (linked to IEP
goals of the case's active plan, ticket 025), publish it to the guardian, and see adherence. Guardians see `This week`,
tap `Done today`, rate how it went and may add minutes and a note. Built on 022 (case access, care team, sharing
grants), 023 (document vault: guides), 024 (published versions), 025 (IEP goals), 032 (outbox) and 018 (time zones).

## Model (`supabase/migrations/20261113002600_home_program.sql`)

| Table | What |
|-------|------|
| `home_programs` | `case_id`, `child_id`, `org_id` (copied from the case by trigger `home_programs_match_case`; `child_id` follows the case on a 020 claim merge, trigger `cases_home_program_child_follow`), `plan_id` (the case's IEP plan when created / when a goal is linked; must be a plan of the same case), `title` (1-120), `status` `draft` / `published` / `archived`, `version` (optimistic concurrency), `created_by`. **At most one `published` program per case** (partial unique index `home_programs_one_published_per_case`). |
| `home_activities` | `program_id` (cascade), `goal_id` (-> `iep_goals`, null), `title` (1-120), `instructions_md` (1-4000), `frequency_per_week` (1-14), `duration_min` (1-120), `materials` (<= 500), `document_id` (-> `documents`, a picture/PDF guide), `sort`, `active`. **At most 15 active activities per program** (trigger `home_activities_check_active_limit`, also checked in `lib/home-program` under the program row lock). |
| `home_activity_logs` | `activity_id` (cascade), `child_id` (= the program's child, trigger), `logged_by` (the guardian), `done_on` (date as the guardian saw it), `duration_min` (1-240, null), `difficulty` `hard` / `okay` / `easy`, `note` (<= 500), `created_at`, `updated_at`. **Unique (`activity_id`, `done_on`, `logged_by`)**: the API upserts on it (D-3). |
| `home_program_publications` | One row per published version (`published_version_id` = `published_versions.id`, no FK, like 025's `iep_publications`): the published `title` and an `activities` jsonb snapshot (`id, goal_id, goal_statement, title, instructions_md, frequency_per_week, duration_min, materials, document_id, sort`). Guardian views and the guardian logging check use only this snapshot. |

RLS (browser reads only): the case's care team (`can_access_case`) reads all four tables; guardians and other
organisations read nothing directly; no client writes.

## Access

- Providers: 022 case access. `requireCaseActor(caseId)` for `/api/cases/:id/home-programs`;
  `requireHomeProgramActor(pid)` / `requireHomeActivityActor(aid)` (`lib/home-program/authz.ts`) for the program and
  activity routes. Missing, malformed and other tenants' ids -> 404; guardians -> 403; anonymous -> 401.
- Guardians: `requireGuardian()` first, then `requireGuardianActivity(aid, session)`: the activity must be active and in
  the snapshot of its program's latest published version, the program must be the case's current `published` one,
  and the guardian needs an active link to the child. Anything else (draft, unpublished, stopped, archived, another
  family's child) -> 404 `Activity not found`.
- Other organisations: only through a `home_program` sharing grant (read only, `Shared with us` tab).

## API

| Route | Body | Answer |
|---|---|---|
| `GET /api/cases/:id/home-programs` | - | 200 `{ programs: ProgramSummary[] }` (published first; `published`, `has_unpublished_changes`, `activity_count`) |
| `POST /api/cases/:id/home-programs` | `{ title }` | 201 `{ program }` (`draft`, `version 1`, `plan_id` = the case's active plan or null) |
| `GET /api/home-programs/:pid` | - | 200 `ProgramDetail` `{ program, activities (incl. stopped, with live goal text and guide title), published_md, adherence, time_zone, today }` |
| `PATCH /api/home-programs/:pid` | `{ title?, status?: "archived", version }` | 200 `{ program }`; stale -> 409 `This home program was changed by someone else. Reload to see the latest version.` `{ details: { version } }`; archived -> 409 |
| `POST /api/home-programs/:pid/activities` | `{ title, instructions_md, frequency_per_week, duration_min, materials?, goal_id?, document_id?, version? }` | 201 `{ activity, program_version }`; goal not in the case's active plan (or discontinued) -> 422 `{ error: "Choose a goal from this child's plan" }`; guide not a ready, parent-visible provider document of the same case -> 422; 16th active activity -> 422 |
| `PATCH /api/home-activities/:aid` | any activity field, `sort`, `active`, `version?` | 200 `{ activity, program_version }` (goal/guide re-checked only when changed) |
| `DELETE /api/home-activities/:aid?version=` | - | draft program: 200 `{ deleted: true, activity: null }`; published program: 200 `{ deleted: false, activity }` (`active = false`, logs kept) |
| `POST /api/home-programs/:pid/publish` | `{ version }` | 200 `{ published_version, published_at, program, archived_program_id }`; 409 stale / archived / `There are no changes to publish`; 422 no active activities |
| `GET /api/family/children/:id/home-program` | - | 200 `{ programs: GuardianHomeProgram[], my_logs }` (this week, guardian's time zone) |
| `POST /api/family/home-activities/:aid/logs` | `{ done_on, difficulty, duration_min?, note? }` | 201 `{ log, created: true }`; same activity + date again -> 200 updating the guardian's log (`created: false`); `done_on` in the future or more than 14 days ago -> 400; not in the published snapshot -> 404 |
| `DELETE /api/family/home-activity-logs/:id` | - | own log of the current week -> 200 `{ deleted: true }`; another guardian's / missing -> 404; earlier week -> 409 `Only this week's entries can be removed` |

Program and activity writes bump the program `version`. `PATCH` program and publish must send it; activity writes
may (the UI always does). Guardian logs never change it. Archived programs are read only.

Audit (`audit_events`, same transaction): `home_program.created`, `.updated`, `.archived` (also `reason: "replaced"`
when another program of the case is published), `.activity_added`, `.activity_updated`, `.activity_deleted`,
`.activity_stopped`, `.published` (actor `therapist`), `home_program.log_deleted` (actor `parent`). Details hold
ids, field names and dates, never activity text or notes. Saving a log is not audited (it is the guardian's own
entry and retries would repeat it).

## Publishing (FR-3)

`publishProgram` (one transaction, case row locked so publishes of one case serialise):

1. checks the `version`, that the program is not archived and has at least one active activity;
2. renders the markdown (`lib/home-program/markdown.ts` `homeProgramMarkdown`: title, then per active activity its
   title, `Linked goal` (the goal's **published** wording from the latest 025 `iep_publications` snapshot that
   contains it; a goal not published yet is left out), `How often`, `Materials`, `Guide`, and `How to do it` (the
   provider's markdown with headings flattened; titles escaped));
3. refuses an identical republish (`There are no changes to publish`);
4. archives the case's other `published` program, sets this one `published` (version + 1);
5. `publishVersion(tx, { entityType: "home_program", visibleToGuardian: true, ... })` (024), the
   `home_program_publications` snapshot, audit `home_program.published` and outbox `home_program.published`
   (`{ program_id, child_id, case_id }`, dedup `home_program:<program id>:v<published version>`); the route calls
   `drainSoon`. The notification links to `/family/children/<child id>/home-program`.

`Unpublished changes` = the program has a published version and the current program renders to a different
`content_hash`. Guardians keep the last published snapshot until `Publish changes`. Exception: **stopping** an
activity (`DELETE` on a published program, or `active: false`) hides it from guardians at once (and logging against
it -> 404); restarting it shows it again if it is in the snapshot.

## Adherence (FR-6)

`lib/home-program/adherence.ts` (pure): `adherence(logs, activity, weekStart)` -> `{ week_start, week_end, done,
expected, percent, met }` for the Monday-start week containing `weekStart`; `weekStartFor(now, timeZone)`,
`todayIn(timeZone, now)`, `lastSevenDays(logs, activity, today)`, `weeklySeries(logs, activity, today, 4)`.
`done` counts log rows, so two guardians who both log a day count twice (frequency can be up to 14 a week).

Time zones: the guardian routes and page use the viewer's zone (018 `getTimeZone()`, browser cookie, fallback
`Asia/Kolkata`) for "today", the 14-day window and "this week". The provider panel and the share scope use the
child's guardian zone (`childTimeZone(childId)`: the earliest active guardian's saved `user_profiles.time_zone`, else
`Asia/Kolkata`) and say so (`Weeks start on Monday in the family's time zone (...)`).

## UI

- Provider: case workspace `Home program` tab (`app/cases/[id]/home-program`, `components/home-program/HomeProgramPanel.tsx`):
  program picker (`?program=<id>`), `Create a home program`, header (status, `Unpublished changes`, `Publish to parent` /
  `Publish changes`, `Rename`, `Archive`), activities with `Edit`, `Delete` (draft) / `Stop activity` /
  `Restart activity`, `Add activity` with labelled fields `Activity`, `Linked goal` (goals of the active plan),
  `How to do it`, `Times per week`, `Minutes`, `Materials`, `Attach guide` (the case's ready, parent-visible provider
  documents; upload them in the `Documents` tab). Once published, each activity shows the adherence panel:
  `done <n> of <expected> times in the last 7 days`, a last-4-weeks sparkline (`Sparkline.tsx`, inline SVG with an
  accessible name listing every week) and recent guardian notes.
- Guardian: `/family/children/[id]/home-program` (linked from the child page as `Home activities`): per published
  program `This week` with the date range, activities grouped by linked goal, `<done>/<frequency> this week`,
  how often, materials, instructions as written (`Instructions.tsx`: markdown, no HTML, no images), `Download guide`
  (`/api/documents/<id>/download`, 023 access check + audit; shown only while the document is still ready and
  parent-visible), `Done today` (`DoneToday.tsx`): a sheet `How did it go?` (`Hard`, `Okay`, `Easy`), optional
  `Minutes` and `Note`, `Save`; `Your entries this week` with `Remove`.
- Offline-safe (NFR-1, `components/home-program/logQueue.ts`): the client retries the same body; when the phone is
  offline the log is kept in `localStorage` (`dnm.homeProgram.pendingLogs`, one per activity and day) and sent by
  `PendingLogsSync` on the next page load or `online` event. The server upsert makes every retry safe.
- UI chrome is translated (en/hi/te, namespace `homeProgram`, `caseTabs.homeProgram`); activity text is shown as
  written (NFR-3).

## Sharing (FR-7)

Share scope `home_program` (`lib/sharing/loaders/home_program.ts`): the current published program of each of the
source organisations' cases for the child (item id = program id, title = published title). The body is the published
markdown followed by `## Adherence`: a table with, per activity in the snapshot, `<done> of <expected>` for the last 7
days and each of the last 4 weeks. No guardian notes, never draft wording.

## For later tickets

- **040 follow-up agent**: `getGuardianHomePrograms(childId, { timeZone?, now? })` (`lib/home-program`) returns the
  published, guardian-visible programs of a child: `{ program_id, case_id, org_id, org_name, title, version,
  published_at, content_md, week_start, week_end, today, time_zone, activities: [{ id, title, instructions_md,
  frequency_per_week, duration_min, materials, goal: { id, statement } | null, guide, this_week }] }`. Use it rather
  than `listGuardianVisible(sql, childId, "home_program")`, which would also return programs that were archived or
  replaced since. Check the guardian's authorisation first; guardian notes are not included.
- Reminders to practise (032 scheduled events) are out of scope here.

Tests: `tests/home-program.test.ts` (adherence across week boundaries in Asia/Kolkata, date window, markdown, offline
retries, and the database suite: routes, publishing, snapshot semantics, authz, sharing, RLS).
