# 019: Guardian sign-in and family portal shell - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` before coding (Next.js 16.4 breaking changes): proxy, route
  handlers, `cookies()`/`headers()` async APIs, redirects.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`. Restart local
  Supabase only from the main checkout after `config.toml` changes (`npx supabase stop && npx supabase start`).
- Start: `DEMO_MODE=true npm run dev -- -p <port>`.
- Accounts: `npm run -s seed:users -- --prefix <acct>` (this ticket). Test phones `+91 9000000001..05`, OTP `123456`.
- Google OAuth is not exercised live; mock `linkIdentity`/OAuth in unit tests. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/guardian-routing.test.ts tests/guardian-authz.test.ts tests/identity-linking.test.ts --reporter=verbose` exits 0, covering:
  - redirect matrix: anonymous / guardian / provider / platform_admin x `/family`, `/family/login`,
    `/cases/x`, `/dashboard`, `/admin`;
  - `requireGuardian` returns 401/403/ok; every file under `app/api/family/**` calls it (static scan test);
  - `next` parameter rejects `//evil.com`, `https://evil.com`, `/\evil`;
  - linking conflict paths return the FR-9 messages and do not call any merge;
  - OTP rate limit 429 after 5 sends per number/hour (mocked clock).

## Acceptance checks

### E-1: Phone OTP sign-up (FR-1, FR-2, FR-10)

1. Open `/family/login` at 375 px. Enter `9000000003`, `Send code`, code `123456`, `Verify`.
2. Expect redirect to `/family`, `Hello, there`, emergency footer line. DB: new `user_profiles` row with
   `role = 'guardian'`, `phone_verified_at` not null.
3. Enter `12345` as number -> `Enter a 10-digit Indian mobile number`. Wrong code `000000` -> FR-1 error.

### E-2: Role-aware routing and API authz (FR-3, FR-4, FR-5)

1. As `guardian_a`, open `/dashboard`, `/cases/<id>`, `/admin/users`: each redirects to `/family`.
2. As `provider_a`, open `/family`: redirect to `/dashboard`. `PATCH /api/family/profile` as `provider_a`
   -> 403 `{ "error": "Not allowed" }`; anonymous -> 401.
3. As `guardian_a`, call a provider API from 017 (e.g. `POST /api/cases`) -> 403 `Provider access required`, no data.
4. Attempt `PATCH /api/family/profile` with `{ "role": "platform_admin" }` -> 400 or ignored; role unchanged in DB.

### E-3: Settings and linking (FR-8, FR-9)

1. As `guardian_a`, set `Your name` to `<acct> Parent`; header shows it; audit `guardian.profile_updated`.
2. `Add phone` with `guardian_b`'s number -> `This number is already linked to another account.`;
   neither account changed.
3. With only one method, `Unlink` is disabled with the FR-9 title.
4. Audit details for linking contain no full phone number.

### E-4: Privacy headers (NFR-2, NFR-4)

1. Fetch `/family` signed in: CSP header present with `script-src 'self'`; page HTML loads no
   third-party `<script src>`.
2. Grep server logs from the run for the full test phone digits: none.

### E-5: Translations (NFR-3)

Switch to `te` and `hi`: login, shell and settings fully translated; no horizontal scroll at 375 px.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] No privileged role can be obtained via any client-callable path (E-2 step 4 evidence).
- [ ] A builder reviews results and manually merges the passing ticket branch.
