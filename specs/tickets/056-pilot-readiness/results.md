# 056: Pilot readiness - Results

Built on `main` in the working tree (not committed), 2026-11-20. The database checks ran against an isolated local
Supabase for this project (port 58322, every migration applied). Other local projects held the default port 54322:
earlier "missing column" failures came from tests reaching another project's database.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run typecheck`, `npm run lint` | PASS | exit 0 |
| `npx vitest run tests/pilot-readiness.test.ts` | PASS | 18 tests including the database scope test |
| Full suite (`npx vitest run`, isolated DB) | PASS | 2004 passed, 25 skipped in 2 of 3 consecutive runs. The third run failed 16 tests across unrelated suites with "Database connection error" or `PGRST000`: local PostgREST ran out of connections under parallel load, with 3 other Supabase stacks on the same Docker |
| `npm run build` | PASS | |
| Figma | done | `/dashboard — Set up your centre (056)` [50:926](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=50-926) and `/family/login — Google only until DLT (056)` [50:1009](https://www.figma.com/design/TC6dXgwufo6XhhHh871wKo/?node-id=50-1009); `/for-centres` (44:947) shows the free-pilot copy |

## Files

- `lib/family/auth-settings.ts`
- `components/family/FamilyLoginForm.tsx`, `components/family/SignInMethods.tsx`
- `app/family/login/page.tsx`, `app/family/(portal)/settings/page.tsx`
- `lib/readiness/pilot.ts`, `app/admin/ops/page.tsx`
- `lib/dashboard/setup.ts`, `components/dashboard/SetupChecklist.tsx`, `app/dashboard/page.tsx`
- `messages/{en,hi,te}.json`: `family.login.phoneUnavailable` / `noMethods`, `dashboard.setup.*`,
  `privacy.admin.ops.readiness.*`
- Docs: `docs/pilot-runbook.md`, `docs/guardian-auth.md`, `.env.example`
- Also fixed: `tests/screen-red-flags.test.ts` now stubs `DEMO_MODE=true` for voice starts (it depended on the
  developer's `.env.local`).

## Not verified

- The admin readiness card and the dashboard checklist in a browser with a signed-in admin or provider (both are
  covered by tests).
- A native-speaker review of the new Hindi and Telugu copy (`pending` in `messages/REVIEW.md`).
