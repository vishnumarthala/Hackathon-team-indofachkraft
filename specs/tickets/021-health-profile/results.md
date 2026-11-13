# 021: Child health profile - Results

Branch: `ticket/021-health-profile` (base: 017-020, 022, 028, 029 merged). Tested against the isolated local
Supabase stack of slot 7 (`supabase_db_dnmslot7`, every migration re-applied by `db reset`), `DEMO_MODE=true`,
dev server on port 3070, integrated browser at 375 px. Accounts from `npm run -s seed:users -- --prefix acct`;
a case of org A created by `provider_a` over the API, claimed by `guardian_a` with the 020 parent code.
Synthetic data only.

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002100_health_profile.sql` | PASS | `child_health_profiles` (FR-1 columns and checks: blood group list, jsonb arrays <= 30, text limits, E.164) + `child_health_profile_history` (unique `(child_id, version)`); triggers own `version`/`updated_at` and write one history row per insert/update; history append-only (update/truncate trigger, no direct insert/update/delete privilege for any role); `save_child_health_profile` (security definer, row lock, version check, audit in the same transaction); RLS on both. `db reset` applies all migrations |
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0; build lists `/api/cases/[id]/health`, `/api/family/children/[id]/health`, `/cases/[id]/health`, `/family/children/[id]/health`, `.../health/history`, `.../health/history/[version]` |
| `npx vitest run` (slot 7 stack, `DATABASE_URL` set) | PASS | 55 files, 772 passed, 10 skipped (the skipped ones are the pre-existing opt-in `CT_DB_TESTS=1` suite in `tests/intake-completion.test.ts`, which needs `.env.local`; unrelated). All other DB suites ran |
| `npx vitest run tests/health-profile.test.ts --reporter=verbose` | PASS | 19 tests: schema limits (every max/min, 30/31 entries, YYYY-MM, E.164 + Indian mobile normalisation, blood group, version), NKA exclusivity, `healthSummary` output (incl. not recorded vs NKA), version 0, save -> version 1, stale version 409 with the exact message and no write, concurrent race -> one 200 + one 409, history row per save with changed field names, append-only (update rejected, delete permission denied, direct update still versioned), audit details without values, provider read + negatives, RLS, share loader, revoked guardian link refused by the SQL function |
| E-1.1 guardian edits | PASS | API: `PUT {version:0, allergies:[Peanut/hives/severe], medications:[Synthetic syrup 5 ml twice daily]}` -> 200 version 1; reload -> values persist, `version: 1`; page shows `Last updated 13 Nov 2026, 6:19 am IST by Synthetic Parent A`. Browser (375 px): added a condition and an emergency contact (`98765 43210` stored as `+919876543210`) -> `Saved.`, `Last updated ...` refreshed |
| E-1.2 NKA with an allergy | PASS | browser: ticking `No known allergies` with Peanut listed + `Save` -> alert `Remove the allergies above, or untick No known allergies.` (no request). API: 400 `{ details: { allergies: "No known allergies cannot be combined with other allergies" } }` |
| E-2 concurrent edit | PASS | API: two saves from version 1 -> tab 1 200 (version 2), tab 2 409 `This profile was changed by someone else. Reload to see the latest version.`; stored row keeps tab 1 data (`blood_group O+`, `birth_history null`). Browser: editor open at version 3, another save moved the profile to 4, `Save` in the editor -> alert with that message and a `Reload` button; nothing written |
| E-3.1 provider read-only + banner | PASS | `provider_a` (assigned member of org A): `/cases/<id>` and `/cases/<id>/health` show `Severe allergy: Peanut` at the top of the case header; `Health` tab lists the profile with `Only the child's parent or guardian can change this profile...`, 0 form/input/button elements in the tab body; `GET /api/cases/:id/health` -> 200 `{ profile, updated_at }`, `Cache-Control: private, no-store` |
| E-3.2 provider on the family API | PASS | `PUT /api/family/children/:id/health` as `provider_a` -> 403 `Not allowed` |
| E-4.1 other org | PASS | `provider_b` (org B, no case for the child): `GET /api/cases/<org A case>/health` -> 404 `Case not found` |
| E-4.2 other guardian | PASS | `guardian_b`: API -> 404 `Child not found`; `/family/children/<id>/health` -> 404 |
| E-4.3 membership revoked | PASS | `DELETE /api/orgs/<A>/members/<provider_a>` as `org_admin_a` -> 200; next `GET /api/cases/:id/health` -> 404. DB test also covers an unassigned member (404) and a guardian on the provider route (403) |
| E-5.1 history | PASS | `/family/children/<id>/health/history` lists versions 2 and 1 (`Changed: Allergies, Medicines`, `Changed: Blood group`, date, by); `/history/1` shows `This is an older version, shown read only.` with no form. Later in the browser: versions 4..1 |
| E-5.2 audit privacy | PASS | `audit_events` `health_profile.updated`: `{"fields":["allergies","medications"],"version":1}`, `{"fields":["blood_group"],"version":2}`; actor `parent` + `actor_user_id`; no `Peanut` (or any other value) in details |
| NFR-1 access + no caching | PASS | guardian via `requireChildGuardian`, provider via `requireCaseAccess` (static scans in `tests/guardian-authz.test.ts` / `tests/case-access.test.ts` include the new routes); RLS: guardian and owner of A read the row, other guardian, org B and revoked member read 0; history readable by the guardian only; all three APIs `private, no-store`, pages `force-dynamic` |
| NFR-2 translated | PASS | all new strings in en/hi/te (`health.*`, `caseTabs.health`), `messages/REVIEW.md` regenerated (1045 rows), `tests/i18n-keys.test.ts` passes. Browser in Telugu (`lang="te-IN"`): editor, history and read-only version translated, free text shown as entered; `scrollWidth = innerWidth = 375` on editor, history, version and provider pages |
| NFR-3 no health data in logs/notifications/audit | PASS | audit field names only (test asserts no values); no notification topic; the only log line on a failed save names the child id, not values |
| FR-7 `healthSummary` | PASS | `Allergies: Peanut (severe, hives); Medicines: Synthetic syrup 5 ml twice daily; Conditions: ...` (tests) |
| 022 share scope `health_profile` | PASS | `lib/sharing/loaders/health_profile.ts` registered in `SHARE_LOADERS`; test: one item per source org for the child, nothing for another child / no source orgs / wrong id; body is escaped markdown |

## Deviations

- `child_health_profile_history` has one extra column, `changed_fields text[]` (names of the changed top-level
  fields, computed by the trigger), so the history page can show "changed sections" without diffing snapshots.
- The history also holds the first version (insert), not only updates, so "History lists both versions" works
  after two saves.
- `updated_by` / `changed_by` are plain uuids without a foreign key: an `on delete set null` FK would rewrite
  the append-only history when an account is deleted.
- Allergy `reaction` and `severity` are optional in the API (defaults `""` / `unknown`); `substance` is
  required. `since` must be `YYYY-MM` between 1900 and 2099.
- Provider read is not audited (the rd asks only for `health_profile.updated`); ticket 041 can add read audits.

## Notes

- Read helpers for later tickets (`docs/health-profile.md`): `getPrescribingHealthFacts(childId)` (039:
  `recorded`, `noKnownAllergies`, `allergies`, `medications`, `version`; `recorded: false` means allergies are
  unknown, not "none"), `getHealthProfileForCase(caseId)`, `healthSummary(profile)` (035, 038). Gate access
  first.
- Shared files touched additively: `app/cases/[id]/layout.tsx` (banner), `components/case/CaseTabs.tsx`
  (`Health` tab), `app/family/(portal)/children/[id]/page.tsx` (link), `lib/sharing/registry.ts` (one line),
  `tests/helpers/consent.ts` (`purgeSyntheticChildren` deletes health rows: replica mode skips FK cascades),
  `tests/sharing-grants.test.ts` (loader list assertion now `arrayContaining`, so 023/024/025/026 can add
  theirs without editing it again).
- No new env vars, no new dependencies, no notifications.
- Browser sessions were injected as Supabase SSR cookies (password sign-in of the seeded accounts); the phone
  OTP form was not clicked through (covered by 019). A stale cookie of a user deleted by an earlier `db reset`
  still produces the pre-existing proxy 500 noted in 022.
- Migration timestamp `20261113002100` sorts before 022/028/029's migrations; it only depends on 020
  (`children`, `guardian_links`, `is_child_guardian`) and 022's `can_read_child_via_org` at policy evaluation
  time, so a fresh `db reset` applies cleanly. On a database that already has 022+ applied, run it with
  `supabase migration up --include-all`.
