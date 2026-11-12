# 020: Children, guardian links and consent gating - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` before coding (Next.js 16.4 breaking changes: async request APIs,
  route handlers, `notFound`).
- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Before migrating, snapshot legacy data: `npm run -s db:sql -- "select id, child_alias from cases order by id"`
  -> `evidence/cases-before.txt`. Then `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; demo case: `npm run -s seed:demo -- --new`
  (prints synthetic guardian + consents per FR-18). Use a second `seed:demo -- --new --no-guardian`
  (flag added here) for an unclaimed case.
- Start: `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-<port> npm run dev -- -p <port>`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/consent-*.test.ts tests/children-*.test.ts tests/legacy-backfill.test.ts --reporter=verbose` exits 0, covering:
  - every route listed in FR-7 returns 422 with the FR-8 body when its feature is not granted (table-driven test over all gated routes);
  - queued re-check: grant -> enqueue transcription -> withdraw -> run processor: Scribe mock never called, recording `failed` / `consent_withdrawn`, audit `consent.blocked_processing`;
  - same for Gemini extraction, TTS voice note, intake webhook processing;
  - `consent_records` update/delete raise; `record_consent` with a forced audit failure leaves no row and returns 503;
  - claim code: format, hash-only storage, single use, 72 h expiry, older code invalidated, 429 after 5 failures;
  - backfill idempotence: running the backfill twice creates no duplicate children.

## Acceptance checks

### E-1: Legacy backfill (FR-3, rule 1)

1. Compare `evidence/cases-before.txt` with the same query after migration: identical ids and aliases.
2. `select count(*) from cases where child_id is null` = 0; every legacy child has `source = 'legacy_case'`.
3. `select count(*) from guardian_links gl join cases c on c.child_id = gl.child_id where c.created_at < '<migration ts>'` = 0
   (except synthetic seeded demo cases flagged `seed:synthetic`). No `consent_records` for legacy children.
4. Recordings/facts/reports counts per legacy case unchanged.

### E-2: Guardian adds a child and consents (FR-11, FR-13)

1. As `guardian_a`, `Add a child` `<acct> Asha`, DOB 2023-05-01, relationship `mother`, declaration ticked -> child listed.
2. Open the child, `Allow` `ai_intake_call`: status `Allowed`, `consent_records` row references the
   displayed document version + locale, audit `consent.granted`.
3. Repeat as a Google-only guardian without verified phone (mock) -> FR-13 422 message.
4. Post an older `consent_document_id` -> 409.

### E-3: Claim code links a clinic case (FR-12, FR-14)

1. As `provider_a`, on the unclaimed case's `Consent` panel click `Create parent code`; note code.
2. As `guardian_b`, `I have a code from my therapist`, enter it -> child appears; provider panel shows `Parent account linked`.
3. Reuse the code as `guardian_a` -> `This code is not valid`; random code -> same message.

### E-4: Gates block real work (FR-7, FR-8, FR-10)

1. On the claimed case without consents, as `provider_a`: `Create intake link`, start upload, transcribe,
   extract, parent voice note, refer -> each blocked with `Guardian consent required` and the hint; no
   external mock called (check fixture access log).
2. Grant `ai_intake_call`, create link, then withdraw: open `/intake/<token>` -> expired message;
   `POST /api/intake/<token>/start` -> 410.
3. Referral created with `referral_share`, then withdrawn: `/specialist/<token>` shows the unavailable
   message; `POST /api/cases/:id/ask` -> 410.
4. Intake token older than 7 days (set `intake_token_expires_at` in the past via SQL) -> 410.

### E-5: Cross-org and authz negatives (FR-15, FR-16, rule 2)

1. Create a second case in org B (as `provider_b`); `guardian_b` claims its code choosing the existing
   child from E-3 -> both cases share one `child_id`, placeholder soft-deleted.
   `provider_a` requests org B's case, recordings, reports, consent panel -> 404 each.
2. `guardian_a` (not linked) requests `/family/children/<child of guardian_b>` and its consent APIs -> 404.
3. `guardian_b` leaves the child; the next request to that child's pages/APIs -> 404.
4. `provider_a` calls `POST /api/family/children/:id/consents` -> 403 (providers can never grant consent).

### E-5a: Paper consent (FR-18a-e)

1. On a legacy case with no guardian account, open `Print consent form`: every feature's current text,
   processors and version id are shown in the chosen language.
2. Record paper consent for `ai_transcription` only, with a synthetic scan: the transcription gate now
   passes; extraction is still blocked with the FR-8 error. The panel shows `On paper, recorded by ...`.
3. Missing scan, missing attestation, a future `signed_on` and an outdated document version give 400/400/400/409
   and write nothing. A forced audit failure gives 503 and writes nothing.
4. A provider of another org gets 404 on both paper-consent endpoints. The scan is only reachable by
   signed URL for members of the case's org.
5. Record a paper withdrawal: the gate blocks again, and queued work for that feature aborts (FR-8).
6. Claim the child with a guardian account: the family page shows `Given on paper on <date>`, and a
   digital withdrawal by the guardian blocks the gate.

### E-6: Demo flow still works (FR-18)

Run the seeded synthetic demo case through intake simulate -> transcribe -> extract -> report: all succeed.

## Definition of done

- [ ] All checks pass with evidence in `results.md` (including the gated-route table output).
- [ ] No consent or guardian link was created for any non-synthetic legacy case.
- [ ] A builder reviews results and manually merges the passing ticket branch.
