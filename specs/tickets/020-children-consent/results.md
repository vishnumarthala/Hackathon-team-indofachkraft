# 020: Children, guardian links and consent gating - Results

Branch: `ticket/020-children-consent`. Tested against the isolated local Supabase stack `dnmslot4` (ports
603xx; all seven migrations applied by `db reset`), `DEMO_MODE=true`, `DEMO_FIXTURES_DIR=.tmp/fx-3040`,
dev server on port 3040, integrated browser (Playwright). Accounts from `npm run -s seed:users -- --prefix acct`;
synthetic data only. Raw evidence in `evidence/` (`acceptance.txt` = scripted API/HTML run, 98 checks after the merge below, all PASS;
`vitest-020-verbose.txt` = the eval test command incl. the gated-route table; screenshots).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002000_children_consent.sql` | PASS | expand -> backfill -> enforce: `children`, `guardian_links`, `consent_documents` (v1 x 8 features x en/hi/te = 24 rows), `consent_records` (append-only trigger + revoked writes for every role), view `child_consent_state`, `child_claim_codes`, `child_claim_attempts`, `cases.child_id` (not null), intake/referral lifetimes, private bucket `consent-forms`, RLS policies, security-definer functions `record_consent`, `create_guardian_child`, `create_child_claim_code`, `claim_child`, `backfill_case_children`. Applied twice on legacy data without error; `has_function_privilege`: anon/authenticated cannot execute any of them; authenticated has no insert on any new table |
| `npm run verify` (lint, typecheck, vitest, build) | PASS | exit 0; vitest 47 files, 621 passed, 10 skipped (the pre-existing ticket 010 block in `intake-completion.test.ts`). DB suites ran (orgs-authz, extraction, speakers, ask, i18n-locale, guardian suites and the six new files) |
| `npx vitest run tests/consent-*.test.ts tests/children-*.test.ts tests/legacy-backfill.test.ts --reporter=verbose` | PASS | 6 files, 42 passed, 0 skipped (`evidence/vitest-020-verbose.txt`): table-driven 422 over all 10 gated routes with the exact FR-8 body and zero external-mock calls; queued re-checks for transcription (Scribe), upload completion, extraction (Gemini), voice note (TTS), intake webhook and brief generation: processor never called, recording `failed`/`consent_withdrawn`, audit `consent.blocked_processing`; `consent_records` update/delete/truncate raise, service-role writes refused; forced audit failure -> 503 and no row (digital and paper); claim code format, hash-only storage, single use, 72 h expiry, older code invalidated, 429 after 5 failures; backfill twice -> no duplicate children, no links, no consent |
| E-1 legacy backfill (FR-3, rule 1) | PASS | Pre-020 DB with 4 synthetic legacy cases + 1 legacy referral, migration applied twice: `cases-before.txt` = `cases-after.txt`; recordings/facts/reports/referrals/audit counts per case identical (`dependants-*.txt`); `cases without child_id` 0; all 4 children `legacy_case`; 0 guardian links, 0 consent records; second backfill touched 0 (`backfill-check.txt`). After `db reset`: `npm run db:check` -> `cases without child_id: 0` |
| E-2 guardian adds a child and consents (FR-11, FR-13) | PASS | `acct Asha`, DOB 2023-05-01, mother: 201, listed with `3 years, 6 months`; missing declaration 400. `Allow` ai_intake_call: 201, record references the shown document (v1, en), audit `consent.granted` (actor parent); page shows `Allowed`. Guardian without verified phone: 422 `Verify your mobile number before giving permission`. Older document version: 409 `Please review the updated text`. Browser at 375 px: add child form -> child page -> tick + `Allow` -> `Allowed` |
| E-3 claim code (FR-12, FR-14) | PASS | Panel `No parent account linked yet` + `Create parent code` -> 201 `WE7Y-9D6Y`-style code, 72 h, WhatsApp link; only the sha256 is stored. guardian_b claims -> 201, child listed, panel `Parent account linked`. Reuse by guardian_a and a random code -> 404 `This code is not valid` |
| E-4 gates block real work (FR-7, FR-8, FR-10) | PASS | Claimed case without consent: intake link, upload, transcribe, extract, draft report, voice note, refer -> 422 FR-8 body each, run with the fixture directory moved away (any mock access would have failed). Browser: `Create intake link` shows `Guardian consent required. Ask the parent to allow this in their DoctorNearMe app.` (`provider-blocked-hint.png`). Allow + link + withdraw: `/intake/<token>` shows `This link has expired. Please ask your therapist for a new link.`, `start` 410. Referral with consent, then withdrawn: `/specialist/<token>` shows `This shared case is no longer available.`, `ask` 410, referral `revoked`. Token backdated > 7 days -> 410; `DELETE intake-link` -> `{revoked:true}`, audit `intake.link_revoked`, re-create issues a new token |
| E-5 cross-org and authz negatives (FR-15, FR-16, rule 2) | PASS | provider_b case in org B; guardian_b claims its code choosing the E-3 child -> both cases share one `child_id`, placeholder soft-deleted. provider_a: `/cases/<orgB>` (+ sessions, report, consent pages) 404, `PATCH`/claim-code/paper-consents 404. guardian_a on guardian_b's child page and consent API -> 404. guardian_b leaves -> next page and API request 404. provider_a `POST /api/family/children/:id/consents` -> 403. Platform admin link revocation covered by test |
| E-5a paper consent (FR-18a-e) | PASS | Printable form in en/hi/te lists all 8 current texts, processors and document ids (`consent-form-te-print.png`, tabs/header hidden in print). Paper consent for `ai_transcription` only on a legacy case: transcription 200, extraction 422; panel `On paper, recorded by acct-provider-a@example.test on 13 November 2026` (`provider-consent-panel.png`). Missing scan / attestation / future `signed_on` / outdated text -> 400/400/400/409, forced audit failure -> 503; nothing written (0 records, 0 scans). Other org: 404 on both endpoints and the scan route; own org: 302 to a 60 s signed URL serving the PDF; no public access. Paper withdrawal -> gate blocks, queued work aborts (test). Guardian claims: family page `Given on paper on 13 November 2026`; digital withdrawal blocks the gate. Browser: paper form submitted with the Telugu form version -> `Saved.` |
| E-6 demo flow (FR-18) | PASS | `seed:demo -- --new --stage transcribed`: synthetic guardian `demo-guardian@example.com`, link and 8 consents (`user_agent = seed:synthetic`); intake simulate (brief true) -> transcribe 200 -> extract 200 (40 facts) -> confirm -> report draft 200. `seed:demo` (canonical, re-run twice) and `seed:demo -- --new --no-guardian` work |
| NFR-3 translated, 375 px, no third-party scripts | PASS | `/family/children`, `/new`, `/claim`, `/[id]` in Telugu: `lang="te-IN"`, `scrollWidth = innerWidth = 375`, 0 external scripts (`family-child-te-375.png`, `family-claim-te-375.png`); all new keys in en/hi/te, `messages/REVIEW.md` regenerated, `tests/i18n-keys.test.ts` passes |

## Deviations

- **Upload-completion re-check (session_recording).** There is no separate "upload finished" endpoint (the
  browser uploads straight to storage), so the re-check runs at the first server touch of the audio: the
  first transcription of a `created` recording. Re-transcribing audio that was already processed needs only
  `ai_transcription` (E-5a step 2 expects this) and keeps the audio when aborted; never-processed audio is
  deleted on abort.
- **Intake completion grace.** `complete` and webhook processing accept a link up to 2 hours after its
  7-day expiry (a call started before expiry may finish after it); revoked links and missing consent are
  never accepted. `start`, the page and the simulator have no grace.
- **Intake link page without consent.** Links of children without `ai_intake_call` consent (e.g. legacy
  tokens) show the same expired message, and the provider's Brief tab no longer shows them.
- **Withdrawal records.** Digital and paper withdrawals store the current document of the feature in the
  guardian's locale (or the case language) for reference; they need no document id from the client. Paper
  withdrawal rows need provider + guardian name only (no scan, relationship or date).
- **Merging into an existing child (FR-12).** Also refused (409) when the placeholder already has consent
  records (e.g. paper consent), so a merge never silently changes a case's consent basis.
- **Digital consent and leaving.** A digital grant stops counting when the granting guardian's link is
  revoked (fail closed); paper grants count until withdrawn.
- **External deletion.** On abort, audio in our storage is deleted; deleting the ElevenLabs conversation of
  an already-finished intake call is left to ticket 041 (external processor deletion).
- **Consent texts** (24 rows) are a first draft, Hindi/Telugu by the worker; legal review is open (plan 6).
  UI copy rows are `pending` in `messages/REVIEW.md`.
- **Seed guardian email** is `demo-guardian@example.com` (the demo folder rule allows only `@example.com`).
  It is marked phone-verified in `user_profiles` without a phone number (synthetic, local/demo only).
  `seed:users` needed no change (its guardians already have verified test phones).
- **Specialist page** text is English like the rest of that page (not translated before this ticket).
- **`next.config.ts`**: `experimental.proxyClientMaxBodySize = "12mb"` so the proxy does not truncate a
  10 MB scan plus multipart overhead.

## Notes

- **New helpers:** `lib/consent` (`requireConsent`, `requireCaseConsent`, `assertConsentOrAbort`,
  `hasConsent`, `getConsentState`, `consentRequired`, `publicConsentState`, `childIdForCase`),
  `lib/consent/features.ts` (keys, `FEATURE_GATES`, `withConsentHint`, client-safe), `lib/consent/records.ts`
  (`recordConsent`, `currentDocuments`, `hashIp`), `lib/consent/paper.ts`, `lib/children` (child/link queries,
  claim codes, schemas, `ageParts`), `lib/intake/link.ts` (`intakeLinkState`), `lib/queries/referrals.ts`
  `getSharedReferral`; `lib/authz.ts` adds `requireChildGuardian`, `requireChildGuardianPage`,
  `requireChildAccessViaCase`, `requireCaseActor`. Test helpers: `tests/helpers/consent.ts`
  (`consentAllowedModule`, `grantSyntheticConsent`, `purgeSyntheticChildren`), `tests/helpers/world.ts`.
- **Next tickets:** 033 must call `requireConsent(childId, "screen_result_save")`; 040 must gate the agent
  with `ai_follow_up` and `assertConsentOrAbort` before each question; 022 (sharing) builds on
  `requireChildAccessViaCase`; 041 registers `consent-forms` scans for retention and handles external
  deletion. Route unit tests that mock the DB must mock `@/lib/consent` (see the helper). Details:
  `docs/consent.md`.
- **Env:** `CONSENT_IP_SALT` (optional; falls back to the service role key).
- **API change:** referral share links that are revoked/expired/unconsented now answer 410 (was 404) on
  `POST /api/cases/:id/ask`; `tests/ask.test.ts` updated. `ReferRequestSchema` no longer has
  `parent_consent`; the Referral form lost its checkbox (server-side consent instead).
- The 5-failures-per-hour claim limit showed up on a repeated local acceptance run (guardian_a had used up
  its attempts in earlier runs: 429 as designed); the final run first clears the synthetic accounts' attempts.
- **Pre-existing, not changed:** a browser holding a session cookie for a user that no longer exists
  (e.g. after `db reset`) gets a 500 from `proxy.ts` (`User from sub claim in JWT does not exist` is not
  treated as an invalid session). Clearing cookies fixes it.

## Merge with `main` (028 provider profiles, 029 PostGIS directory)

- `git merge main` into `ticket/020-children-consent`. Conflicts: `messages/{en,hi,te}.json` (both sides'
  keys kept, deep-merged, no value clashes), `messages/REVIEW.md` (regenerated with
  `npx tsx scripts/i18n-review.ts`), `next.config.ts` (020 `proxyClientMaxBodySize` + 029 request-log filter).
  `lib/authz.ts`, `lib/env.ts`, `.env.example`, `docs/system-design.md` merged automatically.
- Migration order: `20261113002000_children_consent` -> `20261113002800_provider_profiles` ->
  `20261113002900_postgis_directory`; `db reset` on slot 4 applied all nine migrations.
- 028's stand-in: `user_has_guardian_links()` (028 migration) already reads `guardian_links.user_id` /
  `status = 'active'` dynamically, which matches 020's table, so no migration change is needed (existing
  migrations are not edited). `tests/provider-profiles.test.ts` no longer creates a fake `guardian_links`
  table: it inserts a real synthetic child + active link, expects `user_has_guardian_links() = true` and 403
  on `POST /api/providers/register` (role stays guardian, no profile), and `false` once the link is revoked.
  The acceptance run also checks the function against a link created through the claim flow.
- Note for 041/ops: the 028 function returns `false` if `guardian_links` were ever missing (fail open);
  with 020 merged first the table always exists.
- After the merge, slot 4 reset: `npm run lint` and `npm run typecheck` exit 0; `npx vitest run` 52 files,
  701 passed, 10 skipped (the pre-existing 010 block; all DB suites ran, including 028/029 and the 020
  suites); `npm run build` exit 0; acceptance script 98/98 PASS. (The intake-page check in the script now
  matches the rendered element instead of the page text, because the English catalogue is embedded in the
  RSC payload.)
