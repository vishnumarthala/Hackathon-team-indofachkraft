# 017: Organisations, roles, resource-level authorisation and provider onboarding

**Status:** done
**Mode:** solo
**Runs:** alongside

## Summary

Today every signed-in user can read and change every case: routes only check "is signed in" and the
server uses the service-role client, which bypasses RLS. DoctorNearMe is multi-tenant (an organisation
= a centre or a solo practitioner), so this ticket adds organisations and memberships, renames roles,
moves legacy cases into an explicit bootstrap organisation, and enforces resource-level access on every
existing case, session, fact and report route and page. It also adds internal provider onboarding:
create an organisation, invite colleagues, accept, revoke. Decision record: design rules 1, 3, 4, 5 in
[specs/grill/doctornearme-mvp.md](../../grill/doctornearme-mvp.md).

## Functional requirements

- **FR-1 Migration** `supabase/migrations/20261112120000_orgs_roles.sql` (expand -> backfill -> enforce):
  - `organizations(id uuid pk, name text 1..120, slug text unique, kind 'centre'|'solo', city text null, created_by uuid null -> auth.users, created_at)`.
  - `org_members(org_id -> organizations cascade, user_id -> auth.users cascade, org_role 'owner'|'admin'|'member', status 'active'|'revoked', created_at, revoked_at, pk(org_id,user_id))`.
  - `org_invitations(id, org_id -> organizations cascade, email text, org_role 'admin'|'member', token_hash text unique, invited_by uuid -> auth.users, expires_at, accepted_at, accepted_by, revoked_at, created_at)`.
  - `user_profiles.role`: `admin -> platform_admin`, `therapist -> provider`; check becomes
    `platform_admin|provider|guardian`; the auth trigger and `is_carethread_admin()` use the new names.
    The trigger takes the role from server-only `raw_app_meta_data.role` when it is `provider` or
    `platform_admin`, else `provider` (sign-up stays disabled; 019 changes the fallback to `guardian`).
  - Bootstrap org `00000000-0000-4000-8000-00000000a001`, `Pilot centre (migrated)`, slug `pilot-centre`,
    kind `centre`. Every pre-existing account becomes a member (former admins `owner`, former therapists
    `member`) so nobody loses access to legacy cases; every existing case gets this `org_id`.
  - `cases.org_id` not null (no default) + index; `cases.created_by uuid null`.
  - `audit_events.actor_user_id uuid null`.
  - RLS: new tables enabled; members can select their organisations, their org's memberships and their
    org's cases via a `security definer` `is_org_member(org uuid)` helper. No client write policies.
- **FR-2** `lib/auth.ts`: `UserRole = "platform_admin" | "provider" | "guardian"`. Admin-only pages check
  `platform_admin`.
- **FR-3** `lib/authz.ts`:
  - `getActiveOrgIds(userId)`; `requireProviderApi()` -> `{ actor }` or a 401 (`Authentication required`) /
    403 (`Provider access required`, for guardians) response.
  - `requireCaseAccess(caseId, notFoundMessage)`, `requireRecordingAccess`, `requireReportAccess`,
    `requireFactAccess` -> `null` when the signed-in provider is an active member of the resource's case
    organisation; otherwise 401/403 as above, or **404 with the route's existing not-found message** (no
    existence leak for other tenants' ids or invalid ids).
  - `requireProviderPage()` (redirects to `/login`; guardians get `notFound()`) and
    `requireCasePage(caseId)` (`notFound()` without access). Platform admins get no clinical access unless
    they are members.
- **FR-4** Every route that used `requireApiUser()` uses the matching helper: `cases` (POST),
  `cases/[id]` (PATCH), `cases/[id]/brief/reviewed`, `cases/[id]/intake-link`, `cases/[id]/refer`,
  `cases/[id]/sessions`, `facts/[id]`, `reports/[id]`, `reports/[id]/parent-voice-note`,
  `sessions/[id]/{bulk,extract,report,speakers,transcribe}`. Token-based public routes are unchanged.
- **FR-5** `POST /api/cases` accepts optional `org_id`. Without it: one active membership -> that org;
  none -> 403 `Create or join an organisation first`; several -> 422 `Choose an organisation`. With it:
  must be an active membership, else 403 `Not a member of this organisation`. Sets `created_by`.
  The new-case form shows an `Organisation` select when the user has more than one.
- **FR-6** `/dashboard` lists only cases of the user's active organisations; every `/cases/[id]/**`
  page and layout calls `requireCasePage`.
- **FR-7 Onboarding APIs** (provider or platform admin; audit with `actor_user_id`):
  - `POST /api/orgs` `{ name, kind, city? }` -> 201 `{ org }`, creator is `owner`.
  - `POST /api/orgs/[id]/invitations` `{ email, org_role }` (owner/admin) -> 201 `{ url, emailed }`; token is
    `newToken()`, only its SHA-256 is stored, expires in 7 days; email subject
    `You're invited to <org name> on DoctorNearMe`.
  - `DELETE /api/orgs/[id]/invitations/[invitationId]` (owner/admin) -> revokes.
  - `POST /api/invitations/accept` `{ token }` (signed in): 404 `This invitation is not valid` for unknown,
    expired, revoked or used tokens; 403 `This invitation was sent to a different email` on email mismatch;
    upserts an active membership; promotes a `guardian` to `provider` server-side; marks accepted.
  - `DELETE /api/orgs/[id]/members/[userId]` (owner/admin) -> `status = revoked`; 409
    `An organisation needs at least one owner` when it would remove the last active owner. Access ends
    immediately (next request).
- **FR-8 Pages**: `/dashboard/team` (orgs, members, pending invitations, invite form, revoke buttons, and a
  `Create organisation` form when the user has none); `/invite/[token]` (public; sign-in link with
  `next`, then `Accept invitation`).
- **FR-9** `scripts/seed-demo.ts`, DB tests and a new `npm run org:grant -- <email> [owner|admin|member]`
  script use the bootstrap org so local demo accounts keep working after `db:reset`.

## Non-functional requirements

- **NFR-1** No route returns case data for another organisation's id (tested with two orgs).
- **NFR-2** Invitation tokens are never stored in plain text; acceptance is single-use.
- **NFR-3** Existing behaviour for members is unchanged (all existing route tests pass).

## Affected areas

`supabase/migrations/20261112120000_orgs_roles.sql` (new), `lib/auth.ts`, `lib/authz.ts` (new),
`lib/orgs.ts` (new), `lib/audit.ts`, `lib/types.ts`, `lib/queries/cases.ts`, `lib/cases/validation.ts`,
the API routes in FR-4/FR-7, `app/dashboard/**`, `app/cases/**`, `app/admin/users/page.tsx`,
`app/invite/[token]/page.tsx`, `components/case/CaseForm.tsx`, `components/team/*`, `lib/auth-access.ts`,
`scripts/seed-demo.ts`, `scripts/org-grant.ts`, `package.json` (script), `tests/*`, `docs/system-design.md`.

## Don't touch

Earlier migrations, token-based public flows (intake, specialist, webhook) beyond what compiles.

## Out of scope

Guardian sign-up and portal (019), children (020), care-team assignment inside an org (022), public
provider profiles (028), browser-side clinical reads (server-side only for now).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Legacy cases | Explicit bootstrap org; all existing accounts become members | design rule 1; nobody loses access |
| D-2 | Default role for new accounts | `provider` until 019 opens sign-up | dashboard-created accounts can't set metadata; membership is the gate |
| D-3 | Platform admin clinical access | Only via membership | least privilege for child data |
| D-4 | Unauthorised id | 404 with the route's message | no cross-tenant existence leak |
| D-5 | Invitation for a non-existent account | Admin creates the account; 019 adds Google sign-in | sign-up still disabled |

## Open questions

None.
