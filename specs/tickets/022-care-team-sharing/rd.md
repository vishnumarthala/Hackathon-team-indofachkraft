# 022: Care team, provider assignments and cross-org sharing grants

**Status:** done
**Mode:** solo
**Runs:** waits for 020: needs children, guardian links and case `child_id`

## Summary

Makes clinical access explicit (rule 2): providers are **assigned** to cases; org owners/admins see all
their org's cases, members only cases they are assigned to. Guardians see their child's care team across
organisations. Records from one organisation reach another only through an explicit, scoped, revocable
**sharing grant** created by a guardian. `requireCaseAccess` (017) is refined to use assignments, and a
new `requireSharedAccess` covers grants. Later tickets (023-027) declare which share scope they use.

## Functional requirements

- **FR-1** - Migration `<ts>_care_team_sharing.sql`:
  - `case_assignments(id, case_id -> cases on delete cascade, user_id -> auth.users, care_role text check in
    ('lead','member') default 'member', discipline_label text (<= 60, e.g. "Speech therapist"),
    assigned_by, assigned_at, removed_at, removed_by)`; partial unique `(case_id, user_id) where removed_at is null`;
    at most one active `lead` per case (partial unique index).
  - Backfill: for every case, assign the case creator if known; otherwise assign all current org owners
    of `cases.org_id` as `lead` (017 bootstrap org). Audit `case.assignment_backfilled` per case.
  - `sharing_grants(id, child_id, source_org_id, grantee_org_id, scopes text[] check (scopes <@
    array['reports','assessments','iep','home_program','documents','health_profile']), granted_by
    (guardian user), created_at, expires_at null, revoked_at, revoked_by)`; check `source_org_id <> grantee_org_id`.
- **FR-2** - Access rules in `lib/authz.ts` (rule 3; all server-side):
  - `requireCaseAccess(caseId, notFoundMessage)` (017 signature unchanged): platform admins without membership have **no** clinical access (017);
    org `owner`/`admin` of `cases.org_id` -> read/write; org `member` -> only with an active assignment;
    removed member / revoked org membership -> 404.
  - `requireSharedAccess(childId, scope)`: caller's active org has an unrevoked, unexpired grant for the
    child with that scope **and** caller has access to at least one case for that child in the grantee
    org; returns `{ sourceOrgIds }`. Never grants write.
  - The `/dashboard` case list (`lib/queries/cases.ts`) filters by the same rule.
- **FR-3** - Provider UI, case workspace `Team` tab: list of assigned providers (`<name> - <discipline_label>
  - Lead/Member`), `Add provider` (select from active org members, discipline label, role) and `Remove`
  (owners/admins/lead only). APIs: `POST /api/cases/:id/assignments` `{ user_id, care_role,
  discipline_label }` -> 201; non-member user -> 422 `{ error: "This person is not in your organisation" }`;
  duplicate -> 409; `DELETE /api/cases/:id/assignments/:assignmentId` -> 200; removing the last lead -> 409
  `{ error: "Assign another lead first" }`. Audit `case.assigned` / `case.unassigned`.
- **FR-4** - Guardian UI `/family/children/[id]/team`: grouped by organisation: org name, providers
  (name, discipline label), and a `Sharing` section: `Share records between your providers`. For each
  pair of orgs that both have a case for the child, the guardian can `Share` choosing scopes (checkboxes
  `Reports`, `Assessments`, `Goals (IEP)`, `Home program`, `Documents`, `Health profile`) and expiry
  (`Until I stop it` / `3 months` / `12 months`). Active grants show `Stop sharing`.
- **FR-5** - Grant APIs (`requireChildGuardian`): `POST /api/family/children/:id/sharing-grants`
  `{ source_org_id, grantee_org_id, scopes, expires_in_days?: 90 | 365 | null }` -> 201 `{ grant }`;
  org without a case for the child -> 422 `{ error: "This organisation is not treating your child" }`;
  `POST /api/family/children/:id/sharing-grants/:grantId/revoke` -> 200. Audit `sharing.granted` /
  `sharing.revoked` (strict: fail closed). Notify grantee org admins via 032 when available (outbox
  event `sharing.granted`; until 032 merges, no notification).
- **FR-6** - Provider UI: case workspace `Shared with us` tab lists, per source org, the items available
  under each granted scope (filled in by 023-026 through a registry `lib/sharing/registry.ts` where each
  feature registers `scope -> loader(childId, sourceOrgIds)`; this ticket registers `reports` = reports
  with `status = 'final'` from the source orgs' cases; the `health_profile` loader is added by whichever
  of 021/022 merges second); empty state `Nothing has been shared
  with your organisation for this child.` Every view of a shared item audits `sharing.viewed`
  `{ grant_id, scope, item_id }`.
- **FR-7** - Membership revocation (017) or assignment removal ends access on the next request; open
  pages show a 404 on refresh. Revoking or expiring a grant ends shared access immediately.

## Non-functional requirements

- **NFR-1** - All list queries filter in SQL (no fetch-all-then-filter in JS).
- **NFR-2** - RLS policies for `case_assignments` and `sharing_grants`: guardians read grants of their
  children; providers read assignments of cases they can access; writes only through server routes.
- **NFR-3** - Translated (en/hi/te), 375 px for guardian pages.

## Affected areas

- `supabase/migrations/<ts>_care_team_sharing.sql` (new)
- `lib/authz.ts` (refine `requireCaseAccess`, add `requireSharedAccess`), `lib/sharing/registry.ts` (new)
- `lib/queries/cases.ts` (list filter)
- `app/api/cases/[id]/assignments/**`, `app/api/family/children/[id]/sharing-grants/**` (new)
- Case workspace `Team` and `Shared with us` tabs, `app/family/children/[id]/team/**` (new)
- `scripts/seed-users.ts` (assign seeded providers), `messages/*.json`
- `tests/case-access.test.ts`, `tests/sharing-grants.test.ts` (new)

## Don't touch

- Consent logic (020), 017 org/invitation flows (only consume), existing migrations, `BOARD.md`

## Out of scope

- Provider-initiated share requests; sharing with orgs that have no case for the child; external
  specialist referral links (existing 012 flow stays).
- Shared item content for scopes whose feature is not built yet (they register in their own ticket).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Org membership vs case access | Owners/admins all org cases; members by assignment | rule 2 "provider assignments" |
| D-2 | Cross-org | Only explicit guardian grants, scoped, read-only, revocable, optional expiry | rule 2 |
| D-3 | Platform admin clinical access | None by default | least privilege; rule 3 |
| D-4 | Who grants | Guardian only | plan §2 "Child consent" |

## Open questions

- Should org admins (non-clinical centre managers) see all clinical case content? Proposed yes for MVP
  (small centres); a `clinical` flag on org_members is a later refinement.
