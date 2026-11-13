# Care team and cross-organisation sharing (ticket 022)

Design rules 2 and 3 of `specs/grill/doctornearme-mvp.md`. Read this before adding a feature that shows a
child's records to providers, and before adding a share scope.

## Who can open a case

One rule, defined once in SQL (`case_access_level(user, case)`) and used by the server (`lib/authz.ts`),
the `/dashboard` list (`accessible_cases(user)`) and RLS (`can_access_case(case)`):

| Caller | Access to a case of org X |
|---|---|
| active `owner` / `admin` of X | every case of X (read/write) |
| active `member` of X | only cases with an active assignment (`case_assignments`, `removed_at is null`) |
| removed assignment, revoked membership, other org | none (404) |
| platform admin without membership | none (404, D-3) |
| guardian | 403 on provider APIs (guardian routes use `requireChildGuardian`) |

The check runs on every request, so removing an assignment or revoking a membership ends access on the
next request (an open page shows 404 on refresh).

`lib/authz.ts`: `requireCaseAccess(caseId, msg)` / `requireCaseActor` / `requireCasePage` and the
recording/report/fact gates are unchanged in signature and now apply the rule above;
`getCaseAccessLevel(userId, caseId)` returns `"manage" | "assigned" | null`.
`tests/case-access.test.ts` has a static scan that fails when an `app/api/cases/**` or
`app/api/sessions/**` handler reads data before one of these gates.

## Care team (`case_assignments`)

`case_id, user_id, care_role ('lead' | 'member'), discipline_label (<= 60, free text), assigned_by,
assigned_at, removed_at, removed_by`. At most one active assignment per (case, user) and one active lead per
case (partial unique indexes).

- **New cases** get a care team from the trigger `cases_assign_care_team`: the creator (if an active member
  of the case's org) as lead, else the org's earliest active owner as lead and the other owners as members.
  So a plain member who creates a case keeps access to it. Audit `case.assignment_initial`.
- **Backfill** (migration): the same rule for every existing case, audit `case.assignment_backfilled`.
- A case can only be without a lead while its org has no active owner (e.g. a fresh local database: bootstrap
  org + `seed:demo` case, no accounts). The first active owner who joins becomes its lead (trigger
  `org_members_adopt_leaderless_cases`), e.g. `npm run -s org:grant -- <email> owner`.
- **Discipline**: free text. When empty, the UI shows the provider's 028 `provider_type` (translated) if
  they have a profile.
- **API** (owners/admins of the org and the case lead; others 403; no case access 404):
  - `GET /api/cases/:id/assignments` -> `{ assignments }` (anyone with access)
  - `POST /api/cases/:id/assignments` `{ user_id, care_role?: "lead" | "member", discipline_label? }` -> 201
    `{ assignment }`; not an active member of the org -> 422 `This person is not in your organisation`;
    already on the team -> 409. Adding a `lead` hands the lead over (the old lead stays as member).
  - `PATCH /api/cases/:id/assignments/:assignmentId` `{ care_role?, discipline_label? }` -> 200
  - `DELETE /api/cases/:id/assignments/:assignmentId` -> 200; removing (or demoting) the only lead -> 409
    `Assign another lead first`.
  - Audit `case.assigned`, `case.assignment_updated`, `case.unassigned` in the same transaction as the change
    (`add_case_assignment`, `update_case_assignment`, `remove_case_assignment`; the case row is locked).
- **UI**: case workspace `Team` tab (`app/cases/[id]/team`, `components/case/CareTeamPanel.tsx`).
- Helpers: `lib/cases/team.ts` (`listCaseTeam`, `listTeamCandidates`, `canManageCaseTeam`, `addAssignment`,
  `updateAssignment`, `removeAssignment`, `listChildCareTeam`).
- Local accounts: `npm run -s seed:users -- --prefix acct --extra-member` adds `provider_a2` (a second,
  unassigned member of org A); `provider_a` is added to the care team of org A's existing cases.

## Sharing grants (`sharing_grants`)

`child_id, source_org_id, grantee_org_id (<> source), scopes text[], granted_by (guardian), created_at,
expires_at (null = until stopped), revoked_at, revoked_by`.

Scopes (`lib/sharing/scopes.ts`, same list as the check constraint): `reports`, `assessments`, `iep`,
`home_program`, `documents`, `health_profile`.

- **Only guardians grant** (D-4), only between organisations that both have a case for the child, read only,
  revocable, optional expiry (90 or 365 days). There is at most one active grant per (child, source,
  grantee): a new one replaces the old one (audited `sharing.revoked` with `reason: "replaced"`).
- A grant counts only while the granting guardian's link to the child is active (fail closed, like digital
  consent in 020).
- **API** (`requireGuardian` + `requireChildGuardian`; other families' children 404, providers 403):
  - `GET /api/family/children/:id/sharing-grants` -> `{ grants }` (in force only)
  - `POST /api/family/children/:id/sharing-grants` `{ source_org_id, grantee_org_id, scopes,
    expires_in_days?: 90 | 365 | null }` -> 201 `{ grant }`; an org without a case for the child -> 422
    `This organisation is not treating your child`; same org -> 400.
  - `POST /api/family/children/:id/sharing-grants/:grantId/revoke` -> 200 `{ grant }`; unknown/revoked -> 404.
  - Audit `sharing.granted` / `sharing.revoked` is **strict**: written by `create_sharing_grant` /
    `revoke_sharing_grant` in the same transaction; if it fails nothing is saved and the API answers 503.
- **Notification** (032): a trigger on `sharing_grants` enqueues outbox event `sharing.granted`
  (`{ grant_id, child_id, source_org_id, grantee_org_id, grantee_case_id }`, dedup `sharing.granted:<grant id>`)
  in the granting transaction; `createSharingGrant` then calls `drainSoon()`. Recipients: active owners/admins
  of the grantee org, re-checked at fan-out (grant not revoked/expired, granting guardian's link active).
  In-app + email, no child name or scopes; links to the grantee case's `Shared with us` tab. See
  `docs/notifications.md`.
- **UI**: `/family/children/[id]/team` (care team by organisation + `Sharing`: one card per ordered pair of
  treating organisations with `Share` or `Stop sharing`), linked from the child page.

## Reading shared records

```ts
import { requireSharedAccess } from "@/lib/authz";

const access = await requireSharedAccess(childId, "documents", { granteeOrgId }); // granteeOrgId optional
if (access instanceof Response) return access; // 401 / 403 / 404 (no grant: none, wrong scope, expired, revoked)
access.sourceOrgIds; // organisations whose records the scope may show; never grants write access
```

The caller must be able to access a case of the child in the grantee org (owner/admin or assigned) and the
org must hold an active grant with that scope. Pages use `getActiveGrants(userId, childId, scope, orgId)`
(`lib/sharing/access.ts`) or the helpers below.

The case workspace `Shared with us` tab (`app/cases/[id]/shared`) lists, per source org, the granted scopes
and their items (`listSharedForCase`); `app/cases/[id]/shared/[scope]/[itemId]` opens one item through
`openSharedItem`, which re-checks the grant and writes `sharing.viewed { grant_id, scope, item_id }`
(strict: no audit row, no item). Empty state: `Nothing has been shared with your organisation for this child.`

## Adding a share scope (tickets 021, 023, 024, 025, 026)

1. Create `lib/sharing/loaders/<scope>.ts` exporting a `ShareLoader` (`lib/sharing/registry.ts`):
   ```ts
   export const documentsLoader: ShareLoader = {
     async list({ childId, sourceOrgIds }) { /* SQL filter: child + source orgs + shareable only */ },
     async get({ childId, sourceOrgIds }, itemId) { /* same filter + id; null if outside */ },
   };
   ```
   Items are `{ id, sourceOrgId, title, date }`; `get` adds `body` (`{ kind: "markdown", markdown }` or
   `{ kind: "file", url, fileName, mimeType }` with a short-lived signed URL).
2. Add one line to `SHARE_LOADERS` in `lib/sharing/registry.ts`.
3. Test it like the `reports` loader in `tests/sharing-grants.test.ts` (only shareable items, other child /
   other org / draft ids give null).

Until a scope registers a loader, a grant for it shows `Shared, but this type of record is not available in
DoctorNearMe yet.` The `reports` scope (this ticket) = `reports` rows with `kind = 'assessment'` and
`status = 'final'` from the source orgs' cases for the child. `health_profile` (ticket 021) = the child's
current health profile, one item per source org (id = child id); see `docs/health-profile.md`.
The `documents` scope (ticket 023, `lib/sharing/loaders/documents.ts`) = `ready` provider uploads of the source
orgs for the child; its file `url` is `/api/documents/<id>/download` (access re-check + strict
`document.downloaded` audit, then a 300 s signed URL) rather than a pre-minted signed URL. Guardian uploads
are shared per document instead (`docs/documents.md`).

Since ticket 024 loaders show **published versions** (`published_versions`, `lib/clinical/publish.ts`), never
drafts: `reports` = the current published version of each final assessment report (item id = report id);
`assessments` = the current published summary of each reviewed questionnaire (item id = assessment id,
`lib/sharing/loaders/assessments.ts`, see `docs/assessments.md`). Loaders for 025/026 should do the same.
`iep` (ticket 025, `lib/sharing/loaders/iep.ts`) = the latest published version of each IEP plan of the source
orgs' cases for the child (item id = plan id), followed by a live `Date | Value` progress table per published goal
(no provider notes, never draft wording); see `docs/iep.md`.
`home_program` (ticket 026, `lib/sharing/loaders/home_program.ts`) = the current published home program of each of
the source orgs' cases for the child (item id = program id), followed by an `## Adherence` table (last 7 days and the
last 4 weeks per activity; no guardian notes, never draft activities); see `docs/home-program.md`.

## RLS (browser reads only; the server uses the service role and the gates above)

- `cases`: `can_access_case(id)` (replaces 017's org-member policy). `can_read_child_via_org` (020) now
  follows the same rule.
- `case_assignments`: readable for cases the user can access.
- `sharing_grants`: readable by the child's guardians.
- No insert/update/delete for `anon`/`authenticated`; all functions above are `service_role` only except
  `can_access_case`.
