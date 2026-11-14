# 053: Design-system alignment (teal primary actions, shared UI primitives) - Results

Branch: `ticket/053-design-alignment`. Tested against the isolated local Supabase stack of slot 6 (ports 623xx, all
migrations of the branch base), `DEMO_MODE=true`, dev server on port 3060, headless Chromium (Playwright core).
Synthetic accounts and data only (`npm run seed:hyderabad -- --count 24` for the directory, plus a seed script for a
centre owner, a parent with one child and a visit, a platform admin and one pending credential submission). No
migrations, no new dependencies, no new env vars.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0 ([gates.txt](evidence/gates.txt)) |
| `npx vitest run` (full suite, DB suites running) | PASS | run C: 113 files, 1950 passed, 11 skipped (the usual env-gated skips). Runs A and B each had different known-flaky DB timing failures (A: fees-flow, iep-access "Database connection error", payments-flow; B: outbox); none repeated, and the five flaky files pass in isolation (76/76). See [gates.txt](evidence/gates.txt) |
| `npx vitest run tests/design-guard.test.ts` | PASS | 2 tests: the scanner self-test (flags slate primary `<button>`/`<Link>`/`<a>` via literals, template literals, constants and helper functions; ignores `<div>` dark surfaces, `backdrop:` and `hover:` prefixes) and the repo scan: 0 matches in `app/**` + `components/**` (landing excluded), `ALLOWED` empty. Before the migration the same scan found 116 elements in 60 files ([guard-before.txt](evidence/guard-before.txt)) |
| `components/ui` unit tests (`tests/ui-primitives.test.ts`) | PASS | 44 tests: Button variants/sizes render the expected classes (teal primary, focus ring `ring-2 ring-teal-600 ring-offset-2`, `min-h-11`); `disabled` sets `disabled` + `aria-disabled`; `loading` sets `aria-busy` + `aria-disabled` + spinner; `href` renders `<a>`, disabled link renders `<a>` without `href`; `asChild` merges onto `<a download>`; Badge 6 tones; Alert 4 tones (role only when passed); Card, EmptyState, TextField/Select labelling + `aria-invalid`/`aria-describedby` |
| NFR-2 contrast AA | PASS | the same test file computes WCAG ratios from the shipped Tailwind v4 palette (oklch): white on teal-700 5.39, disabled slate-600 on slate-200 6.14, secondary disabled slate-500 on slate-50 4.55, ghost disabled slate-500 on white 4.77, white on red-700 6.42; Badges 5.88-9.44; Alerts 5.88-8.88 |
| E-1 visual check, 390 and 1440 px | PASS | before/after full-page screenshots of `/family`, `/dashboard`, `/cases/[id]`, `/find`, `/book/[id]`, `/admin/verifications` (`evidence/before-*.png`, `evidence/after-*.png`, counts in [before-shots.txt](evidence/before-shots.txt) / [after-shots.txt](evidence/after-shots.txt)): every page has 0 `bg-slate-900 text-white` buttons/links after (before: 1 on case, find, book, admin), primary actions are teal (FACP save, Search, Approve, New case, Continue); no horizontal overflow (scrollWidth = viewport) |
| E-1 focus rings when tabbing | PASS | the run tabs to the first teal action and captures it: `evidence/focus-{family,dashboard,case,find,admin-verifications}-{390,1440}.png` show the white offset + teal-600 ring (`/book` has no enabled teal action before a time is picked: its Continue is disabled, see `after-book-390.png`) |
| E-2 attendance (044) unchanged | PASS | 044's acceptance script re-run unchanged against this branch (only its seed service moved from the retired `at_clinic` to `online`, constraint from 045): 21 PASS, 0 FAIL, incl. marking, correction "Save change" (migrated button) with the audited reason, CSV export ([e2-attendance-044-rerun.txt](evidence/e2-attendance-044-rerun.txt)) |
| E-2 booking unchanged | PASS | parent at 390 px on a demo provider: Continue disabled until a time + demo acknowledgement, Confirm books (`confirmed`, `is_demo`), the "My appointments" `Button href` navigates; no page errors ([e2-booking-consent.txt](evidence/e2-booking-consent.txt), `e2-booking-confirm-390.png`) |
| E-2 consent unchanged | PASS | owner records paper consent: "Save paper consent" is `type="submit"` and submits; `consent_records` paper rows 0 -> 1; the case page then shows "Allowed · On paper" (`e2-paper-consent-1440.png`, `after-case-1440.png`) |
| FR-6 docs | PASS | `docs/design-system.md` §4 maps every primitive to its Figma component id, documents the guard and the deliberate exceptions; the "primary button colour" gap is removed from §7 |

## What changed

- **`components/ui/`** (new): `Button` (+ `buttonClasses`, `focusRing` in `variants.ts`), `Badge`, `Alert`,
  `TextField`, `Select` (+ `controlClasses`), `Card`, `EmptyState`, `cn`, barrel `index.ts`. No `"use client"`, no hooks
  except `useId` in the field wrappers, so they work in Server and Client Components.
- **FR-2**: 78 files in `app/` and `components/` migrated (112 `<Button>` uses in 56 files; a codemod converted the
  simple cases and kept `type="submit"` where a `<button>` had no `type`, the rest by hand). Shared class constants
  (`components/providers/request.ts` `buttonClass`/`secondaryButtonClass`, `components/documents/styles.ts` provider
  primary) now come from `buttonClasses()`, so the elements that still use them (e.g. `<label>` file pickers,
  `<summary>`) are teal too. Selected states of segmented controls/tabs (`/find` list/map, schedule day/week, admin
  ratings tabs, consent-form language, ISAA rating buttons) use the existing `border-teal-700 bg-teal-700 text-white`.
- **FR-3**: 26 `Badge` uses in 15 files (case status on the case header and dashboard list, assessment/IEP/home-program/
  prescription/series/appointment statuses via tone maps `STATUS_TONES`, `PLAN_STATUS_TONES`, `GOAL_STATUS_TONES`,
  archived/moved/stopped/unpublished/red-flag/shared labels, intake labels) and 15 `Alert` uses in 13 files (error and
  warning notices with their previous `role`). Copy is unchanged.

## Deviations

- **FR-5 as a test, not ESLint** (D-2): `eslint.config.mjs` has local edits in the main checkout, so the guard is
  `tests/design-guard.test.ts` (TypeScript-parser based, stricter than a `no-restricted-syntax` selector: it follows
  constants across imports and through helper functions).
- **Code-only sizes**: `Button size="lg"` (min-h-12, the one big mobile action, used by the intake call buttons) and
  `Badge size="md"` (the roomier family-portal card pill) are not Figma variants; documented in §4.
- **Not migrated on purpose** (documented in design-system.md §4): violet "Demo profile"/"AI" labels (no Figma Badge
  tone), red-flag emergency boxes (`border-2` safety styling), journey-timeline and payment labels (colours defined in
  `lib/`), attendance status colours, the already-teal family buttons built on `PhoneOtpForm`'s `primaryButtonClass`,
  and the landing pages (FR-4).
- Visual (not behavioural) changes: disabled primary buttons are slate-200/slate-600 instead of a faded colour (AA),
  buttons use `rounded-lg`/`font-semibold` like the Figma Button, `size="sm"` buttons grew to the 44 px target.
- `node_modules` in the worktree lacked `qrcode`/`@types/qrcode` (already in `package.json` from 045); `npm install`
  restored them, no manifest change.

## Notes

- The after screenshots of `/family` show the extra demo visits booked by the E-2 booking run.
- Use `<Button>` for new primary actions; for a class string in a `.ts` module use `buttonClasses()` from
  `@/components/ui/variants` (no React import). Default `type="button"`: pass `type="submit"` inside forms.
- Scripts used for the evidence (seed, screenshots, flows, 044 re-run) live in the session workspace, not in the repo.
