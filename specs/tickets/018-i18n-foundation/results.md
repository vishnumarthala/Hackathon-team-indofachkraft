# 018: i18n foundation (English, Hindi, Telugu) - Results

Branch: `ticket/018-i18n-foundation`. Tested against an isolated local Supabase stack (project `dnmslot4`,
ports 603xx, all five migrations applied), `DEMO_MODE=true`, dev server on port 6100, real Chrome driven by
Playwright (scripted, synthetic accounts and cases only, deleted afterwards). Screenshots and the raw browser
results are in `evidence/` (`browser-checks.json`).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113001800_i18n_preferred_locale.sql` | PASS | `user_profiles` gains nullable `preferred_locale` (check `en`/`hi`/`te`) and `time_zone`; existing rows untouched; DB test: `update ... set preferred_locale = 'fr'` rejected by the check |
| `npm run lint`, `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (DATABASE_URL from the stack) | PASS | 38 files, 504 passed, 10 skipped. DB suites ran (orgs-authz, extraction, speakers, ask, i18n-locale). The 10 skips are the pre-existing ticket 010 block in `intake-completion.test.ts`, which also needs `CT_DB_TESTS=1` plus a `.env.local` file that this environment's content policy blocks |
| `npx vitest run tests/i18n-keys.test.ts tests/i18n-format.test.ts tests/i18n-locale.test.ts --reporter=verbose` | PASS | 3 files, 42 passed: key parity, identical `{placeholders}`, `_one`/`_other` pairs, copy rules (en `diagnos` only in "not a diagnosis"; `निदान`/`నిర్ధారణ` only inside those keys; no HIPAA), names kept, REVIEW.md complete; `formatInr(15000000, "en")` = `₹1,50,000`, `2026-11-12T20:00Z` -> `13 Nov 2026` in Asia/Kolkata, Latin digits in hi/te; resolver order cookie > profile > case language > Accept-Language > en with mocked headers/cookies, invalid cookies ignored; anonymous resolution never calls auth; API 400 body, cookie attributes, Secure in production; DB: choosing `hi` saves the profile and a fresh session resolves Hindi |
| `npm run build` | PASS | exit 0; `/api/locale` in the route list |
| E-1 switch language anonymously | PASS | `Accept-Language: te-IN`: `<html lang="te-IN">`, Telugu hero (`సెషన్ సమయం పిల్లల కోసం, కాగితాల పని కోసం కాదు.`), Noto Sans Telugu loaded (`evidence/E-1-te.png`). Selecting `English` in `భాష`: same URL `/`, `lang="en-IN"`, English hero; cookie `dnm_locale=en` HttpOnly, SameSite Lax, Path `/`; reload stays English. On `/login?next=%2Fdashboard%2Fpilots` switching keeps the query. `POST /api/locale {"locale":"fr"}` -> 400 `{"error":"Invalid request","details":{"locale":"Choose English, Hindi or Telugu"}}`, no cookie |
| E-2 signed-in preference | PASS | Synthetic provider signs in (English), chooses `हिन्दी` in the header: `user_profiles.preferred_locale = 'hi'`. New browser context (no cookies) signs in: `lang="hi-IN"`, Hindi header (`डैशबोर्ड`, `साइन इन करें`, `भाषा`), no `dnm_locale` cookie needed (`evidence/E-2-*.png`) |
| E-3 intake page locale | PASS | Synthetic `te` case, no cookie, `Accept-Language: en-US`: `lang="te-IN"`, Telugu text, call-language select = `te`, consent and `కాల్ ప్రారంభించండి` translated, Start disabled until consent ticked, enabled after. Switching UI to English: call language stays `te`, label `Call language`, `Start call` shown (`evidence/E-3-*.png`) |
| E-4 layout at 375 px | PASS | `scrollWidth = 375` for `/`, `/login`, `/intake/<token>`, `/book-demo` in `te` and `hi`; an element-level scan also found no text wider than the viewport (one Telugu headline overflow found and fixed) (`evidence/E-4-*-375.png`) |
| E-4 payload | PASS | `/` in `en` (HTML and `RSC: 1` payload): 0 hits for `కాగితాల పని కోసం కాదు`, `మళ్ళీ స్వాగతం`, `ఎర్లీ ఇంటర్వెన్షన్ థెరపిస్టుల కోసం`, `నిర్ధారణ కాదు`. Client JS chunks (dev and production build) contain no Hindi/Telugu catalogue strings; messages arrive only in the RSC payload of the active locale (a few pure helpers keep English defaults in code, e.g. pilot validation messages, checked against `en.json` by the key test) |
| E-5 guide and review list | PASS | `docs/i18n.md` covers adding a key, naming, plurals, interpolation, what is not translated (instrument items, AI output, `DoctorNearMe`, `CareThread`), review workflow, and the rule that every new UI string goes through `t()`. `messages/REVIEW.md` lists all 382 keys with en/hi/te, reviewer, status (`pending`) and is checked by the key test |
| FR-5a viewer time zone | PASS | Browser in `Europe/Berlin`: `TimeZoneSync` sets `dnm_tz=Europe/Berlin`. Browser in `America/New_York` signed in: dashboard dates `2026-11-12 17:22 GMT-5` (`evidence/FR-5a-dashboard-new-york.png`); pilots list uses `formatDateTime` in the viewer's zone |
| FR-10 book-demo validation | PASS | Telugu: `మీరు ఎవరో ఎంచుకోండి`, `పేరు తప్పనిసరి`, `సరైన ఈమెయిల్ ఇవ్వండి`, `దేశం తప్పనిసరి` (`evidence/FR-10-book-demo-te-validation.png`) |

## Deviations

- **Call-language label.** The intake call select is labelled `Call language` (translated) instead of
  `Language`, because the page header now also has the UI `Language` switcher; two controls with the same
  accessible name would be ambiguous. Same for the landing voice demo.
- **Intake page switcher.** `/intake/<token>` gets the switcher from the shared `SiteChrome` header (shown
  on that page) rather than a second one in the page body.
- **Case workspace dates.** `lib/cases/format.ts` helpers take the viewer's zone (default `Asia/Kolkata`
  instead of the old `Europe/Berlin`); `/dashboard` and `/dashboard/pilots` pass `getTimeZone()`. Case
  workspace pages (`app/cases/**`, `/specialist`) are on the ticket's don't-touch list, so they use the
  `Asia/Kolkata` default for their date-only labels; each later ticket that touches them should pass
  `getTimeZone()`.
- **Two pages outside FR-10 changed** only for FR-5a (time zone): `app/dashboard/page.tsx`,
  `app/dashboard/pilots/page.tsx` (named in the ticket).
- **API error text stays English** (contract); the intake and book-demo clients map known answers
  (404/409, validation) to translated messages. Client-side validation now uses translated messages from
  the shared schema factory `pilotSignupSchema(messages)`.
- **Landing navigation breakpoint** for the inline links moved from `lg` to `xl` so longer Telugu labels fit
  next to the switcher; below `xl` the menu button is used.
- **Hindi/Telugu copy** is a first draft by the worker, all rows `pending` in `messages/REVIEW.md`
  (pilot launch checklist item; human task).

## Notes

- **Database slot.** The assigned slot-1 ports (57321/57322) were taken over during the run by an unrelated
  Supabase project (`overseasscholar`); the slot-1 stack no longer existed. Before this was noticed, one
  synthetic auth user (`t018-provider@example.com`) was created in that foreign stack; it was deleted
  immediately and nothing else was written there. All checks above ran on a new isolated stack started
  with the helper as slot 4 (ports 603xx; dev server on 6100 because Chrome blocks port 6000). That stack is
  left running.
- **New helpers for later tickets:** `getT(ns?)`/`useT(ns?)`, `getLocale()`/`useLocale()`,
  `getTimeZone()`/`useTimeZone()`, `getFormatter()`/`useFormatter()` (`date`, `dateTime`, `time`, `number`,
  `inr`), `LanguageSwitcher`, `tests/helpers/i18n.ts` `withI18n()` for rendering client components in tests,
  `npx tsx scripts/i18n-review.ts` to regenerate `messages/REVIEW.md`. No new env vars.
- `proxy.ts` now sets request header `x-dnm-path` (pathname, client value overwritten) on every request so
  the root layout can resolve the intake case language; no locale redirect, no `[lang]` segment.
- Letter-spacing (`tracking-*`) is disabled for Hindi/Telugu in `app/globals.css` (it breaks Indic shaping);
  `.lp-display` headlines wrap long words (`overflow-wrap: anywhere`).
- Every page is now dynamic (the root layout reads cookies and headers).
