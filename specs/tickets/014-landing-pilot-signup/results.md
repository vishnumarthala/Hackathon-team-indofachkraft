# 014: Landing page and pilot sign-up - Results

Date: 2026-11-07. Branch: `ticket/014-landing-pilot-signup`, merged into `int/d-pitch`.
Base: latest `origin/main` (001, 002, 003, 004, 005, 007 merged in).

## Status

Code complete. Checks that need no database pass. **The database checks (E-2 steps 9-10, E-3 step 4) are
still pending**: this laptop has no `.env.local` with the shared Supabase values yet. Ticket stays
`draft` on the board until those pass.

## Automated checks

| Check | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | 153 of 154 pass. All 19 tests in `tests/pilot-validation.test.ts` pass. The one failure is `tests/fixtures.test.ts` (ticket 002): on Windows with `core.autocrlf=true` the committed `scribe-response.json` is checked out with CRLF line endings, while the generator writes LF. Not caused by 014; passes on Linux CI. |
| `npm run build` | pass |

## Acceptance checks

| Check | Result | Evidence |
|---|---|---|
| E-1 landing content | pass: subtitle, `1. Intake call`, `2. Online session`, `3. Specialist handoff`, `AI documents, the clinician decides.`, `Join the pilot`, `Open the demo` -> `/dashboard`; title `CareThread - AI assistant for early intervention therapists`; no `Pilot pricing` | `evidence/E-1.png` |
| E-2 sign-up through the form | pending (needs Supabase env) | - |
| E-3 step 1 validation | pass: 400 with `Name is required`, `Enter a valid email`, `Choose who you are`, `Country is required`, `Clinicians must be between 1 and 1000` | curl |
| E-3 non-JSON body | pass: 400 `{"body":"Body must be JSON"}` | curl |
| E-3 step 3 honeypot | pass: `{"ok":true} 200`, nothing saved | curl |
| E-3 steps 2 and 4 (duplicate, DB rows) | pending (needs Supabase env) | - |
| E-4 mobile 375 px | pass: no horizontal scroll (checked in a 375 px frame) | `evidence/E-4-mobile-375.png` |
| E-4 copy rules | `clean` | grep |
| E-5 unit tests | pass (19 tests) | vitest |

## Changes beyond the original rd.md

- **D-5 (Role D decision):** no pricing on the landing page. Languages are listed English and German
  first, then Hindi and Telugu. FR-1 and E-1 were updated to match.
  Note: `LanguageSchema` in `lib/types.ts` (001) only has `en`, `hi`, `te`; German is not built yet.
- New files outside the listed affected areas: `lib/pilots.ts` (validation schema shared by the form
  and the API, kept out of `lib/types.ts` per D-5 of 001) and `components/landing/landing.css`.
- `landing.css` is plain global CSS with an `lp-` prefix, not a CSS module: `next.config.ts` (001)
  routes every `*.css` through `@tailwindcss/turbopack` as global CSS, so CSS module class names come
  back empty. Worth fixing in 001 if other tickets want CSS modules.
- Animations respect `prefers-reduced-motion`. The sign-up form is never hidden behind a JS animation.
