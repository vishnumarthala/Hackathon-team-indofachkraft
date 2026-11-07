## Checkpoint PR

<!-- Title: "CP<n>: <role> - tickets 00x, 00y". Base: main. Head: int/<role>. Merge with "Create a merge commit". -->

Tickets in this PR (each one passed its eval.md, results.md committed in its ticket folder):

- [ ] NNN - <title>

## Checklist

<!-- Before ticket 001 exists, mark app and CI checks N/A with a reason instead of claiming they ran. -->
- [ ] I merged the latest `origin/main` into my branch just before opening/updating this PR
- [ ] `npm run verify` passes locally (lint, typecheck, unit tests, build)
- [ ] The app starts on a fresh local DB: `npx supabase db reset && npm run seed:demo && npm run dev -- -p 3000`
- [ ] Only files from my tickets' "Affected areas" changed (`git diff --stat origin/main...HEAD`)
- [ ] New migrations are new timestamped files; no merged migration was edited
- [ ] No secrets, no `.env.local`, no real patient data
- [ ] My rows in `specs/tickets/BOARD.md` (only my table) say `done` for these tickets

## Notes for the merge captain

<!-- New env vars, new npm packages, things to click in the smoke test, known issues. -->
