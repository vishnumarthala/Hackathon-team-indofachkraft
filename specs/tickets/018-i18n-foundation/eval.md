# 018: i18n foundation - Evaluation

## Setup

- Before coding, read the relevant guides in `node_modules/next/dist/docs/` (Next.js 16.4 has breaking
  changes; see `AGENTS.md`): `01-app/02-guides/internationalization.md`,
  `01-app/01-getting-started/16-proxy.md`, and the `next/font` API reference.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate` (this ticket adds a migration).
- Start: `DEMO_MODE=true npm run dev -- -p <port>`; base URL `http://localhost:<port>`.
- Test account: a provider login from the 017 seed for the signed-in checks; otherwise anonymous.
- Seed: `npm run -s seed:demo -- --new` for an intake token (case language `te` via `PATCH /api/cases/:id`).
- Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/i18n-keys.test.ts tests/i18n-format.test.ts tests/i18n-locale.test.ts --reporter=verbose` exits 0:
  - every key in `en.json` exists in `hi.json` and `te.json`, no extra keys, every `{var}` placeholder
    set is identical across locales, `_one`/`_other` pairs complete;
  - copy rules: no `diagnos`/`HIPAA` in `en.json` except `not a diagnosis`; the Hindi/Telugu terms
    listed in FR-11 only appear inside the reviewed "not a diagnosis" keys;
  - `formatInr(15000000, "en")` = `₹1,50,000`, dates render in `Asia/Kolkata` (a UTC `2026-11-12T20:00Z`
    input renders 13 Nov), digits are Latin in `hi`/`te`;
  - resolver order (cookie > profile > case language on intake > Accept-Language > en) with mocked
    headers/cookies; invalid cookie values are ignored.

## Acceptance checks

### E-1: Switch language anonymously (FR-3, FR-6, FR-7, FR-8, FR-10)

1. Open `/` with no cookies and `Accept-Language: te-IN,te;q=0.9`. Verify `<html lang="te-IN">`, Telugu
   header/landing text, Telugu glyphs render (screenshot `evidence/E-1-te.png`).
2. Select `English` in `Language`. Verify the same path reloads in English, cookie `dnm_locale=en` is
   `HttpOnly`, and a reload keeps English.
3. `POST /api/locale` with `{ "locale": "fr" }` returns the FR-8 400 body.

### E-2: Signed-in preference (FR-3, FR-8, FR-9)

1. Sign in as the provider, choose `हिन्दी`. Verify `user_profiles.preferred_locale = 'hi'`.
2. Clear cookies, sign in again in a fresh browser: UI is Hindi without choosing again.

### E-3: Intake page locale (FR-3, FR-10)

1. With no cookie, open the seeded `te` case's `/intake/<token>`: UI text is Telugu, call `Language`
   select defaults to `te`, consent checkbox and `Start call` are translated, Start still disabled until
   consent is ticked (009 behaviour unchanged).
2. Switch UI to English: the call-language select keeps `te` (UI locale and call language independent).

### E-4: Layout and payload (NFR-1, NFR-2)

1. At 375 px width, in `te` and `hi`, `/`, `/login` and `/intake/<token>` have no horizontal scroll
   (`document.documentElement.scrollWidth <= 375`). Screenshots in `evidence/`.
2. In `en`, search the HTML/RSC payload of `/` for three Telugu-only strings from `te.json`: none present.

### E-5: Guide and review list (FR-11, FR-12)

Review `docs/i18n.md` covers every FR-12 item; `messages/REVIEW.md` lists every `hi`/`te` key with status.

## Definition of done

- [ ] All automated and acceptance checks pass, with evidence recorded in `results.md`.
- [ ] No pages outside FR-10 changed; no i18n dependency added to `package.json`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
