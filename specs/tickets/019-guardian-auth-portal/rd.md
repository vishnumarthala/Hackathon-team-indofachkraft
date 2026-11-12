# 019: Guardian sign-in and family portal shell

**Status:** draft
**Mode:** solo
**Runs:** waits for 017, 018: needs the `guardian` role, migrated auth trigger and `lib/authz.ts` (017) and `t()`/locale (018)

## Summary

Parents and legal guardians get their own accounts and a `/family` portal. Guardians sign in with
Google or a phone OTP (providers keep email/Google on `/login`). This ticket adds the guardian sign-in
page, safe identity linking (Google <-> phone), role-aware routing for `/family/**`, server-side
`requireGuardian()` guards, the portal shell and settings page, and a local test-user seed. Children,
consent and all child data arrive in 020+; the shell shows empty states.

## Functional requirements

- **FR-1** - `/family/login` (public, translated): `<h1>Sign in to your family account</h1>`, button
  `Continue with Google` (Supabase `signInWithOAuth({ provider: "google", options: { redirectTo:
  <APP_URL>/auth/callback?next=/family } })`), a divider `or`, a field `Mobile number` with fixed prefix
  `+91` (10 digits, first digit 6-9, message `Enter a 10-digit Indian mobile number`), button
  `Send code`; then a field `6-digit code` and button `Verify`, plus `Resend code` enabled after 60 s.
  Wrong/expired code -> `That code is not correct or has expired.` A link `Are you a clinician? Sign in here`
  -> `/login`. Copy under the form: `We use your number only to sign you in and send appointment updates.`
- **FR-2** - New auth users get role `guardian` from the `handle_new_auth_user` trigger (017 migrates
  the trigger; if 017 left another default, this ticket's migration sets `guardian`). Roles
  `provider`/`platform_admin` are only granted server-side (017 invitations, 028 self-registration,
  platform admin). A signed-in user can never change their own role through any API.
- **FR-3** - Auth callback `/auth/callback` (create it if 017 did not) validates `next` is a
  same-origin relative path, then redirects by role: `guardian` -> `/family` (or `next` under `/family`),
  `provider` -> `/dashboard` (017 keeps the provider area at `/dashboard` + `/cases`), `platform_admin` -> `/admin`. A provider/admin who used `/family/login`
  lands on their own home, not `/family`.
- **FR-4** - Routing in `proxy.ts` / `lib/auth-access.ts`: `/family` and `/family/**` (except
  `/family/login`) require a session (redirect `/family/login?next=...`); role mismatch redirects to the
  user's home (guardian visiting `/cases/**`, `/dashboard/**`, `/admin/**` -> `/family`;
  provider visiting `/family/**` -> `/dashboard`). Routing is a convenience only (rule 3).
- **FR-5** - `lib/authz.ts` gains `requireGuardian(): Promise<{ user, profile } | Response>` returning
  401 `{ error: "Authentication required" }` without a session and 403 `{ error: "Not allowed" }` for
  other roles. Every `/api/family/**` route and every `/family/**` server component calls it (or a
  stricter helper from 020+) before reading data.
- **FR-6** - Portal shell `app/family/layout.tsx`: header with `DoctorNearMe`, nav `Home`, `Children`,
  `Appointments`, `Messages`, `Documents`, `Settings` (links to pages that later tickets fill; until then
  each shows a translated empty state, e.g. `No children added yet.`), language switcher (018), and
  `Sign out`. A persistent footer line: `In an emergency call 108 (ambulance) or 112.`
- **FR-7** - `/family` home: `<h1>Hello, <display_name or "there"></h1>`; a card `Add your child` (link
  target filled by 020) and a card `Find a specialist near you` (link to `/find`, built in 029; shows
  `Coming soon` until 029 ships).
- **FR-8** - `/family/settings`: field `Your name` (1-80 chars) saved via `PATCH /api/family/profile`
  `{ display_name?, preferred_locale? }` -> 200 `{ profile }`, 400 on validation; section
  `Sign-in methods` listing `Google` (`Connected as <email>` / button `Connect Google`) and `Phone`
  (`+91 ••••••1234` / button `Add phone`). Audit `guardian.profile_updated`.
- **FR-9** - Identity linking (rule 4, "safe linking"):
  - `Connect Google` uses `supabase.auth.linkIdentity({ provider: "google" })` for the signed-in user.
  - `Add phone` uses `updateUser({ phone })` + `verifyOtp({ type: "phone_change" })`.
  - Never merge accounts automatically by matching email or phone. If the Google identity or phone
    already belongs to another user, show `This Google account is already used by another DoctorNearMe account.`
    / `This number is already linked to another account.` and change nothing.
  - Unlinking is allowed only while at least one other method remains; otherwise the button is disabled
    with title `Add another sign-in method first`.
  - Audit `guardian.identity_linked` / `guardian.identity_unlinked` with `{ provider }` (no phone number
    in details; store last 4 digits only).
- **FR-10** - `user_profiles.phone_verified_at timestamptz` is set server-side when Supabase reports a
  confirmed phone (`auth.users.phone_confirmed_at`); 020 uses it for verifiable consent.
- **FR-11** - Local auth config in `supabase/config.toml`: `[auth.sms] enable_signup = true`,
  `[auth.sms.test_otp]` entries `919000000001 = "123456"` ... `919000000005 = "123456"` (synthetic
  numbers), Google provider block reading `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`/`_SECRET` from env
  (disabled when unset). `.env.example` documents both. Production SMS needs a DLT-registered sender
  (human task, plan §6); until then phone OTP works only with test numbers.
- **FR-12** - `npm run -s seed:users -- --prefix <acct>` (`scripts/seed-users.ts`, local only, refuses
  when `NEXT_PUBLIC_SUPABASE_URL` is not `127.0.0.1`/`localhost`) creates synthetic users with
  password logins for testing and prints JSON: `guardian_a`, `guardian_b` (role guardian, verified test
  phones), `provider_a` (member of org A), `org_admin_a` (owner of org A), `provider_b` (org B),
  `platform_admin`. Later tickets extend this script instead of writing their own.

## Non-functional requirements

- **NFR-1** - OTP send rate limited: Supabase `sms_sent` per hour plus an app-level limit of 5 sends per
  number per hour and 20 per IP per hour (`429 { error: "Too many codes requested. Try again later." }`).
- **NFR-2** - `/family/**` pages load no third-party scripts (no analytics, ads, tag managers, social
  pixels); response header `Content-Security-Policy` with `script-src 'self'` (plus Next's nonce if
  required) on `/family/**`. Exceptions must be added explicitly by later tickets (e.g. 031, 040).
- **NFR-3** - 375 px mobile-first; tap targets >= 44 px; all copy through `t()` in en/hi/te.
- **NFR-4** - Phone numbers are never logged in full (server logs, audit details, errors).

## Affected areas

- `app/family/login/page.tsx`, `app/family/layout.tsx`, `app/family/page.tsx`, `app/family/settings/page.tsx`,
  `app/family/{children,appointments,messages,documents}/page.tsx` (empty states) (new)
- `components/family/*` (new), `app/api/family/profile/route.ts` (new)
- `app/auth/callback/route.ts` (extend), `proxy.ts`, `lib/auth-access.ts`, `lib/authz.ts` (add `requireGuardian`)
- `supabase/migrations/<ts>_guardian_auth.sql` (new: `phone_verified_at`, trigger default if needed, `display_name` if 017 did not add it)
- `supabase/config.toml` (auth sms/test_otp/google blocks only), `.env.example`
- `scripts/seed-users.ts`, `package.json` (`seed:users` script entry only)
- `messages/*.json` (new `family.*` keys)
- `tests/guardian-routing.test.ts`, `tests/guardian-authz.test.ts`, `tests/identity-linking.test.ts` (new)

## Don't touch

- Provider workspace pages and APIs (except adding role checks via 017 helpers), existing migrations,
  `lib/isaa.ts`, `BOARD.md`

## Out of scope

- Children, guardian links, consent (020). Appointments, messages, documents content (023, 027, 030).
- WhatsApp OTP, email magic link for guardians, passkeys.
- Provider self-registration (028).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Guardian auth methods | Google Sign-In + phone OTP | plan §2 "Auth" |
| D-2 | Default role for new sign-ups | `guardian` (least privilege) | rule 4: privileged roles server-side only |
| D-3 | Account linking | Explicit, user-initiated; never auto-merge | rule 4 "safe Google<->phone identity linking" |
| D-4 | No tracking on family pages | CSP `script-src 'self'` | plan §2 "Child consent ... no tracking/ads on child pages" |
| D-5 | SMS before DLT | Supabase test OTP numbers locally; production waits for DLT | risk 5 |

## Open questions

- Should a person be both provider and guardian (a therapist who is also a parent)? Proposed: no in
  MVP - they use two accounts; a single `role` column stays.
