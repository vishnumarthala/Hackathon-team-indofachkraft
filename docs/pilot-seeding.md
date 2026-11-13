# Pilot seeding: demo directory and real-provider import (ticket 042)

Two scripts fill the Hyderabad directory. Use the **synthetic seed** to demonstrate and load-test the directory,
booking and voice agents without real people; use the **import** to put recruited pilot providers on the platform as
unclaimed profiles they then claim and get verified.

| | `npm run -s seed:hyderabad` | `npm run -s import:providers` |
|---|---|---|
| Who / where | developers, demo and staging environments | platform admins, the real pilot project |
| Data | fictional (`scripts/data/*.json`), `is_synthetic = true` | public details of providers who agreed to be listed |
| Profiles | `verified`, `listed`, unclaimed, with services + weekly hours | `unverified`, not listed, unclaimed, `is_synthetic = false` |
| Visible to families | yes, with a `Demo profile` badge (unless `SHOW_SYNTHETIC_LISTINGS=false`) | no, until the provider claims, submits credentials, is verified and chooses to be listed (028) |
| Undo | `--reset-synthetic` | `/admin/providers` (028) |

## Synthetic Hyderabad dataset (`scripts/seed-hyderabad.ts`)

```bash
npm run -s seed:hyderabad                       # 60 profiles, seed 42, prefix demo-hyd
npm run -s seed:hyderabad -- --count 1000 --prefix load-1      # load test (about 1 s locally)
npm run -s seed:hyderabad -- --reset-synthetic                 # delete every synthetic profile
npm run -s seed:hyderabad -- --reset-synthetic --prefix load-1 # only that dataset
```

Prints one JSON line, e.g. `{"action":"seed","prefix":"demo-hyd","seed":42,"providers":60,"centres":8,
"solo_practices":38,"locations":46,"services":103,"rules":635,"localities":14,"types":9,"ms":179}`.

What it creates (deterministic for a given `--seed`, `--count` and `--prefix`):

- Providers named `Dr. (Demo) <given name> <initial>.` (given names plus one initial only, so no full name of a real
  person), all 9 provider types (each at least once, then a realistic mix: speech and OT most common, child
  psychiatrists least), languages `en` plus `te` / `hi` / `ur`, 2-25 years of experience, a bio that starts
  `Synthetic demo profile: not a real practitioner`, registration `DEMO-<n>` (NMC / RCI / OTHER by type),
  `verification_note` saying no registration was checked. No auth users: every profile is unclaimed.
- 8 centres per 60 profiles (`organizations.kind = 'centre'`, `(Demo) <invented word> Child Development Centre`, 2-5
  providers each), every other provider in a solo practice `(Demo) <name> Clinic`. Public phone `+91 90000 0xxxx`
  (test range), website `https://<slug>.example.com`, address `(Demo) Plot <n>, <placeholder street>`.
- One location per organisation in one of 14 localities (Banjara Hills, Jubilee Hills, Gachibowli, Madhapur, HITEC
  City, Kondapur, Kukatpally, Miyapur, Ameerpet, Begumpet, Secunderabad, Dilsukhnagar, LB Nagar, Mehdipatnam), with
  the PIN code and centroid of 029's bundled table (`demo/fixtures/geocode/hyderabad.json`) jittered within 800 m.
- Services (030): an in-clinic service for everyone (₹500-₹2,500, `online` or `at_clinic`), a video consultation for
  about half (`online`), sometimes a free 15-minute introductory call or a developmental assessment. Weekly hours
  Monday-Friday morning and evening, often Saturday morning, in the location's time zone.

Writes are batch inserts in one transaction (all 028/029/030 triggers run: geography, consultation modes, location
checks) and one `seed.synthetic_providers` audit row. A second run with the same prefix is refused; reset first or use
another `--prefix`.

**Production guard.** The script exits with code 2 before connecting unless both `NEXT_PUBLIC_SUPABASE_URL` and
`DATABASE_URL` point at a local stack (`localhost`, `127.0.0.1`, `::1`, `*.localhost`, `host.docker.internal`), or
`ALLOW_SYNTHETIC_SEED=true` is set. Set that only for a staging/demo project, never in production.

**Reset (`--reset-synthetic`).** Deletes only `is_synthetic` profiles (under `--prefix` when given) with their
services, hours, appointments (their unsent notifications are cancelled; any old test-mode payment rows of those
appointments go too) and the `(Demo) ...` organisations that nothing else uses. An organisation is kept if it has a
non-synthetic provider, members, cases, documents, threads, sharing grants or any other row referencing it. Audit
rows stay (append-only); a `seed.synthetic_reset` row records the counts. Cached public profile pages (`/p/<slug>`,
1 h) of removed profiles may 404 only after the cache expires or the server restarts.

## Demo profiles in production (product decision 2026-11-12)

Synthetic profiles stay **visible** in production so the pilot can be demonstrated: every surface shows the
`Demo profile` badge (`/find` cards, `/p/<slug>` (noindex), `/book/<id>`, the screen's nearby providers).

**Demo-booking safeguard (FR-2a).** A real parent must never wait for a fictional doctor:

- `/book/<profileId>` of a demo profile shows `This is a demo profile. No real consultation will take place.` and the
  checkbox `I understand this is a demo`; `Continue` stays disabled until it is ticked.
- `POST /api/appointments/hold` needs `demo_ack: true` for demo profiles, else 422
  `{ error: "This is a demo profile. No real consultation will take place.", code: "demo_ack_required" }`. The check
  lives in `checkHoldPreconditions()` (`lib/booking/hooks.ts`), so the voice booking agent (034) gets it too.
- The database marks the appointment `appointments.is_demo = true` (derived from the profile, never from the request;
  cannot be switched off; reschedules stay demo) and:
  - **no payment:** the snapshot says `free` / ₹0, so confirming goes straight to `confirmed`; the payment-order route
    answers 409 and a `payments` row for it is refused;
  - **no Google Meet:** `meet_status = 'not_needed'`, so no `meet.create` job; demo video bookings therefore do not
    need a linked Google account;
  - **in-app only:** the outbox worker writes only `in_app` notifications for events about a demo appointment, and a
    trigger on `notifications` drops email/WhatsApp rows for them from any writer.
- `/family/appointments` labels them `Demo booking`.

Migration: `supabase/migrations/20261113004200_demo_appointments.sql` (`is_demo`, `outbox_event_is_demo()`, triggers
`appointments_demo_flag`, `notifications_demo_in_app_only`, `payments_refuse_demo`).

**Kill switch.** `SHOW_SYNTHETIC_LISTINGS=false` hides every demo profile at once: directory search and the public API
(`search_providers(..., p_include_synthetic => false)`), `/p/<slug>` and `/c/<slug>` (404), `/book/<id>` and the slots
API (404), and new holds. Existing demo appointments stay in the families' lists. Restart (or redeploy) after
changing it.

## Importing real providers (`scripts/import-providers.ts`)

**Consent first.** Only import providers who have agreed to be contacted and listed on DoctorNearMe (keep their
agreement, e.g. the signed recruitment form or email, outside this repository). Import public practice details only:
no personal phone numbers, no registration numbers (those come with the provider's own credential submission).

```bash
npm run -s import:providers -- --file pilot-batch-1.csv --dry-run   # validate + show what would be created
npm run -s import:providers -- --file pilot-batch-1.csv [--admin you@example.com]
```

CSV (UTF-8, header row, any column order):

| Column | Rules |
|---|---|
| `display_name` | required, at most 120 characters |
| `provider_type` | one of `developmental_pediatrician`, `child_psychiatrist`, `child_psychologist`, `speech_language_pathologist`, `occupational_therapist`, `aba_therapist`, `special_educator`, `physiotherapist`, `pediatrician` |
| `org_name`, `org_kind` | required; `centre` or `solo`. Rows with the same centre name share one organisation (and one location when the address matches) |
| `address_line1`, `locality`, `pincode` | required; 6-digit PIN code. City Hyderabad, state Telangana |
| `phone_public`, `website` | optional; the practice's public phone and `https://` website |
| `languages` | optional; `en`, `hi`, `te`, `ur`, `ta`, `kn`, `mr` separated by `;`, `|` or spaces |

- Every row is validated first with the admin-seeding rules (028). Any error prints `Row <n>, <column>: <message>` and
  **nothing** is imported (exit code 1). A provider with the same name at the same PIN code that already exists (or
  appears twice in the file) is an error too, so re-running a file is safe.
- Addresses are geocoded like admin seeding (029: Google with `GOOGLE_MAPS_SERVER_KEY`, else the bundled table). An
  address that cannot be placed is imported without coordinates and flagged in the output.
- Profiles are created through `seed_provider_profile` (the function behind `POST /api/admin/providers`) in one
  transaction: unclaimed, `unverified`, not listed, `is_synthetic = false`, with a `provider.imported` audit row each
  (actor: the `--admin` platform admin, else `system`).
- One claim link per profile (028, valid 14 days) is printed to **stdout only**: the tokens are never written to disk
  or stored (the database keeps their SHA-256). Send each link to its provider privately; a lost link is replaced
  with `Create claim link` on `/admin/providers` (which revokes the old one).
- After claiming, the provider completes the profile, submits credentials, is verified by a platform admin and turns
  on `Show my profile publicly` (028).
