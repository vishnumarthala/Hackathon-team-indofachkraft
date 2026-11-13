# 050: Parent-first home page - Evaluation

## Automated checks

- `npm run verify` exits 0.
- Page tests:
  - `/` renders the parent hero and links to `/screen`, `/find` and `/family/children/claim`.
  - `/for-centres` renders the existing therapist landing with `Book a demo`.
  - No CDC, Höfer or "German" strings remain in `messages/*.json` landing keys.
  - All three locales have the new keys (the i18n key-parity test passes).

## Acceptance checks

### E-1: Parent at 390 px

Open `/` in Telugu on a 390 px viewport. The hero and both main actions are visible without scrolling, and
the statistics show their sources.

### E-2: Centre owner

Use the nav `For centres`, which opens the existing page; `Book a demo` works.
