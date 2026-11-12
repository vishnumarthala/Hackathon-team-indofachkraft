# 041: Privacy, audit and operations baseline - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, add `CRON_SECRET=test-<port>`, `npm install`.
- Snapshot `select count(*) from audit_events` -> `evidence/audit-before.txt`, then `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`; a synthetic child of `guardian_a` claimed into an
  org A case with consents, one processed demo session (`seed:demo -- --new` + 020 claim), one document
  (023), one message (027 if merged).
- Start: `DEMO_MODE=true npm run dev -- -p <port>` and `npm run -s outbox:run`. ElevenLabs delete API
  mocked. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/audit-hardening.test.ts tests/privacy-retention.test.ts tests/privacy-export-deletion.test.ts tests/no-tracking.test.ts --reporter=verbose` exits 0:
  - `update`/`delete` on `audit_events` raise for every role;
  - every action in `lib/audit/strict-actions.ts` is implemented with `auditStrict` (static + runtime
    test that forces the audit insert to fail and asserts 503 and no state change);
  - actor fields come from the session (a body `actor` field is ignored);
  - retention job: audio older than 90 days after transcription deleted, transcript kept; pending
    uploads > 24 h deleted; counts audited; second run is a no-op;
  - export contains only items the guardian can see (provider-only document excluded);
  - deletion job idempotent; ElevenLabs delete called once per `external_id`; failure recorded and retried;
  - no `/family/**` page loads a third-party script.

## Acceptance checks

### E-1: Audit survives and is attributed (FR-1, FR-3)

1. Audit row count after migration >= `evidence/audit-before.txt`; `case_ref` filled for old rows.
2. As `provider_a`, confirm a fact: the new audit row has `actor_user_id = provider_a`, `actor_role = provider`.
3. Delete a synthetic test case via SQL: its audit rows still exist with `case_ref` set.

### E-2: Fail closed (FR-2)

Make the audit insert fail (test hook `AUDIT_FAIL_ACTIONS=consent.granted` in dev only) and grant
consent: 503 message, no `consent_records` row. Remove the hook: works.

### E-3: Export (FR-7)

As `guardian_a`, `Download <child>'s data`: notification arrives; ZIP downloads; `child.json` has
consents, health profile, published plans; provider-only document absent. 4th request in a day -> 429.
`guardian_b` downloading the export -> 404.

### E-4: Deletion request (FR-8)

1. `guardian_a` requests `everything`; `platform_admin` approves. After the job: child pseudonymised,
   recordings/objects/documents removed, consents show `withdrawn` records appended, `processor_deletions`
   has an ElevenLabs row per conversation (mock 200), guardian notified. Audit rows retained.
2. Provider opening the case afterwards sees no clinical content (404 or `Deleted child` placeholder).
3. `provider_a` approving a request -> 403.

### E-5: Notice, docs, ops (FR-10 - FR-12)

`/privacy` shows the draft badge, processors with locations and the retention table in en/hi/te.
Docs exist with the FR-11 content (72-hour timeline present). `GET /api/health` -> 200 JSON; with DB
stopped (mock) -> 503. `/admin/ops` shows outbox and retention status; provider -> denied.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] Open questions handed to the human owners (legal review) are listed in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
