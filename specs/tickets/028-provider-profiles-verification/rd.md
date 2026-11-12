# 028: Public provider profiles, credential verification, admin seeding and claim links

**Status:** done
**Mode:** solo
**Runs:** waits for 017, 018: needs orgs/memberships and provider role (017) and translated UI (018)

## Summary

Providers and centres get public profiles. A provider has one stable identity (`provider_profiles.id`)
across organisations (rule 10). Profiles are listed publicly only after a platform admin manually
verifies the registration with NMC / State Medical Council / RCI (rule: plan §2 "Verification").
Onboarding: self-registration, admin seeding of unclaimed profiles, and a claim link. `can_prescribe`
is derived server-side from provider type **and** verification.

## Functional requirements

- **FR-1** - Migration `<ts>_provider_profiles.sql`:
  - `provider_profiles(id uuid pk, user_id uuid unique null -> auth.users, slug text unique (3-80,
    `[a-z0-9-]`), display_name, provider_type text check in ('developmental_pediatrician',
    'child_psychiatrist','child_psychologist','speech_language_pathologist','occupational_therapist',
    'aba_therapist','special_educator','physiotherapist','pediatrician'), qualifications text (<= 300),
    bio text (<= 1500), languages text[] (subset of en, hi, te, ur, ta, kn, mr), years_experience int
    0-60, photo_path text null, registration_council text check in ('NMC','STATE_MEDICAL_COUNCIL','RCI',
    'OTHER'), registration_state text null, registration_number text null, verification_status text
    check in ('unverified','pending','verified','rejected','suspended') default 'unverified', verified_by,
    verified_at, verification_note text null, time_zone text not null default 'Asia/Kolkata', listed boolean default false, claimed boolean default false, is_synthetic boolean
    default false, created_at, updated_at)`.
  - `can_prescribe` = SQL function `provider_can_prescribe(profile_id)` -> `provider_type in
    ('developmental_pediatrician','child_psychiatrist','pediatrician') and verification_status =
    'verified' and registration_council in ('NMC','STATE_MEDICAL_COUNCIL')`; never stored from client input.
  - `organizations` (017 already has `slug`, `kind` 'centre'|'solo', `city`) gains public fields
    `public_name`, `about`, `phone_public`, `website`, `listed boolean default false`.
  - `practice_locations(id, org_id, name, address_line1, address_line2, locality, city default
    'Hyderabad', state default 'Telangana', pincode text (6 digits), lat numeric null, lng numeric null,
    time_zone text not null default 'Asia/Kolkata' (IANA), created_at)`; `provider_locations(provider_profile_id, location_id, org_id, primary key (...))`
    (029 adds `geog`).
  - `credential_submissions(id, provider_profile_id, council, state, registration_number, certificate_path text
    (private bucket `credentials`, PDF/JPEG/PNG <= 10 MB, admin-only signed URLs), status text check in ('submitted','approved','rejected'), reviewer_id,
    reviewer_note, created_at, reviewed_at)`.
  - `provider_claim_tokens(id, provider_profile_id, token_hash, expires_at (14 days), used_at, used_by,
    created_by)`.
- **FR-2** - Self-registration `/join` (public): `I am a` (provider type select), `Full name`, `Email`,
  Google or email sign-up; on first sign-in server route `POST /api/providers/register` creates a solo
  org (017), sets role `provider` **server-side** (only for users with no existing role other than the
  default `guardian` and no guardian links), creates a draft profile, redirects to `/dashboard/profile`.
- **FR-3** - Profile editor `/dashboard/profile` (owner): all FR-1 profile fields, photo upload (JPEG/PNG
  <= 2 MB to public bucket `provider-photos`, random object names, EXIF stripped - see D-6), locations of the provider's org(s), and `Submit for verification`
  (council, state, registration number, certificate upload). Editing `provider_type` or registration
  fields after `verified` sets status back to `pending` and `listed = false`.
- **FR-4** - Admin verification queue `/admin/verifications` (platform admin): pending submissions with
  profile, council, number, certificate download, a link to the relevant public register search
  (NMC IMR / state council / RCI CRR; none for `OTHER`), `Approve` (sets `verified`, `verified_by/at`) and `Reject` with a
  required note. For OT, physiotherapy, ABA and special educators (no statutory register yet) the provider
  submits council `OTHER` with whatever credential they hold (degree, BCBA/QABA, RCI special-education
  registration, employer letter) and the platform admin's judgement is the verification: `Approve` then
  requires a `verification_note` saying what was checked (stored, audited, never shown publicly); `Suspend` for verified profiles. Audit (strict) `provider.verified/rejected/suspended`.
  Provider notified via outbox (032).
- **FR-5** - Admin seeding `/admin/providers/new` and `POST /api/admin/providers` (platform admin):
  creates an unclaimed profile + org (`kind`) + location from public information; status
  `unverified`, `listed = false` unless the admin verifies. `POST /api/admin/providers/:id/claim-link`
  -> 201 `{ url, expires_at }` (`/claim/<token>`; 43-char token, hash stored, new link invalidates old).
- **FR-6** - Claim `/claim/[token]`: invalid/expired/used -> `This link is not valid.`; valid -> sign in
  or sign up, then `Claim this profile` -> `POST /api/claims/:token` binds `user_id`, sets `claimed =
  true`, makes the user `owner` of the seeded org, role `provider` server-side; a user who already has a
  provider profile -> 409 `{ error: "You already have a profile" }`.
- **FR-7** - Public profile `/p/[slug]` (only `verified` and `listed` profiles, else 404): name, type
  label (translated), qualifications, languages, experience, bio, organisations/locations with
  addresses, a `Verified by DoctorNearMe` badge with verification date, plus the council name and masked
  registration number (last 4) only when the council is not `OTHER`, consultation modes (filled by 030), `Book` button (030). Centre
  pages `/c/[slug]` list listed providers of the org. Metadata title `<name> - <type> in <locality>,
  Hyderabad | DoctorNearMe`; JSON-LD `Physician`/`MedicalBusiness` only with verified fields.
- **FR-8** - `listed` toggle (`Show my profile publicly`) only enabled when `verified`.

## Non-functional requirements

- **NFR-1** - Public pages expose no email, no personal phone (only `phone_public` of orgs), no
  unverified profiles; `is_synthetic` profiles are shown (product decision 2026-11-12: do not hide demo
  doctors in the pilot) with a `Demo profile` badge on cards and profile pages; `SHOW_SYNTHETIC_LISTINGS=false`
  hides them if ever needed (default `true`).
- **NFR-2** - Public pages are statically cacheable per slug with revalidation on profile change.
- **NFR-3** - Translated (en/hi/te) chrome; profile text as written.

## Affected areas

- `supabase/migrations/<ts>_provider_profiles.sql` (new); `lib/providers/**` (new)
- `app/join/**`, `app/claim/[token]/**`, `app/p/[slug]/**`, `app/c/[slug]/**`, `app/dashboard/profile/**`,
  `app/admin/{verifications,providers}/**` (new)
- `app/api/providers/**`, `app/api/admin/providers/**`, `app/api/claims/[token]/route.ts` (new)
- `lib/authz.ts` (`requireProviderProfileOwner`), `lib/notify/topics.ts`, `messages/*.json`
- `tests/provider-profiles.test.ts`, `tests/verification.test.ts`, `tests/claim-link.test.ts` (new)

## Don't touch

- Org invitation flows (017), case data, existing migrations, `BOARD.md`

## Out of scope

- Geo search and maps (029), availability/booking (030), ratings (036), automated register lookups.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Provider types | 9 types incl. GP/peds; centres as listing kind | plan §2 "Provider types" |
| D-2 | Verification | Manual admin check (NMC/State/RCI); for OT/physio/ABA/special educators council `OTHER` and the admin's documented judgement | plan §2 "Verification"; product owner 2026-11-12: "admin will verify, trust him for now" |
| D-3 | Prescriber | Derived server-side: type + verified + medical council | plan §2 "E-Rx", rule 9 |
| D-4 | Onboarding | Self-register + admin seeding + claim link | plan §2 "Availability / onboarding" |
| D-5 | Stable identity | `provider_profiles.id` independent of org | rule 10 |
| D-6 | Photo storage | Public bucket, random names; certificates in a separate private bucket | public profile photos are public by design; credentials are not; 023 is not upstream |

## Open questions

- Is a provider allowed to stay listed while practising in several orgs with different fees? Handled by
  per-org services in 030.
