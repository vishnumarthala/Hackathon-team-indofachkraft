# 054: Paediatrician referral kit - Evaluation

## Automated checks

- `npm run verify` exits 0 (against a local Supabase with all migrations applied, including
  `20261120005400_screen_referrals.sql`).
- `npx vitest run tests/referral-kit.test.ts tests/referral-kit.db.test.ts tests/screen-*.test.ts tests/i18n-keys.test.ts
  --reporter=verbose` exits 0, covering:
  - `parseRef` / `referralUrl` / `isReferralUrl` / `referralQrSvg`: only `<app>/screen?ref=<slug>` is encoded; bad
    slugs, base URLs with a path, `javascript:` and extra parameters are refused.
  - Slug → note: a verified + listed profile shows "Referred by <name> · <type>" (en, te, hi). An unknown, unlisted or
    malformed ref shows no note, raises no error, and the check-in renders. A malformed ref never reaches the database.
  - The fresh loader passes `SHOW_SYNTHETIC_LISTINGS` through as `/p/<slug>` does.
  - The start request carries `ref` only when there is a referral; a malformed `ref` is dropped, never a 400.
  - DB: a listed slug stores `referred_by_profile_id`. Unlisted, unknown, malformed and client-supplied ids store
    null with 201. Demo profiles follow the flag. The 30-day count excludes older rows. Deleting the profile sets
    null. `screen_sessions` columns list updated.
  - Poster page: verified + listed renders the A4 poster (3 headlines, QR SVG, URL, referrer, footer, count). Pending,
    unlisted and no-profile cases render the explanation and no QR code.
  - i18n parity and copy rules (hi/te "not a diagnosis" wording) pass; `REVIEW.md` regenerated.

## Acceptance checks

### E-1: Poster (FR-4)

Sign in as a verified + listed provider, then open Profile → Waiting-room poster. Print preview shows one A4 page
with no app header and no nav. Scanning the QR code with a phone opens `/screen?ref=<slug>`.

### E-2: Referred check-in (FR-2, FR-3)

At 390 px, `/screen?ref=<slug>` shows the "Referred by" note above the title. Finish a tap check-in. The row has
`referred_by_profile_id` set, and the poster page count goes up by 1.

### E-3: Ignored ref (FR-1)

`/screen?ref=nobody-here` and `/screen?ref=<unlisted slug>` look exactly like `/screen`, and the check-in stores null.

### E-4: Not verified (FR-4)

A pending provider sees "available once your profile is verified and listed", with no QR code.
