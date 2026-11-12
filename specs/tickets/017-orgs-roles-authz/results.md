# 017: Organisations, roles and authorisation - Results

Branch: `feat/doctornearme`. Tested against an isolated local Supabase stack (project `dnmtest`, ports
563xx, all four migrations applied by `supabase db reset`), `DEMO_MODE=true`, dev server on port 3123,
integrated browser. Synthetic accounts and data only.

| Check | Result | Evidence |
|-------|--------|----------|
| Migration on legacy data | PASS | DB with an `admin` and a `therapist` account and one case: roles -> `platform_admin`/`provider`; both became bootstrap-org members (`owner`/`member`); case got the bootstrap `org_id`; inserting a case without `org_id` fails (not null); trigger honours `app_metadata.role` |
| RLS | PASS | as `authenticated`: member sees the org's case, non-member sees 0 cases and 0 organisations |
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0; new routes `/api/orgs*`, `/dashboard/team`, `/invite/[token]` in the build |
| `npx vitest run` (local stack) | PASS | 35 files, 464 passed, 10 skipped; existing DB suites (extraction, speakers, ask) run against the new schema |
| `tests/orgs-authz.db.test.ts` | PASS | 11 tests: 401/403/404 gates for case/recording/report/fact; route message preserved; platform admin without membership 404; cross-tenant PATCH 404 and nothing changed; org selection on create (single, foreign 403, none 403, several 422); token stored as hash, wrong email 403, single-use, expired/revoked 404, guardian promoted; concurrent accept -> one success; last owner 409; revoked member 404 immediately; concurrent owner revocations keep one owner; RLS |
| E-1 legacy access | PASS | owner of bootstrap org sees the seeded case on `/dashboard` |
| E-2 tenant isolation | PASS | outsider (provider, no org): empty-state dashboard, `/cases/<id>` 404 `Case not found`, `PATCH /api/cases/<id>` 404 |
| E-3 onboarding | PASS | owner invites `newbie@example.test` (demo mode shows the link); outsider accepting gets `This invitation was sent to a different email`; newbie signs in via the invite's `Sign in` link (`next` back to the invite), accepts, lands on `/dashboard` with the case; all six case tabs return 200 |
| E-4 case creation | PASS | covered by DB tests (UI select only shown with more than one org) |

## Notes

- `DATABASE_URL` from the repo's `.env` files (not readable here) was overridden for these runs; DB tests
  create and delete synthetic rows in whatever database those variables point to.
- Revocation in the browser was not clicked through; it is covered by the DB tests.
- Follow-ups owned by later tickets: guardian default role + Google/phone sign-in (019), consent gating (020),
  audit actor id on all existing routes and durable audit (041).
