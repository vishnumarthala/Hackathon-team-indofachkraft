# 014: Landing page and pilot sign-up

**Status:** done
**Mode:** solo
**Runs:** waits for 001: replaces the placeholder home page and uses the pilot_signups table

## Summary

Customer validation is 25% of the score. A clear landing page explains CareThread in one screen and
collects "Join the pilot" sign-ups from therapists, centres and parents; a simple list page lets Role D
count them for slide 3.

## Functional requirements

- **FR-1** - `/` replaces the placeholder: `<h1>CareThread</h1>`; subtitle exactly
  `CareThread is the AI assistant for early intervention therapists. It talks to the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.`;
  three cards `1. Intake call`, `2. Online session`, `3. Specialist handoff` with one sentence each;
  the line `AI documents, the clinician decides.`; no pricing on the page (see D-5); a button-styled link
  `Join the pilot` to `#pilot`; a link `Open the demo` to `/dashboard`.
- **FR-2** - Form in `<section id="pilot">` with labelled fields: `Name` (required), `Email` (required),
  `I am a` (select: `Therapist`, `Child psychologist`, `Centre owner`, `Parent`, `Other` -> values
  `therapist`, `psychologist`, `centre_owner`, `parent`, `other`), `Country` (required),
  `Centre (optional)`, `Number of clinicians (optional)`, `Anything we should know? (optional)`, a hidden
  honeypot input `website` (not focusable, `aria-hidden`), and a submit button `Join the pilot`. Success
  replaces the form with `Thanks, you're on the pilot list. We'll contact you soon.` Validation errors
  appear under each field.
- **FR-3** - `POST /api/pilot-signups` body `{ name (1-100), email (valid, trimmed, lower-cased), role,
  country (2-60), centre? (<=100), clinicians? (1-1000 integer), note? (<=1000), website? }`. Messages:
  `Name is required`, `Enter a valid email`, `Choose who you are`, `Country is required`,
  `Clinicians must be between 1 and 1000`. Non-empty `website` -> 200 `{ ok: true }` without saving.
  Existing email -> 200 `{ ok: true }` without changes. New -> insert, audit `pilot.signup` (case null,
  actor `system`), 201 `{ ok: true }`.
- **FR-4** - `/dashboard/pilots`: `<h1>Pilot sign-ups</h1>`, `<n> sign-ups`, and a table `Name`, `Email`,
  `Role`, `Country`, `Centre`, `Clinicians`, `Date` (newest first; `Date` as `YYYY-MM-DD HH:mm`
  Europe/Berlin).
- **FR-5** - Page metadata: title `CareThread - AI assistant for early intervention therapists`, a
  meta description with the subtitle's first sentence.

## Non-functional requirements

- **NFR-1** - `/` has no horizontal scroll at 375 px and loads without console errors.
- **NFR-2** - Copy rules: no `diagnos` (except `not a diagnosis`), no `HIPAA compliant`, no
  `fee per referral`.

## Affected areas

- `app/page.tsx` (changed: placeholder -> landing)
- `components/landing/*.tsx` (new)
- `app/api/pilot-signups/route.ts`, `app/dashboard/pilots/page.tsx`, `lib/queries/pilots.ts` (new)
- `tests/pilot-validation.test.ts` (new)

## Don't touch

- `app/layout.tsx` (banner and header stay), `app/dashboard/page.tsx` (004), `lib/types.ts`,
  `supabase/migrations/**`, `package.json`

## Out of scope

- Email confirmation to the person signing up, CAPTCHA, analytics, pricing page, blog.
- A link from `/dashboard` to `/dashboard/pilots` (reach it by URL).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Show prices? | Yes, as "pilot pricing" | testing the price hypothesis is part of validation |
| D-2 | Duplicate email | Same success message, no update | no account enumeration, no errors for repeat visitors |
| D-3 | Spam | Hidden honeypot field | no CAPTCHA dependency |
| D-4 | Phase 1 wording | "talks to the parent" (browser call), not "calls" | no phone calls today (team plan) |
| D-5 | Show prices? (replaces D-1) | No pricing on the landing page; languages listed English and German first, then Hindi and Telugu | Role D decision 2026-11-07: focus the page on the product; price is tested in the validation calls instead |

## Open questions

None.
