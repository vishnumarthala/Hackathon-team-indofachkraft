# 028: Public provider profiles, credential verification, admin seeding and claim links - Results

Branch: `ticket/028-provider-profiles-verification` (base: 018 merged). Tested against the isolated local
Supabase stack of worker slot 5 (`dnmslot5`, all six migrations applied by `supabase db reset`),
`DEMO_MODE=true`, dev server and `next start` on port 3050, integrated browser at 375 px. Synthetic
accounts (`e2e028-*@example.com`, `t028*-...@example.com`), synthetic clinics and fake registration
numbers (`TEST-...`) only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, test, build) | PASS | exit 0; `npx vitest run`: 41 files, 533 passed, 10 skipped (the pre-existing opt-in `CT_DB_TESTS` intake suite); all DB suites ran (not skipped) |
| `npx vitest run tests/provider-profiles.test.ts tests/verification.test.ts tests/claim-link.test.ts --reporter=verbose` | PASS | 3 files, 29 tests (list below) |
| Migration | PASS | `20261113002800_provider_profiles.sql` applies on a fresh reset after 017/018; additive only (new tables, defaulted/nullable org columns, two buckets) |
| `provider_can_prescribe` truth table | PASS | SQL `provider_prescriber_rule` equals `canPrescribe()` for all 9 types x 5 statuses x 4 councils (180 rows); unknown profile id -> false |
| Registration edits reset status | PASS | PATCH `provider_type` on a verified profile -> `pending`, unlisted, re-review submission queued; direct SQL change of `registration_number` -> `pending` (trigger); bio edit keeps `verified` |
| Claim token single-use / expiry / hash-only | PASS | 43-char base64url token; table holds only `sha256(token)`; reuse 404; expired (created 15 days ago) 404; new link revokes previous ones; concurrent claims of one token -> exactly one success |
| Role escalation | PASS | `POST /api/providers/register` by a guardian with an active `guardian_links` row -> 403 and role unchanged (stand-in table until 020 ships it); platform admin -> 403; body `role`/`verification_status`/`can_prescribe`/`listed`/`user_id` ignored on register and PATCH (profile stays `unverified`, unlisted, `can_prescribe=false`) |
| E-1 self-register -> verify -> listed | PASS | Browser: `/join` as `Speech-language pathologist` -> lands on `/dashboard/profile` (`Not verified`); `/p/<slug>` 404; profile filled, location added, RCI + synthetic PDF submitted through the signed upload -> `Verification pending`, `Show my profile publicly` disabled; admin `/admin/verifications` shows the submission with certificate download (200, `%PDF-`) and RCI register link; Approve -> provider sees `Verified on 13 November 2026`, toggles listing; `/p/<slug>` 200 with `Verified by DoctorNearMe`, `Rehabilitation Council of India (RCI) registration ••••-001`, title `Synthetic Sushma Rao - Speech-language pathologist in Kondapur, Hyderabad \| DoctorNearMe`, JSON-LD `MedicalBusiness`; HTML contains neither the email nor the full number; hi/te titles and badge translated. New registration number submitted -> `Verification pending`, `/p/<slug>` and its `/c/<slug>` 404 again |
| E-2 seed + claim | PASS | Admin `POST /api/admin/providers` (`e2e028 Synthetic Child Clinic`, centre, paediatrician) -> 201, `unverified`, unlisted; claim link 201 (`/claim/<43 chars>`, 14 days); fresh account opened the link signed in -> `Claim this profile` -> `/dashboard/profile`; DB: `claimed=t`, user `owner` of the clinic, role `provider`. Reused link -> page `This link is not valid.`, API 404. Second profile: link A then link B -> A invalid, B valid. Provider with a profile claiming B -> 409 `{"error":"You already have a profile"}` |
| E-3 prescriber derivation | PASS | DB test: verified `pediatrician` + `NMC` -> true; verified `child_psychologist` -> false; suspended `pediatrician` -> false |
| E-4 authz negatives | PASS | Provider -> `POST /api/admin/providers` and claim-link 403 `Platform admin access required`; provider PATCH of another provider's profile 404 `Profile not found`; guardian `GET /dashboard/profile` -> 307 to `/family`; unverified seeded profile `/p` 404 and its centre `/c` 404; suspended profile and its centre 404 immediately; with `SHOW_SYNTHETIC_LISTINGS=false` (`next start`) the demo profile and its centre 404 while a non-demo verified profile and centre stay 200 |
| FR-4 OTHER / reject / suspend | PASS | OTHER approval without note 400, with note 200 (note stored, audited, absent from public data); reject needs a note; suspend only verified, needs a note, unlists, blocks resubmission (409); `provider.verified/rejected/suspended` audit rows carry the admin's `actor_user_id` and are written in the same SQL transaction |
| FR-3 photo | PASS | JPEG with EXIF/GPS/comment -> stored object has no `Exif`/`GPS`; PNG `tEXt`/`eXIf` chunks dropped; random `<profile_id>/<uuid>.jpg`; previous photo deleted; PDF bytes as `image/jpeg` 400; > 2 MB 400; other provider 404 |
| Certificates | PASS | Wrong-profile path 400; non-PDF bytes 400 (object deleted); State Medical Council without state 400; admin download is a 302 to a 60 s signed URL (audited); provider/guardian 403; public bucket URL for a certificate fails |
| NFR-2 caching | PASS | `next start`: a direct SQL rename (no invalidation) is not shown (served from the per-slug data cache); the suspend API call invalidates and the page 404s on the next request |
| NFR-3 / 375 px | PASS | All new chrome through `t()` (en/hi/te, 229 keys under `providers.*`, `messages/REVIEW.md` regenerated, `tests/i18n-keys.test.ts` passes); `/join`, `/dashboard/profile`, `/p/<slug>`, `/claim/<token>` have no horizontal scroll at 375 px |

Ticket test list: prescriber rule (pure); masking; schemas drop privileged fields; JPEG/PNG stripping; type
sniffing; SQL vs TS truth table; E-3 examples; `/api/providers/join` demo mode (201, 409, 400, 429); join
outside demo mode (unconfirmed + email; email failure removes the account); register 401; register creates
solo org/owner/provider/draft and ignores privileged fields; guardian promoted, admin refused; guardian with
child links 403; owner-only PATCH; re-verification on edits; listing rules; public data rules; photo upload;
public register links; E-1 flow incl. resubmission; bad certificates; OTHER/reject; suspend; admin-only
routes and certificate redirect; E-2 seed + claim; link rotation/expiry; 409/403/concurrency; verified
seeding + centre page.

## Deviations

- **Notifications (FR-4 "Provider notified via outbox", E-1 step 3).** The outbox (032) does not exist.
  Decisions call `notifyLater(topic, payload)` in `lib/notify/topics.ts` (topics `provider.verified`,
  `provider.rejected`, `provider.suspended`, `provider.claimed`), which only logs. The provider sees the
  decision in-app on `/dashboard/profile` (status + `Verified on <date>`). 032 must replace `notifyLater`.
- **Account creation for `/join`.** Supabase public sign-up is disabled in `supabase/config.toml` (not
  editable here), so `POST /api/providers/join` creates the email/password account server-side (confirmed
  immediately in `DEMO_MODE`; otherwise unconfirmed with a confirmation link sent through Resend), then the
  page signs in and calls `POST /api/providers/register`. "Continue with Google" is behind
  `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` (needs the Supabase Google provider from 019); not exercised locally.
- **Guardian child links.** 020's `guardian_links` table does not exist yet; `user_has_guardian_links()`
  checks it dynamically once it exists (`user_id`, `status = 'active'`). The 403 test uses a temporary
  stand-in table.
- **`seed:users`** (019) is not on this base: test accounts were created with the Supabase admin API.
- **Static caching.** The root layout reads the locale cookie, so pages render per request; the profile
  data is cached per slug (`unstable_cache`, tag `public-providers`) and invalidated with
  `revalidateTag(..., { expire: 0 })` on every change.
- **Additions not named in the rd:** `provider_claim_tokens.revoked_at` (new link invalidates old),
  `credential_submissions.submitted_by`, `provider_profiles.created_by`, `practice_locations.locality`
  required (used in titles), `PATCH /api/orgs/:id/public` (who edits the new org fields; listing needs a
  verified provider), `/admin/providers` list page, `GET /api/admin/verifications/:id/certificate`.
- **Register search links:** NMC and state councils link to the NMC Indian Medical Register (it covers the
  state councils); RCI links to rehabcouncil.nic.in. The exact search pages should be checked by a human.

## Notes

- Guardians are redirected from `/dashboard/**` to `/family` by `app/dashboard/layout.tsx` (019 builds
  `/family`; until then that URL is a 404).
- Orphaned credential uploads (signed upload done but never submitted) stay in the private bucket until a
  cleanup job exists (041 retention).
- Masking shows the last 4 characters of the number as entered (e.g. `••••-001`).
- Hindi/Telugu copy for the new keys is a draft awaiting native review (`messages/REVIEW.md`).
- Next tickets: 029 adds `geog`/`offers_*` columns and search on `provider_profiles` +
  `practice_locations`; 030 fills consultation modes and `Book`; 039 must check
  `provider_can_prescribe(profile_id)` server-side when signing; 042 seeds via `POST /api/admin/providers`
  (or `seed_provider_profile`) and `create_provider_claim_token`.
