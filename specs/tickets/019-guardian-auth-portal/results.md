# 019: Guardian sign-in and family portal shell - Results

Branch: `ticket/019-guardian-auth-portal`. Tested against the isolated local Supabase stack `dnmslot4`
(ports 603xx, all six migrations applied by `db reset`), `DEMO_MODE=true`, dev server and `next start` on
port 3040, integrated browser (Playwright). Accounts from `npm run -s seed:users -- --prefix acct`
plus sign-ups with the synthetic test numbers; synthetic data only. Raw curl output:
`evidence/acceptance-curl.txt` (passwords redacted).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113001900_guardian_auth.sql` | PASS | `user_profiles` gains `display_name` (1-80, nullable) and `phone_verified_at`; default role `guardian`; `handle_new_auth_user` defaults to `guardian`; `on_auth_user_app_role_changed` applies server-set `app_metadata.role` (GoTrue writes it after the insert, so 017's insert-only check never saw it); `on_auth_user_phone_changed` mirrors `phone_confirmed_at`; `auth_user_id_by_phone` and `record_otp_send` are service-role only; `otp_send_attempts` has RLS and no grants. Existing roles untouched |
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0; vitest 41 files, 579 passed, 10 skipped. DB suites ran (orgs-authz, extraction, speakers, ask, i18n-locale, the three new files). The 10 skips are the pre-existing ticket 010 block in `intake-completion.test.ts` (needs `CT_DB_TESTS=1` plus a `.env.local` file that this environment's policy blocks) |
| `npx vitest run tests/guardian-routing.test.ts tests/guardian-authz.test.ts tests/identity-linking.test.ts --reporter=verbose` | PASS | 3 files, 75 passed, 0 skipped: redirect matrix anonymous/guardian/provider/platform_admin x `/family`, `/family/settings`, `/family/login`, `/cases/x`, `/dashboard`, `/admin` through `proxy.ts`; `requireGuardian` 401/403/ok; static scan of every handler in `app/api/family/**` (first statement `await requireGuardian()`) and every portal page/layout (`requireGuardianPage()`); `next` rejects `//evil.com`, `https://evil.com`, `/\evil`, `javascript:`, control chars (helper and `/auth/callback`); FR-9 conflicts return the exact messages with no session exchange, no send, no admin update, no audit; unlink of the last method 409 and no `unlinkIdentity` call; OTP 429 after 5 sends per number and 20 per IP per hour with a mocked clock, allowed again after an hour; DB: trigger roles, `phone_verified_at` set/changed/cleared, guardian cannot change role via API or own JWT, demo phone sign-up and linking against Supabase, failed real-SMS send logs no number |
| `npm run -s seed:users -- --prefix acct` | PASS | prints JSON for `guardian_a` (+919000000001), `guardian_b` (+919000000002), `provider_a` (member org A), `org_admin_a` (owner org A), `provider_b` (owner org B), `platform_admin`; re-runs and a second prefix work (test phones move between seed accounts only); refuses non-local Supabase URLs |
| E-1 phone OTP sign-up | PASS | Browser at 375 px (`scrollWidth = innerWidth`): `12345` -> `Enter a 10-digit Indian mobile number`; `9000000004` -> `Send code` -> `Resend code in 60 s` (disabled); `000000` -> `That code is not correct or has expired.`; `123456` -> `/family`, `Hello, there`, footer `In an emergency call 108 (ambulance) or 112.`. Repeated with `9000000003` on `next start`. DB: `role = guardian`, `phone_verified_at` not null |
| E-2 role-aware routing and API authz | PASS | guardian_a: `/dashboard`, `/cases/<id>`, `/admin/users` -> 307 `/family`; provider_a: `/family` -> 307 `/dashboard`; `PATCH /api/family/profile` provider_a 403 `{"error":"Not allowed"}`, anonymous 401; guardian_a `POST /api/cases` 403 `{"error":"Provider access required"}`; `{"role":"platform_admin"}` -> 400 `Unrecognized key: "role"`, DB role still `guardian` |
| E-3 settings and linking | PASS | `Your name` = `acct Parent` -> header shows it, audit `guardian.profile_updated` `{"fields":["display_name"]}`; `Change number`/`Add phone` with guardian_b's number -> `This number is already linked to another account.` (409), both accounts unchanged (DB test compares rows); phone-only account: `Unlink` disabled with title `Add another sign-in method first`; `guardian.identity_linked` details `{"provider":"phone","phone_last4":"0004"}`, serialized event contains no full number (route test) |
| E-4 privacy headers | PASS | `/family` signed in on `next start`: `content-security-policy: default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; … connect-src 'self' http://127.0.0.1:60321; frame-src 'none'; object-src 'none'; frame-ancestors 'none'`; 0 `<script src="http…">`, every `<script>` carries the nonce; pages hydrate and navigate with no CSP console errors. Server log of the run: 0 matches for `9000000` |
| E-5 translations | PASS | `te` and `hi`: login, shell (nav, sign out, emergency line) and settings fully translated (`evidence/settings-te.png`); no horizontal scroll at 375 px (and at the 201 px browser panel); a long Telugu nav label overlapping in a 3-column grid was fixed by wrapping the nav |

## Deviations

- **`supabase/config.toml` not changed (FR-11).** The worker brief forbids editing it (shared by every
  worktree and the main checkout). Instead: phone OTP runs through server routes with a **demo backend**
  (`DEMO_MODE=true` and only `+91 9000000001..05`, code `123456`) that creates/confirms the account via the
  admin API and starts the session with an admin-generated magic-link token; all other numbers use real
  Supabase phone OTP. The required dashboard settings and an optional local `config.toml` snippet
  (sms sign-up, test OTP, Google via `env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID/_SECRET)`, manual linking)
  are in `docs/guardian-auth.md`; `.env.example` documents both Google variable names.
- **Google sign-in and `linkIdentity` not exercised live** (no OAuth credentials; Google is off locally).
  The button calls `signInWithOAuth`/`linkIdentity` as specified; `/auth/callback` (code exchange, role
  redirect, `identity_already_exists` -> FR-9 message, link audit) is covered by mocked tests. The login
  page reads `/auth/v1/settings` and disables the Google button with a translated note when Google is off.
- **Phone-only demo accounts get a hidden login email** `guardian-<uuid>@phone.demo.doctornearme.invalid`
  (Supabase local has no way to start a session for a phone user without SMS). It is never shown and does
  not count as a sign-in method.
- **OTP routes live under `/api/auth/phone/*`**, not `/api/family/**`, because they are public and FR-5
  requires every `/api/family/**` route to call `requireGuardian()`.
- **`Add phone` also changes an existing number** (`Change number` label when a phone exists): Supabase keeps
  one phone per account, and E-3 step 2 needs the action for a guardian who already has a phone.
- **`/admin` page added** (platform admin home per FR-3; redirects to `/admin/users`, 404 for others).
- **Trigger for `app_metadata.role` updates** added (see migration row): needed so server-created
  provider/admin accounts are not left as guardians now that the default changed. `tests/orgs-authz.db.test.ts`
  now creates its provider accounts with `app_metadata.role = "provider"` explicitly.
- **Hindi/Telugu copy** is a first draft, all new rows `pending` in `messages/REVIEW.md`.

## Notes

- **New helpers for 020+:** `requireGuardian()` / `requireGuardianPage()` / `loadUserProfile()` /
  `PROFILE_COLUMNS` (`lib/authz.ts`); `homeForRole`, `postSignInPath`, `safeRelativePath`, `pageRedirect`,
  `isFamilyPath` (`lib/auth-access.ts`); `supabaseRouteClient()` (cookie-writing server client,
  `lib/supabase-server.ts`); `lib/family/phone.ts` (`normalizeIndianMobile`, `maskPhone`, `phoneLast4`,
  `redactPhones`); `lib/csp.ts` (`FAMILY_CSP_EXCEPTIONS` for the approved ElevenLabs/Razorpay exceptions);
  `components/family/*` (shell nav, empty state, `PhoneOtpForm`).
- **Schema:** `user_profiles.display_name`, `user_profiles.phone_verified_at` (020 consent), table
  `otp_send_attempts`, functions `auth_user_id_by_phone(text)`, `record_otp_send(...)`. New users default to
  `guardian`; 028 promotes self-registered providers server-side.
- **Env:** no new app env vars (the OTP rate-limit HMAC uses `SUPABASE_SERVICE_ROLE_KEY`).
  `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID/_SECRET` are for the Supabase CLI only.
- **Human tasks:** DLT-registered SMS sender, Google OAuth client, and the Supabase Auth dashboard settings
  listed in `docs/guardian-auth.md` (sign-ups on, phone provider, Google provider, manual linking, redirect URL).
- Supabase links a Google sign-in to an existing account with the same verified email (platform
  behaviour). Phone-only guardians have no real email, so this cannot join two guardians; documented.
- `SiteChrome` (provider header and pilot banner) is hidden on `/family/**`, which has its own shell.
