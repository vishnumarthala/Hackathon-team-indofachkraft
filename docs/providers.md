# Provider profiles, verification and claim links (ticket 028)

Public provider profiles for the DoctorNearMe directory. A provider has **one stable identity**,
`provider_profiles.id`, independent of the organisations they practise in (rule 10). Families only ever
see profiles that a platform admin has **verified** and the provider has chosen to **list**.

## Data model (`supabase/migrations/20261113002800_provider_profiles.sql`)

| Table / function | What |
|---|---|
| `provider_profiles` | One row per provider. `user_id` (unique, null while a seeded profile is unclaimed), `slug` (`/p/<slug>`), `provider_type` (9 types), profile text, `languages` (subset of en/hi/te/ur/ta/kn/mr), `photo_path`, `registration_council` (`NMC`, `STATE_MEDICAL_COUNCIL`, `RCI`, `OTHER`) + state + number, `verification_status` (`unverified` -> `pending` -> `verified` / `rejected`; `suspended`), `verified_by/at`, internal `verification_note`, `listed`, `claimed`, `is_synthetic`. Check constraint: `listed` only when `verified`. |
| `provider_prescriber_rule(type, status, council)` / `provider_can_prescribe(profile_id)` | **The** prescriber rule (D-3): prescriber type (`developmental_pediatrician`, `child_psychiatrist`, `pediatrician`) **and** `verified` **and** council `NMC`/`STATE_MEDICAL_COUNCIL`. Never stored, never read from client input. `lib/providers/constants.ts` `canPrescribe()` mirrors it (tested against the SQL for every combination). 039 (E-Rx) must call `provider_can_prescribe` server-side when signing. |
| `organizations` (017) + `public_name`, `about`, `phone_public`, `website`, `listed` | Public centre page `/c/<slug>`. Listing needs one verified provider. |
| `practice_locations` | Address of an organisation (`locality`, `city` default Hyderabad, `state` default Telangana, 6-digit `pincode`, optional `lat`/`lng`, IANA `time_zone`). 029 adds `geog`. |
| `provider_locations` | Which profile practises at which location; `(location_id, org_id)` FK keeps `org_id` equal to the location's org. |
| `credential_submissions` | What a provider submitted for review (council, state, number, `certificate_path` in the private `credentials` bucket), `status` `submitted`/`approved`/`rejected`, reviewer + note. At most one open (`submitted`) row per profile; a resubmission replaces it. |
| `provider_claim_tokens` | Claim links: SHA-256 `token_hash` only, `expires_at` (14 days), `used_at/by`, `revoked_at` (a new link revokes older ones). |

Triggers on `provider_profiles`:

- `provider_profiles_guard` (before update): a **verified** profile whose `provider_type` or any
  registration field changes goes back to `pending`; any profile that is not verified is unlisted.
  This holds for every write path (API, scripts, SQL).
- `provider_profiles_requeue` (after update): such a re-pending profile without an open submission gets a
  re-review submission in the admin queue (current registration + last certificate).

Security-definer functions (service role only, one transaction each): `register_provider`,
`seed_provider_profile`, `create_provider_claim_token`, `claim_provider_profile`,
`submit_provider_credentials`, `review_credential_submission`, `suspend_provider_profile`,
`user_has_guardian_links`. Verification decisions (`provider.verified`, `provider.rejected`,
`provider.suspended`) insert their `audit_events` row **inside** the same transaction (strict audit: no
decision without its audit row).

Storage: `provider-photos` (public, 2 MB, JPEG/PNG, random object names `<profile_id>/<uuid>.jpg`) and
`credentials` (private, 10 MB, PDF/JPEG/PNG; only platform admins get 60-second signed download URLs).

RLS is enabled on every new table; authenticated users may read their own profile and their
organisations' locations. The server uses the service-role client and gates every route itself.

## Flows

- **Self-registration** (`/join`, public). Supabase public sign-up stays disabled, so
  `POST /api/providers/join` (public, 5 per IP per hour) creates the email/password account server-side:
  confirmed immediately in `DEMO_MODE`, otherwise unconfirmed with a confirmation link sent by Resend.
  The account gets no privileged role. The signed-in user then calls `POST /api/providers/register`,
  which decides **in SQL** whether the account may become a provider (only `guardian`/`provider` roles,
  no active guardian links - checked against 020's `guardian_links` once that table exists; platform
  admins are refused), creates a solo organisation (owner), sets role `provider`, and creates a draft
  `unverified` profile. Body fields other than `provider_type` and `full_name` are ignored.
  "Continue with Google" is shown when `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true` (needs the Supabase
  Google provider; 019 configures it) and returns to `/join`.
- **Profile editor** (`/dashboard/profile`, owner only; guardians are redirected to `/family`). Profile
  fields, photo (bytes sniffed, EXIF/XMP/comment segments and PNG text/eXIf chunks stripped server-side
  by `lib/providers/images.ts`), locations of the provider's organisations (owners/admins can add new
  ones), `Submit for verification` (signed upload to `credentials`, then the server checks the object's
  path and magic bytes), `Show my profile publicly` (enabled only when verified), and the public fields of
  organisations the user manages.
- **Verification queue** (`/admin/verifications`, platform admins). Each open submission with profile,
  council, number, certificate download and a link to the public register (NMC IMR for NMC and state
  councils, RCI; none for `OTHER`). `Approve` / `Reject`; reject always needs a note, approve needs one for
  `OTHER` (what the admin checked: degree, BCBA/QABA, RCI special-education registration, employer
  letter). Notes are stored and audited, never shown publicly.
- **Admin seeding** (`/admin/providers/new`, `POST /api/admin/providers`). Creates organisation (or uses
  an existing one: `org_id` + `location_id`), location and an unclaimed profile from public information,
  `unverified`/unlisted unless the admin ticks "I checked this registration". `/admin/providers` lists
  profiles with `Create claim link` (unclaimed) and `Suspend` (verified).
- **Claim** (`/claim/<token>`). Invalid, expired, used and superseded links all show `This link is not
  valid.` A signed-in user (or one who signs in / creates an account via `/join?next=/claim/<token>`)
  presses `Claim this profile`: `POST /api/claims/:token` binds `user_id`, sets `claimed`, makes the user
  owner of each linked organisation that has no active owner (member otherwise), sets role `provider`.
  A user who already has a profile gets 409 `{ error: "You already have a profile" }`.
- **Public pages** `/p/<slug>` and `/c/<slug>` show only verified + listed profiles (centres: listed
  organisations with at least one such profile): name, translated type, qualifications, languages,
  experience, bio, locations with addresses and the organisation's public phone/website, `Verified by
  DoctorNearMe` with the date, and the council name with the registration number masked to its last 4
  characters (nothing for `OTHER`). No email, user id, full registration number or verification note is
  ever selected. Demo profiles (`is_synthetic`) show a `Demo profile` badge and are `noindex`;
  `SHOW_SYNTHETIC_LISTINGS=false` hides them. Consultation modes and `Book` are placeholders for 030.
  Metadata title `<name> - <type> in <locality>, Hyderabad | DoctorNearMe`; JSON-LD `Physician`
  (prescriber types) or `MedicalBusiness`.

## Caching (NFR-2)

The page data is cached per slug with `unstable_cache` (tag `public-providers`, 1 h). Every write that
can change a public page calls `invalidatePublicProviders()` (`revalidateTag(tag, { expire: 0 })`), so a
suspended or re-pending profile is never served stale. The HTML itself renders per request because the
root layout reads the viewer's locale cookie.

## API

| Method + path | Who | Body | Success |
|---|---|---|---|
| `POST /api/providers/join` | public | `{ provider_type?, full_name, email, password }` | 201 `{ confirm_email }`; 409 exists; 429 limit |
| `POST /api/providers/register` | signed in | `{ provider_type, full_name }` | 201/200 `{ profile_id, redirect }`; 403 not allowed |
| `PATCH /api/providers/:id` | owner | any of `{ display_name, provider_type, qualifications, bio, languages, years_experience, time_zone }` | 200 `{ profile }` (with derived `can_prescribe`) |
| `PATCH /api/providers/:id/listing` | owner | `{ listed }` | 200 `{ listed }`; 409 not verified |
| `POST` / `DELETE /api/providers/:id/photo` | owner | multipart `file` | 201 `{ photo_url }` |
| `POST /api/providers/:id/locations` | owner | `{ location_id }` or `{ org_id, name, address_line1, address_line2?, locality, city, state, pincode }` | 201 `{ location }` |
| `DELETE /api/providers/:id/locations/:locationId` | owner | - | 200 `{ removed: true }` |
| `POST /api/providers/:id/credentials/upload-url` | owner | `{ file_name, mime_type, size_bytes }` | 201 `{ path, token }` |
| `POST /api/providers/:id/credentials` | owner | `{ council, state?, registration_number, certificate_path }` | 201 `{ submission_id, verification_status: "pending" }`; 409 suspended |
| `PATCH /api/orgs/:id/public` | org owner/admin | any of `{ public_name, about, phone_public, website, listed }` | 200 `{ org }`; 409 no verified provider |
| `POST /api/admin/providers` | platform admin | seed body (see `SeedSchema`) | 201 `{ profile_id, org_id, location_id, slug }` |
| `POST /api/admin/providers/:id/claim-link` | platform admin | - | 201 `{ url, expires_at }`; 409 claimed |
| `POST /api/admin/providers/:id/suspend` | platform admin | `{ note }` | 200; 409 not verified |
| `POST /api/admin/verifications/:id` | platform admin | `{ action: "approve" \| "reject", note? }` | 200 `{ profile_id, verification_status }` |
| `GET /api/admin/verifications/:id/certificate` | platform admin | - | 302 to a 60 s signed URL |
| `POST /api/claims/:token` | signed in | - | 200 `{ profile_id, redirect }`; 404 invalid; 409 has profile |

Other providers' profile ids answer 404 (`requireProviderProfileOwner` in `lib/authz.ts`); admin routes
answer 401/403 (`requirePlatformAdminApi`); admin pages 404 for everyone else (`requirePlatformAdminPage`).

## Notifications

There is no outbox yet (032). `lib/notify/topics.ts` defines `PROVIDER_TOPICS` (`provider.verified`,
`provider.rejected`, `provider.suspended`, `provider.claimed`) and a `notifyLater(topic, payload)` hook
that only logs. 032 replaces it with `outbox_enqueue` (ids only in the payload). Until then the provider
sees the decision on `/dashboard/profile`.
