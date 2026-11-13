# 042: Hyderabad directory seed data (synthetic demo + real-provider import)

**Status:** done
**Mode:** solo
**Runs:** waits for 029, 030: seeds geo-located profiles (029) with services and availability (030)

## Summary

Two scripts. (1) A synthetic Hyderabad dataset so the directory, booking and voice agents can be
demonstrated and load-tested without real people: fictional providers and centres across real
Hyderabad localities, flagged `is_synthetic`, visible in production with a `Demo profile` badge (product decision
2026-11-12) and protected so a real parent cannot mistake them for real care (FR-2a). (2) A CSV importer for the real
pilot: platform admins import recruited providers' public details as **unclaimed, unverified** profiles
and generate claim links (028).

## Functional requirements

- **FR-1** - `npm run -s seed:hyderabad -- [--count 60] [--prefix <acct>] [--reset-synthetic]`
  (`scripts/seed-hyderabad.ts`): refuses to run unless `NEXT_PUBLIC_SUPABASE_URL` is local or
  `ALLOW_SYNTHETIC_SEED=true`; creates `count` provider profiles (default 60) spread over at least 12
  localities (Banjara Hills, Jubilee Hills, Gachibowli, Madhapur, HITEC City, Kondapur, Kukatpally,
  Miyapur, Ameerpet, Begumpet, Secunderabad, Dilsukhnagar, LB Nagar, Mehdipatnam), all 9 provider
  types (028) with realistic proportions, 8 centres (`organizations.kind = 'centre'`) with 2-5 providers each,
  languages from {en, hi, te, ur}, coordinates jittered within 800 m of locality centres, services
  (in-clinic and video, fees ₹500-₹2,500, mixed `payment_mode`) and weekly rules (030).
- **FR-2** - Every synthetic record: `is_synthetic = true`, names from a fixed fictional list prefixed
  `Dr. (Demo)` / `(Demo) ... Centre`, phone `+91 90000 0xxxx` (test range), emails `@example.com`,
  registration numbers `DEMO-<n>`, `verification_status = 'verified'` and `listed = true` (searchable unless `SHOW_SYNTHETIC_LISTINGS=false`), no auth users (unclaimed). Deterministic with a
  seed value (`--seed 42` default) so evals are reproducible.
- **FR-2a** - Demo booking safeguard: holding a slot on an `is_synthetic` profile shows
  `This is a demo profile. No real consultation will take place.` and requires the checkbox
  `I understand this is a demo` (`demo_ack: true` in the hold body, else 422). Such appointments are stored with
  `is_demo = true`, skip payment capture and every outbound email/WhatsApp notification (in-app only), and
  never create a Meet event.
  Migration `<ts>_demo_appointments.sql` adds `appointments.is_demo boolean not null default false`.
- **FR-3** - `--reset-synthetic` deletes only `is_synthetic` rows (and their appointments) - never
  touches non-synthetic data; summary printed as JSON `{ providers, centres, locations, services, rules }`.
- **FR-4** - Real-provider import `npm run -s import:providers -- --file <csv> [--dry-run]`
  (`scripts/import-providers.ts`): columns `display_name, provider_type, org_name, org_kind,
  address_line1, locality, pincode, phone_public, languages, website`; validates every row (report of
  errors with row numbers, nothing imported if any error); geocodes via 029; creates unclaimed,
  `unverified`, `listed = false`, `is_synthetic = false` profiles; prints a claim link per profile (028)
  to stdout only (never written to disk). Dry run prints what would be created.
- **FR-5** - `docs/pilot-seeding.md`: when to use each script, the production guard, how to run the
  import, consent/permission expectation (only import providers who agreed to be contacted/listed),
  the `Demo profile` badge and demo-booking safeguard, and the `SHOW_SYNTHETIC_LISTINGS=false` kill switch.

## Non-functional requirements

- **NFR-1** - Seeding 1,000 profiles completes in < 60 s locally (batch inserts).
- **NFR-2** - No real person's or business's name, phone or registration number in the synthetic list.

## Affected areas

- `scripts/seed-hyderabad.ts`, `scripts/import-providers.ts`, `scripts/data/hyderabad-localities.json`,
  `scripts/data/demo-names.json` (new); `package.json` (script entries only)
- `docs/pilot-seeding.md` (new); `tests/seed-hyderabad.test.ts`, `tests/import-providers.test.ts` (new)

## Don't touch

- App code and migrations (data only), `BOARD.md`

## Out of scope

- Scraping provider data from the web or Google Places; seeding guardians/children; cities beyond Hyderabad.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Launch city | Hyderabad | plan §1 |
| D-2 | Real pilot vs demo | Synthetic profiles stay visible with a `Demo profile` badge and demo-booking safeguard; real providers via import + claim | product owner 2026-11-12: "no need" to hide; safeguard so real parents never wait for a fictional doctor |
| D-3 | Real imports | Unclaimed + unverified until claim and manual verification | plan §2 "Verification", "Availability / onboarding" |

## Open questions

None.
