# 022: Care team, provider assignments and cross-org sharing grants - Results

Branch: `ticket/022-care-team-sharing` (base: 017-020, 028, 029 merged). Tested against the isolated local
Supabase stack `dnmslot4` (all ten migrations applied by `db reset`), `DEMO_MODE=true`, dev server on port
3040, integrated browser. Accounts from `npm run -s seed:users -- --prefix acct --extra-member`; synthetic data
only. Raw evidence in `evidence/` (`acceptance.txt` = scripted API/HTML run against the dev server, 40 checks,
all PASS; `vitest-022-verbose.txt` = the eval test command incl. the access matrix; screenshots).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002200_care_team_sharing.sql` | PASS | expand -> backfill -> enforce: `case_assignments` (partial unique `(case_id, user_id) where removed_at is null`, one active `lead` per case), `sharing_grants` (scope check, `source_org_id <> grantee_org_id`), SQL access rule `case_access_level` + `accessible_cases` + `active_sharing_grants`, backfill (`assign_initial_care_team`, audit `case.assignment_backfilled`), trigger giving new cases a lead, RLS (cases/assignments by care-team rule, grants for guardians), security-definer writes with audit in the same transaction. `db reset` applies all migrations; browser roles cannot execute any service function (test) |
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0; vitest 54 files, 752 passed, 10 skipped (the pre-existing ticket 010 block); every DB suite ran |
| `npx vitest run tests/case-access.test.ts tests/sharing-grants.test.ts --reporter=verbose` | PASS | 2 files, 51 passed, 0 skipped (`evidence/vitest-022-verbose.txt`): matrix {owner, admin, assigned member, unassigned member, removed member, revoked member, other-org provider, platform_admin, guardian} x {list, read, write}; grant states {none, active, wrong scope, expired, revoked} x `requireSharedAccess`; strict audit (forced failure -> 503, no grant); RLS; lead hand-over incl. concurrency |
| Static test: every `app/api/cases/**` and `app/api/sessions/**` route gates before reading | PASS | `tests/case-access.test.ts` (one test per route file; fails if a handler reads before `requireCaseAccess` or a stricter helper). Exempt with reason: `POST /api/cases` (no case id yet, `requireProviderApi`) and `POST /api/cases/:id/ask` (012 share-token route). Mutation check: moving `getCase` above the gate in `app/api/cases/[id]/route.ts` fails the test |
| E-1.1 backfill: every case has >= 1 active lead | PASS | acceptance: `3 cases, 0 without a lead` (incl. the `seed:demo` case adopted by the first bootstrap owner); test: legacy case backfilled once, second run touches 0, audit row |
| E-1.2 unassigned member | PASS | `provider_a2`: case missing from `/dashboard`, `/cases/<id>` 404, `PATCH /api/cases/:id` 404 `Case not found` |
| E-1.3 add provider | PASS | `org_admin_a` adds `provider_a2` as `Member` / `Occupational therapist` (API 201 + browser form, `provider-team-tab.png`); audit `case.assigned`; `provider_a2` sees the case on `/dashboard` and opens it (200); Team tab shows `<name> - Occupational therapist - Member` |
| E-1.4 last lead / other org | PASS | removing the only lead -> 409 `Assign another lead first` (API + browser alert, `provider-team-last-lead.png`); adding `provider_b` -> 422 `This person is not in your organisation`; assigned non-lead member -> 403 |
| E-1.5 removal ends access | PASS | DELETE -> 200, audit `case.unassigned`; `provider_a2` refresh of `/cases/<id>` and `/cases/<id>/team` -> 404 |
| E-2.1 guardian care team | PASS | `/family/children/<id>/team` lists `acct Centre A (synthetic)` / `Dr Synthetic A - Lead` and `acct Solo B (synthetic)` / `Dr Synthetic B - Lead`, no emails; `Sharing` / `Share records between your providers`; linked from the child page (`family-team-en-375.png`) |
| E-2.2 share A -> B, Reports, 3 months | PASS | 201 `{ grant }`, `expires_at` = now + 90 days; audit `sharing.granted` (actor parent); page shows `Shared: Reports` + `Stop sharing`. Browser: B -> A with Assessments + Documents, 12 months via the form |
| E-2.3 org without a case | PASS | 422 `This organisation is not treating your child` |
| E-3.1 scoped shared reports | PASS | final + draft report on org A's case; `provider_b` `Shared with us` lists `From acct Centre A (synthetic)` with only `Final assessment (synthetic)`; opening it -> 200 read-only, audit `sharing.viewed { grant_id, scope: "reports", item_id }`; draft id -> 404; `provider_b` still 404 on org A's case |
| E-3.2 wrong scope | PASS | test: `requireSharedAccess(child, "documents")` for `provider_b` -> 404; HTTP: `/cases/<B>/shared/documents/<id>` -> 404 |
| E-3.3 expired | PASS | `expires_at` set in the past via SQL -> item 404 and empty state `Nothing has been shared with your organisation for this child.` on the next request |
| E-3.4 revoke in guardian UI | PASS | browser `Stop sharing` -> `POST .../revoke` 200; `provider_b` item 404 + empty state; audit `sharing.revoked` (reason `guardian`) |
| E-4.1 platform admin | PASS | not a member: `/cases/<id>` 404, `PATCH /api/cases/:id` 404 |
| E-4.2 other guardian | PASS | `guardian_b` POST grant for `guardian_a`'s child -> 404 `Child not found`; `/family/children/<id>/team` 404 |
| E-4.3 provider on grant API | PASS | `provider_a` -> 403 |
| NFR-1 SQL filtering | PASS | case list `accessible_cases(user)`, care team/candidates/child team via SQL functions, grants via `active_sharing_grants`, report loader filters child + source orgs + `final` in the query |
| NFR-2 RLS | PASS | tests: assigned member/admin read the case, unassigned member and platform admin 0 rows; assignments only for accessible cases; grants: own guardian > 0, other guardian/provider 0; insert/update as `authenticated` -> permission denied |
| NFR-3 translated, 375 px | PASS | all new strings in en/hi/te (`messages/REVIEW.md` regenerated, key test passes); guardian page in Telugu `lang="te-IN"`, `scrollWidth = innerWidth` (integrated browser reported a 340 px viewport), 0 external scripts (`family-team-te-375.png`, `family-share-form-te-375.png`) |

## Deviations

- **One lead per case vs. "assign all owners as lead" (FR-1 backfill).** The partial unique index allows one
  active lead, so the earliest active owner becomes lead and the other owners join as members. The creator is
  used only while still an active member of the case's org.
- **New cases get a care team automatically** (trigger `cases_assign_care_team`, audit
  `case.assignment_initial`): without it a plain member would lose access to a case they just created. An
  org without any active owner (fresh local DB: bootstrap org + `seed:demo`) keeps its cases lead-less until
  the first owner joins, who then becomes lead (trigger `org_members_adopt_leaderless_cases`).
- **Lead hand-over.** `POST` with `care_role: "lead"` moves the lead role (old lead stays as member); added
  `PATCH /api/cases/:id/assignments/:assignmentId` (`care_role`, `discipline_label`) for `Make lead`. Demoting
  the only lead -> 409 like removing it.
- **Discipline label** (decision record): free text. When empty it is stored as null and the UI shows the
  provider's 028 `provider_type` (translated) if they have a profile.
- **One active grant per (child, source, grantee).** A new grant replaces the old one (old one revoked,
  audited `sharing.revoked` with `reason: "replaced"`). Grants count only while the granting guardian's link
  is active (fail closed, like 020 digital consent). Any linked guardian of the child may stop a grant.
- **`requireSharedAccess(childId, scope, { granteeOrgId? })`** returns `{ actor, sourceOrgIds, grants }` or a
  404 response (401/403 for anonymous/guardians). There is no "active org" selection in the app, so the
  caller's orgs are all their active memberships; the optional `granteeOrgId` narrows to the case
  workspace's org.
- **`reports` scope** = `reports.kind = 'assessment'` and `status = 'final'` (pre-session briefs and parent
  summaries are not shared).
- **Notifications (FR-5):** `notifyLater("sharing.granted", { grant_id, source_org_id, grantee_org_id })`
  (`lib/notify/topics.ts`, `SHARING_TOPICS`) only logs until ticket 032 wires the outbox.
- **`health_profile` loader** is not registered here: 021 is not merged on this base, so 021 adds it.
- **RLS refinement of existing objects:** the 017 cases policy is replaced by `Care team reads accessible
  cases`; 020's `can_read_child_via_org` is redefined to use the same rule (`create or replace`, existing
  migrations untouched).
- **Migration order:** `20261113002200` sorts before 028/029, so read-model functions that join
  `provider_profiles` / `organizations.public_name` are plpgsql (bodies resolved at call time). On a database
  that already has 028/029 applied, `supabase migration up` needs `--include-all` (same as 020).
- **Case tabs** are now translated (`caseTabs.*`) since two tabs were added; provider Team/Shared tabs are
  translated too. Provider names fall back to the email on the provider Team tab only; guardians never see
  emails (`Care team member` fallback).
- **`org:grant`** prints a note that members only see assigned cases (behaviour of the script unchanged).
- **Existing tests:** `tests/orgs-authz.db.test.ts` now assigns its plain members to the case (rule change).

## Notes

- **For 023-026 (and 021):** register a scope loader in `lib/sharing/registry.ts` (`ShareLoader` with
  `list(ctx)` / `get(ctx, itemId)`, `ctx = { childId, sourceOrgIds }`, SQL-filtered, shareable items only).
  Read access in routes: `requireSharedAccess(childId, scope)`; the `Shared with us` tab and item page pick
  new loaders up automatically. Details: `docs/sharing.md`.
- **New helpers:** `lib/authz.ts` `getCaseAccessLevel`, `requireSharedAccess`; `lib/cases/team.ts`;
  `lib/sharing/{scopes,registry,access,grants,shared}.ts`; `lib/queries/cases.ts` `listCases(userId)`
  (signature changed from org ids). SQL: `case_access_level`, `can_manage_case_team`, `accessible_cases`,
  `active_sharing_grants`, `can_access_case`, `list_case_team(_candidates)`, `list_child_care_team`,
  `add/update/remove_case_assignment`, `create/revoke_sharing_grant`.
- **For 032:** topic `sharing.granted` (payload ids only); recipients = active owners/admins of
  `grantee_org_id`. Move the call into the `create_sharing_grant` transaction as an outbox insert.
- **Seed:** `seed:users -- --extra-member` adds `provider_a2`; `provider_a` joins the care team of org A's
  existing cases.
- No new env vars, no new dependencies.
- Pre-existing (not changed): a browser holding a session cookie of a user deleted by `db reset` gets a 500
  from `/login` until the cookies are cleared (noted by 020).
