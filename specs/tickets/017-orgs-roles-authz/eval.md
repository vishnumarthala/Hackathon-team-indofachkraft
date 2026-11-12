# 017: Organisations, roles and authorisation - Evaluation

## Setup

Local Supabase running; `npm run db:reset` (or apply the new migration on a DB that already has the
three earlier migrations and some cases/accounts). Read `node_modules/next/dist/docs/` before changing
routes or pages. Synthetic data only.

## Automated checks

- `npm run lint`, `npm run typecheck`, `npm test` exit 0 with `DATABASE_URL` set (DB suites run).
- `tests/authz.test.ts`: unauthenticated -> 401; guardian -> 403; provider of org A on org B's case,
  recording, report and fact -> 404 with the route message; member of A -> allowed; revoked member -> 404;
  platform admin without membership -> 404.
- `tests/orgs.test.ts`: create org (owner set); invite by owner/admin only; token stored as hash; accept
  with wrong email 403, expired/revoked/used 404, success promotes guardian -> provider; last owner
  cannot be revoked (409).
- `tests/orgs-migration.db.test.ts` (DB): applying the migration to a DB with legacy cases and accounts
  assigns every case to the bootstrap org, maps roles, and leaves `cases.org_id` not null.

## Acceptance checks

### E-1: Legacy access preserved
After migrating a DB with existing cases, an existing therapist account still sees every legacy case on
`/dashboard` and can open each tab.

### E-2: Tenant isolation
Create a second org and a provider in it. That provider's dashboard is empty; requesting a legacy case
page or any FR-4 API with a legacy id gives 404.

### E-3: Onboarding
Owner invites `new@example.com` as member, the invited account signs in, opens `/invite/<token>`,
accepts, and sees the org's cases. The owner revokes the member; the next request returns 404.

### E-4: Case creation
A provider with one org creates a case without choosing; with two orgs the form shows `Organisation`
and the API rejects a missing `org_id` with 422.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] `docs/system-design.md` authentication section describes orgs, roles and the bootstrap org.
