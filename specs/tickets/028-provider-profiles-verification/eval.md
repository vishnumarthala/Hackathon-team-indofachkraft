# 028: Provider profiles and verification - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes: caching/revalidation, metadata,
  dynamic params) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; a fresh email user for self-registration.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. Synthetic names and fake registration numbers
  (`TEST-<acct>-001`) only; never real practitioners' data in tests.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/provider-profiles.test.ts tests/verification.test.ts tests/claim-link.test.ts --reporter=verbose` exits 0:
  `provider_can_prescribe` truth table (type x status x council); registration edits reset status;
  claim token single-use/expiry/hash-only; role escalation attempts (`POST /api/providers/register` by
  a guardian with child links -> 403; body `role`/`verification_status`/`can_prescribe` ignored).

## Acceptance checks

### E-1: Self-register -> verify -> listed (FR-2, FR-3, FR-4, FR-7, FR-8)

1. Sign up at `/join` as `Speech-language pathologist`; lands on `/dashboard/profile`; `/p/<slug>` -> 404.
2. Fill profile, submit RCI registration with a synthetic PDF; `Show my profile publicly` disabled.
3. As `platform_admin`, approve. Provider gets a notification; toggle listing; `/p/<slug>` shows the
   badge with masked number, no email.
4. Change `registration_number` -> status `pending`, page 404 again.

### E-2: Seed + claim (FR-5, FR-6)

1. Admin seeds `<acct> Synthetic Child Clinic` (centre) with one paediatrician; creates claim link.
2. Open the link signed in as a fresh user -> `Claim this profile` -> user is org owner, profile `claimed`.
3. Reuse link -> invalid message. Generate a new link -> old one invalid.

### E-3: Prescriber derivation (FR-1)

Verified `pediatrician` with `NMC` -> `provider_can_prescribe = true`; verified `child_psychologist` ->
false; `pediatrician` suspended -> false.

### E-4: Authz negatives

Provider calls `/api/admin/providers` -> 403; provider edits another provider's profile -> 404;
guardian visits `/dashboard/profile` -> redirect `/family`; unlisted/unverified/synthetic (flag off) profiles
never appear on `/p/*` or `/c/*`.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
