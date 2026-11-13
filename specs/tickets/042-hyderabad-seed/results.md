# 042: Hyderabad directory seed data - Results

Branch: `ticket/042-hyderabad-seed` (merged with `main` incl. 034, 035, 036, 039). Local Supabase stack slot 4
(`127.0.0.1:60321`/`60322`, all migrations re-applied by `reset` after the merge), `DEMO_MODE=true`, dev server on
port 3040, own headless Chromium (Playwright) at 375 px. Synthetic data only. Evidence files in `evidence/`.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0 (merged tree) |
| `npm run typecheck` | PASS | exit 0 (after `npm run build` generated `next-env.d.ts`) |
| `npx vitest run` | PASS | final merged tree (after 036): 88 files, 1469 passed, 11 skipped (DB suites ran against slot 4). One earlier full run had 2 failures in `tests/documents-access.test.ts` (document-visibility notification rows, then a dependent list check); that file passes alone (18/18) and the next full run was green: a timing flake under parallel load, not touched by this ticket |
| `npm run build` | PASS | exit 0 |
| Ticket tests (`--reporter=verbose`) | PASS | `evidence/vitest-042.txt`: 47 passed in `tests/seed-hyderabad.test.ts` (10), `tests/import-providers.test.ts` (6), `tests/demo-booking.test.ts` (6), `tests/booking-agent-tools.test.ts` (25, 2 new) |
| Determinism, Hyderabad bbox, 800 m, flags | PASS | seed tests: same seed -> deep-equal plan, other seed differs; every location inside the bbox, at its locality's PIN code and <= 800 m from the centroid (60 and 1,000 profiles); all 9 types, 8 centres of 2-5; names `Dr. (Demo) <given> <initial>.`, `DEMO-<n>`, `+91 90000 0xxxx`, `*.example.com`; DB: 60/60 synthetic, verified, listed, unclaimed, no users, geography set, modes match services; generated hours give bookable slots |
| Production guard | PASS | unit (local/remote/missing/look-alike hosts, `ALLOW_SYNTHETIC_SEED`), CLI subprocess with `NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co` -> exit 2, `Refusing to write synthetic data ...`, 0 rows |
| Importer all-or-nothing, claim links not on disk | PASS | import tests: errors with row/column, invalid file writes nothing (also its valid row), dry run writes nothing, real run 3 profiles, links printed once, no token stored (hash only), file tree unchanged, link previews and claims via 028, re-import refused as a whole |
| **E-1** seed 1,000 < 60 s | PASS | `npm run -s seed:hyderabad -- --count 1000`: 0.65 s wall clock, `{"providers":1000,"centres":133,"locations":665,"services":1681,"rules":10573,"localities":14,"types":9,"ms":455}` (`evidence/e1-seed-1000.json`); SQL: 14 localities, 9 types, 1,000/1,000 synthetic, centres 2-5 providers (`evidence/e1-sql-counts.txt`) |
| **E-2** visibility + demo booking | PASS | `/find?lat=17.44&lng=78.349&radius_km=5`: `Dr. (Demo) ...` cards with `Demo profile` badges. curl hold without `demo_ack` -> 422 `{"error":"This is a demo profile. No real consultation will take place.","code":"demo_ack_required"}`, with it -> 201. Browser (guardian, phone OTP demo): notice + `I understand this is a demo` shown, `Continue` disabled until ticked, fee `Demo booking: no payment`, `Confirm booking` -> `Demo booking saved...`; `/family/appointments` shows `Demo booking` (`evidence/*.png`). DB: `confirmed`, `is_demo`, `meet_status not_needed`, snapshot free/0, 0 payments, `appointment.confirmed` fanned out to `in_app` only, 0 email/WhatsApp rows for any demo appointment (`evidence/e2-demo-booking-db.txt`, run again after merging main). Restart with `SHOW_SYNTHETIC_LISTINGS=false`: `/find` 0 demo cards, `/api/public/providers` `[]`, `/p/<demo slug>` 404, `/book/<demo id>` 404, hold 404 |
| **E-3** reset safety | PASS | non-synthetic profile created by `POST /api/admin/providers` (platform admin session, 201); before: 60 synthetic, 1 non-synthetic, 2 demo appointments; `--reset-synthetic` -> `{"providers":60,"centres":8,"solo_practices":38,"locations":46,"services":103,"rules":635,"appointments":2}`; after: 0 synthetic, the non-synthetic profile and its organisation unchanged. DB test compares the full row before/after |
| **E-4** importer | PASS | `.tmp/import-3040/invalid.csv` -> `Row 3, pincode: Enter a 6-digit PIN code`, `Row 4, provider_type: Unknown provider type "astrologer" ...`, exit 1, nothing imported; valid `--dry-run` -> 3 would-create lines, 0 rows; real run -> 3 profiles `unverified`, not listed, unclaimed, `is_synthetic = false`, 2 organisations (centre rows share one), geocoded; `/claim/<token>` from stdout renders `Dr. Synthetic Import One` (028 E-2); claim covered by the DB test |
| **E-5** guard + data review | PASS | guard as above; `scripts/data/demo-names.json`: given names + single initials (no family names), invented centre words; addresses `(Demo) Plot <n>, <placeholder street>`; registration numbers `DEMO-<n>`; phones in the `+91 90000 0xxxx` test range |

## Deviations

- **App code and a migration were touched** although the rd's "Don't touch" lists them: FR-2a itself requires the
  migration (`20261113004200_demo_appointments.sql`) and the hold/confirm/payment/notification/UI changes, as the
  coordinator asked (`checkHoldPreconditions()`, 031/032/037 paths). All edits are additive.
- **Synthetic seed writes with batch inserts, not `POST /api/admin/providers` / `seed_provider_profile`.** NFR-1
  asks for batch inserts (1,000 profiles in 0.5 s), and `seed_provider_profile` writes a `provider.verified` audit row
  per profile claiming an admin check that never happened. The inserts still go through every 028/029/030 trigger;
  one `seed.synthetic_providers` audit row records each run. The real-provider **importer does use
  `seed_provider_profile`** and `create_provider_claim_token` (the functions behind the admin routes).
- **`--prefix <acct>`** is interpreted as the slug prefix of a dataset (no accounts are created: profiles are
  unclaimed); `--reset-synthetic` alone deletes, it does not re-seed.
- **Centres scale with `--count`**: 8 per 60 profiles (133 at 1,000), each 2-5 providers.
- **Provider names** use a given name plus one initial (`Dr. (Demo) Ananya K.`) instead of full fictional names, so
  no generated name can match a real person (NFR-2).
- **Demo video bookings skip 037's Google-account requirement** (no Meet is ever created for them).
- **Voice agent (034)**: `hold_slot` gained an optional `demo_acknowledged` parameter; for a demo profile the agent
  gets `{ held: false, reason: "demo_ack_required" }` with instructions to read the notice and ask; the DEMO_MODE
  script does that. Without this the seeded directory could not be booked by voice at all.
- `tests/helpers/booking.ts` providers are now `is_synthetic = false`: they are test fixtures for real-provider
  behaviour; with the flag on, every booking suite would have become a demo booking (free, no Meet, no email).

## Notes

- New: `npm run -s seed:hyderabad`, `npm run -s import:providers`, env `ALLOW_SYNTHETIC_SEED`, docs
  `docs/pilot-seeding.md` (+ notes in booking, providers, notifications, payments, google-meet, system-design,
  elevenlabs-booking-agent docs).
- Schema: `appointments.is_demo` (trigger-derived from `provider_profiles.is_synthetic`, immutable), SQL helper
  `outbox_event_is_demo(aggregate_type, aggregate_id, payload)` (service role); triggers `appointments_demo_flag`,
  `notifications_demo_in_app_only`, `payments_refuse_demo`. `AppointmentView.is_demo`; `checkConfirmPreconditions`
  takes `isDemo`; `HoldSchema.demo_ack`.
- For later tickets: new appointment-related outbox topics should carry `appointment_id` in the payload so demo
  bookings stay in-app; any new code path that creates appointments gets `is_demo` automatically.
- Cached `/p/<slug>` pages (1 h, 028) of profiles removed by `--reset-synthetic` may keep rendering until the cache
  expires or the server restarts.
- The database stack of slot 4 is left running with the default 60-profile demo dataset seeded.
