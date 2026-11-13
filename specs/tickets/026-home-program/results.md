# 026: Home program - Results

Branch: `ticket/026-home-program` (base `08a32ab`: 017-025, 028, 029, 032 merged). Tested against the isolated local
Supabase stack `dnmslot4` (all 18 migrations applied by `db reset`), `DEMO_MODE=true`, dev server on port 3040, own
headless Chromium (playwright-core driving the cached chrome-headless-shell; not the shared browser). Accounts from
`npm run -s seed:users -- --prefix acct --extra-member`; synthetic data only. Raw evidence in `evidence/`:
`acceptance.txt` (scripted API + browser run, 35 checks, all PASS), screenshots, `vitest-026-verbose.txt` (the eval
test command, 19 tests).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002600_home_program.sql` | PASS | `db reset` applies all 18. New tables only (`home_programs`, `home_activities`, `home_activity_logs`, `home_program_publications`), so nothing to backfill; one published program per case (partial unique index), max 15 active activities (trigger), one log per activity/day/guardian (unique), RLS on, care team read only |
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0; new routes in the build (`/cases/[id]/home-program`, `/family/children/[id]/home-program`, `/api/cases/[id]/home-programs`, `/api/home-programs/**`, `/api/home-activities/**`, `/api/family/home-activities/**`, `/api/family/home-activity-logs/**`, `/api/family/children/[id]/home-program`). `scripts/dev/check-client-imports.mjs` clean |
| `npx vitest run` | PASS | 66 files, 981 passed, 10 skipped (the pre-existing ticket 010 `CT_DB_TESTS` block); every other DB suite ran against slot 4, including the new one |
| `npx vitest run tests/home-program.test.ts --reporter=verbose` | PASS | 19 passed, 0 skipped (`vitest-026-verbose.txt`): adherence across the week boundary in Asia/Kolkata (Sunday 23:30 IST vs Monday 00:30 IST, which are both Sunday in UTC), log upsert idempotency, date window (future / > 14 days), goal from another case's plan -> 422, draft activities and unpublished edits never in guardian responses, stop vs delete, 15 active, guides, 409, authz, `home_program` share scope, own-log deletion, one published program per case, outbox event, RLS, offline retry queue |
| E-1.1 add activity, publish; foreign goal | PASS | `Snack-time requesting`, linked goal, 5/week, 10 min -> 201; goal of another case's active plan -> 422 `{ error: "Choose a goal from this child's plan" }`; `Publish to parent` clicked in the UI -> `published_versions` v1 (`visible_to_guardian`); outbox `home_program.published` (ids only, dedup `home_program:<id>:v1`) fanned out to guardian_a in-app + email, link `/family/children/<id>/home-program` |
| E-1.2 guardian `This week` | PASS | guardian page lists the activity under `Goal: <published goal wording>` with `0/5 this week` |
| E-2.1 logging, retry | PASS | 375 px: `Done today`, `Okay`, `Save` -> `1/5 this week` (`family-done-today-sheet-375.png`); the same request twice -> 200/200, same log id, one row |
| E-2.2 date window | PASS | `done_on` tomorrow -> 400 `The date cannot be in the future`; 20 days ago -> 400 `You can only log the last 14 days` |
| E-2.3 provider adherence | PASS | panel shows `done 1 of 5 times in the last 7 days`, the 4-week sparkline and the note `Asked for biscuit twice` (`provider-home-program-tab.png`) |
| E-3 snapshot semantics | PASS | second activity added without publishing: `Unpublished changes`; guardian page/API do not show it; logging against it -> 404 `Activity not found`; `Publish changes` (UI) -> v2, guardian sees `0/3 this week`, logging -> 201 |
| E-4 authz negatives | PASS | guardian_b logs against guardian_a's activity -> 404; provider_b reads the program -> 404; after guardian_a's `home_program` grant provider_b sees it under `Shared with us` read-only (published text + adherence table `1 of 5`, no guardian note; `provider-b-shared-home-program.png`) and the provider APIs still answer 404; guardian_b deletes guardian_a's log -> 404; guardian on provider APIs -> 403 |
| FR-5 delete own log | PASS | own log of this week -> 200 (audit `home_program.log_deleted`); a log of an earlier week -> 409 `Only this week's entries can be removed`; another guardian's -> 404 (DB suite) |
| FR-6 adherence | PASS | `lib/home-program/adherence.ts` `adherence(logs, activity, weekStart)`, Monday-start weeks in the guardian's zone (`getTimeZone`), unit tests above |
| FR-7 sharing scope | PASS | `home_program` loader registered (`lib/sharing/loaders/home_program.ts`); `tests/sharing-grants.test.ts` updated (6 loaders) |
| NFR-1 one tap + one choice, offline-safe | PASS | sheet with three large choices and `Save` at 375 px, no horizontal scroll (`scrollWidth = innerWidth = 375`); client retries the same body and keeps it in `localStorage` while offline, `PendingLogsSync` resends it (unit tests); server upsert makes retries idempotent |
| NFR-2 no drafts for guardians | PASS | guardian reads come from the `home_program_publications` snapshot of the current published program only; tests assert unpublished activity titles and edited instructions never appear |
| NFR-3 translated chrome | PASS | en/hi/te (namespace `homeProgram`, `caseTabs.homeProgram`; `messages/REVIEW.md` regenerated, 1539 rows); instructions shown as written; Telugu page at 375 px (`family-home-program-te-375.png`) |
| Static gates | PASS | `app/api/cases/[id]/home-programs` passes the 022 case-gate scan; the new `/api/family/**` routes and the `/family` page pass the 019 guardian scans |

## Deviations

- **Activity snapshot table `home_program_publications`** (not in FR-1), like 025's `iep_publications`: the guardian
  view and the guardian logging check ("activities not in the published snapshot -> 404") need the published
  activities in structured form. No FK to `published_versions` (keeps 024's append-only truncate guard).
- **Stopping an activity takes effect at once for guardians** (hidden and 404 on logging) without republishing; all
  other edits wait for `Publish changes`. FR-5 lists deactivated activities as 404, and a provider must be able to
  withdraw an activity immediately.
- **Guardians see only the case's current published program**; programs archived by a newer publish (or by
  `Archive`) disappear from the family page and share scope. 040 should use `getGuardianHomePrograms` rather than
  `listGuardianVisible(..., "home_program")`, which would still return archived programs' versions.
- **Linked goal wording for guardians is the goal's published wording** (latest 025 `iep_publications` snapshot
  containing it); a goal added to the active plan but not yet published is left out of the published program.
  Discontinued goals cannot be linked (same 422).
- **Guides**: `Attach guide` lists the case's ready provider documents visible to the parent; uploads happen in the
  `Documents` tab (023 upload dialog), not inside the activity form. Other documents -> 422. The family page shows
  `Download guide` only while the document is still ready and parent-visible; the link goes through 023's download
  route (access re-check + audit).
- **Adherence counts log rows** (two guardians logging the same day count twice), because frequency may be up to 14 a
  week while each guardian can log once a day. The provider panel and the share scope use the child's guardian time
  zone (`user_profiles.time_zone` of the earliest active guardian, else Asia/Kolkata) and say so.
- **Activity writes accept an optional `version`** (checked when sent; the UI always sends it); `PATCH` program and
  publish require it. Extra endpoints: `GET /api/cases/:id/home-programs`, `GET /api/home-programs/:pid`,
  `GET /api/family/children/:id/home-program`. Program `PATCH` can rename or archive (`published` only via publish).
- **Saving a log is not audited** (the guardian's own entry; retries would repeat rows); deleting one is.
- **`home_program_published` notification link** now opens `/family/children/<id>/home-program` (was the child page).

## Notes

- **For 040 (follow-up agent):** `getGuardianHomePrograms(childId, { timeZone?, now? })` in `lib/home-program` returns
  typed `GuardianHomeProgram[]` (published snapshot wording, `content_md`, this week's `done`/`expected` per activity,
  guide metadata; no guardian notes). Check the guardian's authorisation first.
- **New helpers:** `lib/home-program/{index,schema,adherence,markdown,authz}.ts` (`requireHomeProgramActor`,
  `requireHomeActivityActor`, `requireGuardianActivity`, `childTimeZone`, `listSharedPrograms`);
  `components/home-program/{HomeProgramPanel,DoneToday,Instructions,Sparkline,logQueue,view}`; SQL
  `home_programs_match_case`, `home_activities_check_active_limit`, `home_activity_logs_match_child`,
  `home_programs_child_follow`.
- Shared files touched additively: `components/case/CaseTabs.tsx` (one tab), the family child page (one link),
  `lib/sharing/registry.ts` (one loader), `lib/notify/templates/home_program_published.ts` (link), `messages/*.json`
  (`homeProgram` namespace + `caseTabs.homeProgram`), docs.
- No new env vars, no new dependencies. Docs: `docs/home-program.md` (new), `docs/system-design.md`, `docs/sharing.md`,
  `docs/notifications.md`.
