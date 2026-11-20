# 054: Paediatrician referral kit - Results

Built on `main` in the working tree (not committed), 2026-11-20. The local Supabase stack was **not running** (Docker
down). The configured `DATABASE_URL` database is missing many migrations (no `provider_profiles`, `guardian_links`,
...), so every `(database)` suite in the repository fails in `beforeAll`, including the new one. No migration was
applied to that database.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run typecheck` | PASS | exit 0 |
| `npm run lint` | PASS | exit 0, no warnings |
| `npx vitest run tests/referral-kit.test.ts` | PASS | 20 tests: link/QR validation (3), slug → referrer incl. lookup error and `SHOW_SYNTHETIC_LISTINGS` true/false (4), schema drops a bad `ref` / `startScreen` sends `ref` only with a referral (2), `/screen?ref=` note en/te/hi + ignored refs + no lookup without ref + voice sign-in keeps `ref` (7), poster page verified / pending / unlisted / no profile (4) |
| `SKIP_DB_TESTS=1 npx vitest run tests/referral-kit*.test.ts tests/i18n-keys.test.ts tests/design-guard.test.ts tests/ui-primitives.test.ts tests/screen-*.test.ts tests/agents-screen-locale.test.ts tests/voice-usage-routes.test.ts tests/parent-landing.test.ts tests/verification.test.ts tests/claim-link.test.ts` | PASS | 10 files passed, 3 skipped (DB-only); 172 passed, 76 skipped |
| Same files with the configured database | FAIL (pre-existing) | Only `(database)` suites fail: `relation "provider_profiles" does not exist`, `relation "guardian_links" does not exist`, `user_profiles_role_check`. The same errors hit the existing screen, voice and i18n DB suites; all non-DB tests pass |
| `tests/referral-kit.db.test.ts` | NOT RUN | Written in the `screen-flow` DB style (migration shape, listed / unlisted / unknown / malformed / client-id refs, demo flag, 30-day count, `on delete set null`). Could not run: the database has no `provider_profiles` table. Run after `npx supabase start && npm run db:reset` |
| `tests/screen-flow.test.ts` column list | UPDATED, NOT RUN | `referred_by_profile_id` added to the E-4.1 list (DB suite) |
| i18n parity / copy rules | PASS | `i18n-keys`: 18 new keys per locale (`screen.referredBy`, `referrals.*`); hi/te "not a diagnosis" wording; `REVIEW.md` regenerated with `npx tsx scripts/i18n-review.ts` (new rows `pending`) |
| Dev-server smoke (`next dev -p 3054`) | PASS | `/screen?ref=dr-unknown-slug-1`, `/screen?ref=%3Cscript%3E` and `/screen` return 200 with the check-in and no note. The lookup error from the incomplete database was logged (`referral lookup failed: ...`) and ignored. `/dashboard/profile/poster` redirects anonymous users to `/login` (307). Server stopped |
| `npm run build` / `npm run verify` | NOT RUN | Needs the local Supabase stack for the DB suites |

## Not verified

- E-1 print preview / A4 single page and scanning the QR code with a phone (needs a verified + listed provider in a
  working database). The poster markup and the QR SVG are covered by the render test.
- E-2 / E-4 end to end in a browser, and the DB suite (see above).
- Hindi and Telugu copy needs a native-speaker review (rows `pending`).

## Notes

- The slug shape check moved from `lib/providers/public.ts` to the pure `isPublicSlug` in
  `lib/providers/constants.ts`, so the referral link helpers stay client-safe. Behaviour is unchanged.
- The dashboard top bar now has `print:hidden`. The site header and banner already had it.
- Regenerating `messages/REVIEW.md` also fixed a stale duplicate "Rows:" header line and the order of one existing
  row (`family.home.greeting`), which is generator output.
