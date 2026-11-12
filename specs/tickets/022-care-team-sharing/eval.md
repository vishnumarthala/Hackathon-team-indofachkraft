# 022: Care team and sharing grants - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`, plus a second member `provider_a2` in org A
  (script flag `--extra-member`). One child of `guardian_a` with a case in org A and a case in org B
  (claim flow from 020).
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/case-access.test.ts tests/sharing-grants.test.ts --reporter=verbose` exits 0,
  covering the full matrix: {owner, admin, assigned member, unassigned member, removed member, other-org
  provider, platform_admin, guardian} x {list, read, write} for cases, and grant states {none, active,
  wrong scope, expired, revoked} x `requireSharedAccess`.
- Static test: every `app/api/cases/**` and `app/api/sessions/**` route calls `requireCaseAccess`
  (or a stricter helper) before any DB read.

## Acceptance checks

### E-1: Assignments (FR-1, FR-2, FR-3)

1. Backfill: every case has >= 1 active lead.
2. As `provider_a2` (unassigned member): case missing from the list; direct `/cases/<id>` URL -> 404 and `PATCH /api/cases/:id` -> 404.
3. As `org_admin_a`, `Add provider` `provider_a2` as `Member` / `Occupational therapist`; `provider_a2` now sees the case.
4. Remove the only lead -> 409 message. Add `provider_b` -> 422 message.
5. Remove `provider_a2`; their open case page returns 404 on refresh.

### E-2: Guardian care team and grant (FR-4, FR-5)

1. As `guardian_a`, `/family/children/<id>/team` lists org A and org B providers.
2. Share org A -> org B with `Reports` only, `3 months`. Audit `sharing.granted`.
3. Grant to an org without a case -> 422 message.

### E-3: Shared access is scoped (FR-2, FR-6)

1. Finalise one report and leave one draft on org A's case. As `provider_b`, `Shared with us` lists org A
   with only the finalised report; opening it audits `sharing.viewed`.
2. `requireSharedAccess(child, "documents")` for `provider_b` -> denied.
3. Expire the grant via SQL (`expires_at` in the past) -> access denied immediately.
4. Revoke from guardian UI -> denied; audit `sharing.revoked`.

### E-4: Platform admin and guardian negatives (D-3)

1. `platform_admin` (not an org member) opens `/cases/<id>` -> 404 and `PATCH /api/cases/:id` -> 403/404 (017 semantics).
2. `guardian_b` calls `POST /api/family/children/<guardian_a's child>/sharing-grants` -> 404.
3. `provider_a` calls the grant API -> 403.

## Definition of done

- [ ] All checks pass with evidence in `results.md` (access-matrix test output attached).
- [ ] A builder reviews results and manually merges the passing ticket branch.
