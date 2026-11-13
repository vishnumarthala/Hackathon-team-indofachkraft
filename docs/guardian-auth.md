# Guardian sign-in and the family portal (ticket 019)

Parents and legal guardians have their own accounts and a portal at `/family`. Providers keep
email/Google on `/login`. This page is for engineers building on the portal (020+) and for whoever
configures the Supabase project.

## Roles

- `user_profiles.role` is `guardian`, `provider` or `platform_admin`. **Every new auth user is a
  `guardian`** (`handle_new_auth_user`, migration `20261113001900_guardian_auth.sql`).
- Privileged roles are granted server-side only: org invitations (017), `org:grant`, provider
  self-registration (028), or the admin API setting `app_metadata.role` (`provider`/`platform_admin`;
  the `on_auth_user_app_role_changed` trigger applies it, because GoTrue writes custom app_metadata after
  the insert). Users cannot write `app_metadata`, `user_metadata.role` is ignored, and `authenticated`
  has no UPDATE grant on `user_profiles`.
- `PATCH /api/family/profile` accepts only `{ display_name?, preferred_locale? }` (strict schema: any
  other key, e.g. `role`, is a 400).
- One person = one role in the MVP. A therapist who is also a parent uses two accounts.

## Routes

| Path | Who | Notes |
|------|-----|-------|
| `/family/login` | public | Google button + phone OTP. Signed-in users go to their own home. `?next=` must be a same-origin path under `/family` |
| `/family`, `/family/{children,appointments,messages,documents,settings}` | guardian | portal shell (`app/family/(portal)/layout.tsx`); empty states until 020/023/027/030 |
| `/auth/callback` | public | OAuth return (`code` exchange), Connect Google (`flow=link`), role redirect |
| `POST /api/auth/phone/send` | public | `{ phone }` (10 digits) -> 200 `{ sent: true }`, 400 `Enter a 10-digit Indian mobile number`, 429 `Too many codes requested. Try again later.` |
| `POST /api/auth/phone/verify` | public | `{ phone, code, next? }` -> 200 `{ redirect }` and session cookies, 400 `That code is not correct or has expired.` |
| `GET/PATCH /api/family/profile` | guardian | -> `{ profile }`; audit `guardian.profile_updated` `{ fields }` |
| `POST /api/family/identities/phone` | guardian | add or change phone, step 1: `{ phone }`; 409 `This number is already linked to another account.` |
| `POST /api/family/identities/phone/verify` | guardian | step 2: `{ phone, code }`; audit `guardian.identity_linked` `{ provider: "phone", phone_last4 }` |
| `GET/DELETE /api/family/identities` | guardian | `DELETE { provider: "google" | "phone" }`; 409 `Add another sign-in method first` when it is the last method; audit `guardian.identity_unlinked` |
| `/admin` | platform admin | home for platform admins (redirects to `/admin/users`) |

Role homes (`homeForRole` in `lib/auth-access.ts`): guardian `/family`, provider `/dashboard`,
platform admin `/admin`. `proxy.ts` redirects anonymous `/family/**` visitors to
`/family/login?next=...`, guardians away from `/dashboard`, `/cases`, `/admin` to `/family`, and providers
or admins away from `/family/**` to their home. **Routing is a convenience, not authorisation.**

## Authorisation helpers (`lib/authz.ts`)

- `requireGuardian(): Promise<{ user, profile } | Response>` for route handlers: 401
  `{ error: "Authentication required" }` without a session, 403 `{ error: "Not allowed" }` for other roles.
  Use: `const session = await requireGuardian(); if (session instanceof Response) return session;`
- `requireGuardianPage()` for server components: redirects anonymous users to `/family/login` and other
  roles to their home. Cached per request.
- 020+ add stricter helpers (e.g. "guardian linked to this child") on top; they must still start from
  these. `tests/guardian-authz.test.ts` scans `app/api/family/**` and the portal pages and fails if a
  handler or page does not call them first.

## Phone OTP

The browser never talks to Supabase for phone codes: the server routes validate the number, apply the
rate limit and keep numbers out of logs. `lib/family/phone-auth.ts` has two backends behind
`PhoneAuthBackend`:

- **supabase** (default): `signInWithOtp({ phone })` / `verifyOtp({ type: "sms" })` for sign-in and
  `updateUser({ phone })` / `verifyOtp({ type: "phone_change" })` for adding a phone, with the user's own
  session cookies. Needs an SMS provider in the Supabase project.
- **demo**: only when `DEMO_MODE=true` **and** the number is one of the synthetic test numbers
  `+91 9000000001` ... `+91 9000000005`; the code is always `123456`. It creates/confirms the account with
  the admin API and starts the session with an admin-generated magic-link token (phone-only demo
  accounts get a hidden login email `guardian-<uuid>@phone.demo.doctornearme.invalid`). Any other number
  goes to the supabase backend. This is how the flow works on local Supabase, which has no SMS provider.

Rate limits (NFR-1): Supabase's own `sms_sent` per hour, plus 5 sends per number per hour and 20 per IP
per hour in the app (`record_otp_send`, table `otp_send_attempts`, keys are HMAC-SHA256 of the number/IP
with the service-role key, never raw values). The client IP is the first `x-forwarded-for` hop.

NFR-4: numbers are never logged in full. Errors pass through `redactPhones()`; audit details store
`phone_last4` only; the UI shows `+91 ••••••1234`.

`user_profiles.phone_verified_at` is maintained by a trigger from `auth.users.phone_confirmed_at`
(set on confirm, cleared when the phone is removed). 020 uses it for verifiable consent.

## Identity linking (safe linking)

- `Connect Google` calls `supabase.auth.linkIdentity({ provider: "google" })` in the browser for the
  signed-in guardian; the round trip ends at `/auth/callback?flow=link`. A Google account that already
  belongs to another user comes back as `error_code=identity_already_exists`; the guardian sees
  `This Google account is already used by another DoctorNearMe account.` and nothing changes.
- `Add phone` / `Change number` refuses a number owned by another account before sending a code (and
  again before confirming). Supabase keeps one phone per account, so a verified new number replaces the
  old one.
- The app never merges accounts. Note: Supabase itself links a Google sign-in to an existing user with
  the **same verified email** (provider accounts). Phone-only guardians have no real email, so a
  guardian's Google sign-in never lands in another guardian's account; a provider who uses Google on
  `/family/login` reaches their own provider account and is sent to `/dashboard`.
- Unlinking is allowed only while another method (Google or phone) remains.

## Content Security Policy (NFR-2)

`proxy.ts` sends, for every `/family` page, `Content-Security-Policy` with a fresh nonce:
`script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in `next dev` only),
`connect-src 'self' <supabase origin> <supabase ws(s) origin>` (the ws origin is Supabase Realtime for 027 messaging), `frame-src 'none'`, `frame-ancestors 'none'`, `object-src 'none'`.
Next.js puts the nonce on its own scripts. No analytics, ads, tag managers or social pixels on any
family/child page. Approved exceptions (ElevenLabs SDK for 033/040, Razorpay checkout for 031) are added
per route prefix in `FAMILY_CSP_EXCEPTIONS` (`lib/csp.ts`) by the ticket that needs them, nothing else.

## Supabase configuration (human task)

`supabase/config.toml` was deliberately **not** changed by this ticket (shared by every worktree and the
main checkout). Locally, the demo backend covers phone sign-in and Google stays off (the login page
detects it via `/auth/v1/settings` and disables the button with
`Google sign-in is not available yet. Use your mobile number.`).

Hosted project (dashboard -> Authentication):

1. **Sign-ups**: allow new users to sign up (guardians self-register; the trigger makes them guardians).
   If provider email sign-up must stay closed until 028, keep the email provider's own sign-up off.
2. **Phone provider**: enable, choose an SMS provider with a **DLT-registered sender and template**
   (India, human lead-time task, plan risk 5). Until then only test numbers work: add
   `919000000001=123456` ... `919000000005=123456` under "Test phone numbers" for the pilot demo.
   Keep the SMS rate limit (`sms_sent`) at or below 30/hour.
3. **Google provider**: enable with the OAuth client id/secret; authorised redirect URI
   `https://<project>.supabase.co/auth/v1/callback`.
4. **Manual linking**: enable "Allow manual linking" (needed for `linkIdentity` / `unlinkIdentity`).
5. **URL configuration**: Site URL = the app URL; additional redirect URL `<APP_URL>/auth/callback`.

To try Google or real SMS on a local stack, a developer can add to their own (uncommitted) local
`config.toml`:

```toml
[auth]
enable_signup = true
enable_manual_linking = true

[auth.sms]
enable_signup = true

[auth.sms.test_otp]
919000000001 = "123456"
919000000002 = "123456"
919000000003 = "123456"
919000000004 = "123456"
919000000005 = "123456"

[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
skip_nonce_check = true
```

and restart Supabase from the main checkout (`npx supabase stop && npx supabase start`).

## Test accounts

`npm run -s seed:users -- --prefix <acct>` (`scripts/seed-users.ts`; refuses unless
`NEXT_PUBLIC_SUPABASE_URL` is `127.0.0.1`/`localhost`) creates or refreshes `guardian_a` (+91 9000000001),
`guardian_b` (+91 9000000002), `provider_a` (member of org A), `org_admin_a` (owner of org A),
`provider_b` (owner of org B) and `platform_admin`, all with email + password (new random password on every
run, printed as JSON) under `@example.test`. Guardians can also sign in with their phone and `123456` in
demo mode; `+91 9000000003..05` are free for sign-up tests. Later tickets extend `ACCOUNTS` in this script.
