# Paediatrician referral kit (ticket 054)

Most families (74% in one study, see the [PMF check](../specs/grill/doctornearme-pmf-check.md) §3d) see a
paediatrician or GP first. The referral kit gives that gatekeeper a zero-effort way to send a worried parent to the
free check-in, and gives the pilot a measurable signal.

## Flow

1. A provider whose profile is **verified and listed** opens **Profile → Waiting-room poster**
   (`/dashboard/profile/poster`). Anyone else sees "available once your profile is verified and listed".
2. They print the A4 poster (Print button; `@media print` hides the app chrome; the sheet uses the named CSS page
   `poster`, A4 portrait, so other printouts are unaffected). It shows, in English, Telugu and Hindi: "Worried about
   your child's speech, play or development? Take a free 5-minute check-in", a QR code, the short link as text,
   "Referred by <name>" and "Free · no sign-in needed · Not a diagnosis · In an emergency call 108 or 112".
3. The QR code encodes `NEXT_PUBLIC_APP_URL` + `/screen?ref=<slug>` (the provider's public profile slug) and nothing
   else. It is generated server-side by `lib/referrals/qr.ts` (`qrcode`, SVG with a viewBox only), which refuses any
   URL that is not exactly that shape.
4. The parent scans it. `/screen?ref=<slug>` shows a calm "Referred by <name> · <provider type>" note (en/hi/te) above
   the normal check-in: tapping is free and anonymous, voice still needs sign-in (the `ref` survives the sign-in round
   trip), red flags still stop with 108/112.
5. When the check-in starts, the browser sends the slug as `ref` with `POST /api/screen/sessions`. The server resolves
   it again and stores `screen_sessions.referred_by_profile_id`. The client never sends an id.

## Rules

- **Only verified + listed profiles count.** The slug is resolved with `loadPublicProfile` / `getPublicProfile`
  (`lib/providers/public.ts`), the same loader as `/p/<slug>`, so demo profiles follow `SHOW_SYNTHETIC_LISTINGS`
  exactly as the public profile page does. `/screen` uses the cached loader; session creation and the poster page use
  the uncached one, so a suspended or unlisted profile stops counting at once.
- **Silently ignored otherwise.** Unknown, unlisted, suspended or malformed slugs and lookup errors give no note, no
  error and no stored referral (`resolveReferrer` in `lib/referrals/index.ts` never throws). A malformed `ref` in the
  request body is dropped by the schema, never a 400.
- **No personal data.** The column holds the provider's profile id, not the family's. No IP, no audit row (as all
  anonymous check-in writes, 033 FR-5). Unsaved check-ins are still deleted after 30 days
  ([retention](privacy/retention.md)); deleting the profile sets the column to null (`on delete set null`).

## Pilot metric

The poster page shows the provider one aggregate number: **"Check-ins started from your poster in the last 30 days:
N"** (`countReferredCheckins`, a `count(*)` on `screen_sessions` over `referred_by_profile_id, created_at`, backed by
the partial index `screen_sessions_referred_by_idx`). Nothing per family is shown.

For the pilot, track per poster (SQL, platform admin):

```sql
select p.display_name, count(*) as checkins_30d,
       count(*) filter (where s.result_band is not null) as finished,
       count(*) filter (where s.saved_child_id is not null) as saved
from screen_sessions s join provider_profiles p on p.id = s.referred_by_profile_id
where s.created_at >= now() - interval '30 days'
group by p.display_name order by checkins_30d desc;
```

Signal to look for: posters in at least 3 paediatric waiting rooms produce check-ins every week, and some of those
families book a visit.

## Files

- `supabase/migrations/20261120005400_screen_referrals.sql`: the column, foreign key and index.
- `lib/referrals/link.ts` (pure): `parseRef`, `referralPath`, `referralUrl`, `shortReferralUrl`.
- `lib/referrals/qr.ts`: `isReferralUrl`, `referralQrSvg`.
- `lib/referrals/index.ts` (server): `resolveReferrer`, `loadReferrerFresh`, `countReferredCheckins`.
- `app/screen/page.tsx`, `components/screen/ScreenFlow.tsx`, `lib/screen/client.ts`, `app/api/screen/sessions/route.ts`,
  `lib/screen/store.ts`: the `ref` path.
- `app/dashboard/profile/poster/page.tsx` (linked from `/dashboard/profile`).
- Tests: `tests/referral-kit.test.ts`, `tests/referral-kit.db.test.ts`.
