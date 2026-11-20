# 054: Paediatrician referral kit (QR poster, "referred by" check-in)

**Status:** done (PMF check recommendation 7, 2026-11-20)
**Mode:** solo
**Runs:** alongside

## Summary

The [PMF check](../../grill/doctornearme-pmf-check.md) §3d and §5 (recommendation 7) found no journey for the
paediatrician, the gatekeeper most families see first (74% in one study). The low-cost version is a printable
Telugu/Hindi/English QR poster for the waiting room. It links to the check-in with "Referred by Dr X", and the pilot
can count check-ins per poster.

## Functional requirements

- **FR-1** – Referral link `/screen?ref=<slug>`. `<slug>` is the public profile slug of a **verified + listed**
  provider profile, resolved with the public-profile loader (`lib/providers/public.ts`), so demo profiles follow
  `SHOW_SYNTHETIC_LISTINGS` exactly as `/p/[slug]` does. Unknown, unlisted or malformed slugs are silently ignored:
  the check-in works normally, with no error and no leak.
- **FR-2** – With a valid ref, `/screen` shows a small calm note at the top: "Referred by <display name>" plus the
  provider type label, in en/hi/te (`messages/*.json`; new hi/te rows `pending` in `messages/REVIEW.md`). The flow is
  unchanged: tapping is free, voice needs sign-in, a red flag shows 108/112.
- **FR-3** – Migration `20261120005400_screen_referrals.sql`: `screen_sessions.referred_by_profile_id uuid null
  references provider_profiles(id) on delete set null`, plus an index. ScreenFlow sends the slug as `ref` with the
  session-create request; the server resolves it to the profile id itself and never trusts a client-supplied id. No
  IP, no extra personal data, no audit row (as other anonymous check-in writes).
- **FR-4** – `/dashboard/profile/poster` (linked from `/dashboard/profile`), only for a signed-in provider whose profile
  is verified + listed; otherwise an explanation. A printable A4 poster (print CSS; `@media print` hides app chrome)
  with:
  - the headline in English, Telugu and Hindi ("Worried about your child's speech, play or development? Take a free
    5-minute check-in");
  - a server-side QR code SVG (`qrcode`, `lib/referrals/qr.ts` validates the URL shape) encoding
    `NEXT_PUBLIC_APP_URL/screen?ref=<slug>`;
  - the short URL as text and "Referred by <name>";
  - "Free · no sign-in needed · Not a diagnosis · In an emergency call 108 or 112";
  - a Print button.

  The provider also sees "Check-ins started from your poster in the last 30 days: N" (aggregate only).
- **FR-5** – Uses the 053 primitives (`components/ui`: Alert, Card, Button). `/screen` stays usable at 390 px.
- **FR-6** – Docs: a route row in `docs/design-system.md` §5 (Pilot readiness, Figma "— (designer task)"), and
  `docs/referrals.md` (flow and pilot metric).

## Non-functional requirements

- **NFR-1** – The referral never blocks or slows a check-in in a visible way. A lookup failure is logged and ignored.
- **NFR-2** – Providers see a count only, never anything per family.

## Affected areas

- `supabase/migrations/`, `lib/referrals/**` (new), `lib/screen/{store,client,questions}.ts`,
  `app/api/screen/sessions/route.ts`, `app/screen/page.tsx`, `components/screen/ScreenFlow.tsx`
- `app/dashboard/profile/poster/page.tsx` (new), `app/dashboard/profile/page.tsx`, `app/dashboard/layout.tsx`
  (`print:hidden`), `app/globals.css` (named A4 page)
- `lib/providers/{constants,public}.ts` (slug shape check shared)
- `messages/{en,hi,te}.json`, `messages/REVIEW.md`, `docs/referrals.md`, `docs/design-system.md`
- `tests/referral-kit.test.ts`, `tests/referral-kit.db.test.ts`, `tests/screen-flow.test.ts` (column list)

## Out of scope

- A paediatrician-specific sign-up or dashboard. Feedback to the referrer about the child (needs consent; later).
- Per-poster variants (several posters per provider), UTM-style campaign codes.
- Figma frames for the two screens (designer task).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | What identifies the referrer in the link? | The public profile slug | Already public on `/p/<slug>`; no new token to manage |
| D-2 | Where is the slug resolved? | On the server, twice: on `/screen` (cached, for the note) and at session creation (uncached, for storage) | Never trust a client id; a suspended profile stops counting at once |
| D-3 | Invalid `ref` | Dropped silently (schema `.catch`, resolver returns null) | A broken poster must never block a worried parent |
| D-4 | Metric window | 30 days | Matches the unsaved check-in retention (033 FR-5) |
