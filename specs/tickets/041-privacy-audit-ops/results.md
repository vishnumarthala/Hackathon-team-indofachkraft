# 041: Privacy, audit and operations baseline - Results

Branch: `ticket/041-privacy-audit-ops` (base: `main` with 017-023, 028, 029, 032 merged). Tested against the isolated
local Supabase stack of slot 5 (ports 613xx; every migration applied by `db reset`), `DEMO_MODE=true`,
`CRON_SECRET=test-3050`, dev server on port 3050, curl/`fetch` with private cookie jars and an isolated headless Chrome
(`playwright-core` in the git-ignored `.tmp/`, own cookie jar - not the shared integrated browser). Accounts from
`npm run -s seed:users -- --prefix e041`; synthetic data only; ElevenLabs deletion mocked (DEMO_MODE) or stubbed in
tests. Raw evidence in `evidence/` (`acceptance.txt` 43 checks, all PASS; `ui.txt` 8 checks, all PASS; `vitest-041-verbose.txt`,
`no-tracking-live-crawl.txt`, `log-grep.txt`, `deletion.txt`, `export-listing.txt`, screenshots).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113004100_audit_hardening.sql` | PASS | expand -> backfill -> enforce: `actor_role` (not null after backfill), `org_id`, `child_id`, `case_ref`, `request_id`, `ip_hash`; `case_id` FK dropped (column kept + indexed); `actor` check extended (old values kept); before-insert trigger fills `actor_role` (from `user_profiles`), `case_ref`, `child_id`, `org_id` for every writer incl. the 017-032 SQL functions; update/delete/truncate revoked from anon/authenticated/service_role and a trigger raises for every role incl. the owner; maintenance functions `audit_purge_expired` (refuses < 1 year) and `audit_redact_child`. Applied to a pre-041 DB with legacy rows (`audit-before.txt` 6 rows / 5 with case -> `audit-after-migration.txt` 6 rows, `case_ref` = `case_id` for all 5, roles mapped: therapist->provider, parent->anonymous/guardian, ai, system, specialist->anonymous) |
| Migration `20261113004101_privacy.sql` | PASS | private bucket `exports` (zip), `privacy_exports` (one queued/building per child: partial unique index), `deletion_requests` (one open per child, rejection note >= 10 chars, plain-uuid actors so the legal record survives account deletion), `processor_deletions`; `recordings.transcribed_at` / `audio_deleted_at` / `status_changed_at` (backfilled, trigger-maintained); consent log stays append-only except `privacy_redact_consent_records` (free text only); `privacy_withdraw_consents`. RLS on, anon/authenticated revoked. `db reset` applies all 16 migrations |
| `npm run lint` / `npm run typecheck` | PASS | exit 0 / exit 0 |
| `npx vitest run` (slot 5, after `db reset`) | PASS | 64 files, 938 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS=1` block of 10 + the live crawl, which needs `NO_TRACKING_BASE_URL`; it was run separately, row FR-13). Every DB suite ran |
| `npm run build` | PASS | exit 0; new routes `/privacy`, `/family/children/[id]/privacy`, `/admin/{audit,ops,privacy/requests}`, `/api/health`, `/api/cron/{retention,privacy}`, `/api/family/children/[id]/{exports,deletion-requests}`, `/api/family/exports/[id]/download`, `/api/admin/privacy/requests/[id]` |
| `npx vitest run tests/audit-hardening.test.ts tests/privacy-retention.test.ts tests/privacy-export-deletion.test.ts tests/no-tracking.test.ts --reporter=verbose` | PASS | 4 files, 56 passed, 1 skipped (live crawl, run below) - `evidence/vitest-041-verbose.txt` |
| update/delete on `audit_events` raise for every role | PASS | `audit-hardening`: anon/authenticated/service_role -> `permission denied` for update, delete, truncate; owner -> `audit_events is append-only` (truncate refused even with the maintenance flag); service_role can still insert/read |
| every action in `lib/audit/strict-actions.ts` uses `auditStrict` (static + runtime) | PASS | static, per entry (21): route exists and calls the function; `auditStrict` kind: the function body has `.begin(`, `auditStrict(` and the action name; `sql` kind: the migration's function inserts into `audit_events` and the module honours `AUDIT_FAIL_ACTIONS`. Runtime forced audit failure (trigger scoped to the test user) -> 503 `Could not save. Please try again.` and no state change for: invitation create/accept/revoke, member revoke, provider registration (role change), guardian leave, admin link revoke, consent grant (SQL function), export request, export download, deletion request, deletion review. Sharing, documents, paper consent and claims keep their own forced-failure tests (022/023/020 suites, green) |
| actor fields come from the session (body `actor` ignored) | PASS | deletion request with body `actor/actor_user_id/actor_role` of the admin -> row has the guardian; fact confirm with body `actor: "ai"` -> provider; E-1 step 2 below |
| retention: audio > 90 days after transcription deleted, transcript kept; pending uploads deleted; counts audited; second run no-op | PASS | `privacy-retention`: object + `storage_path` gone, `segments` kept, 10-day-old audio kept; 25 h `created` recording row+object gone; 2 h pending document row+object gone (1 h rule), 25 h orphan object gone, 1 h orphan kept; expired export; in-app 181 d deleted, email 91 d stripped, 10 d kept; 25-month sign-up deleted; 8-year audit row purged, 6-year kept; FR-9 withdrawn-consent audio deleted, granted kept; one `retention.run` audit with `details.counts` equal to the result; second run: every count 0; cron 401/401/200 |
| export contains only items the guardian can see | PASS | `privacy-export-deletion`: `child.json` sections child/links, consents (8, `by_you`), health profile, documents = family upload + visible provider upload; provider-only document absent from JSON and files (no `Provider-only` byte in the ZIP); no transcript text |
| deletion job idempotent; ElevenLabs delete once per `external_id`; failure recorded and retried | PASS | first run: conversation 1 `deleted 200`, conversation 2 `failed 503`, Gemini `not_applicable`, request `failed` (local erasure already done); second run retries only conversation 2 -> `completed`; mock calls: conv 1 x1, conv 2 x2; third run -> `null` (no-op, mock not called) |
| no `/family/**` page loads a third-party script | PASS | allowlist/CSP unit checks; static scan of the module graph of 17 family pages + layouts (no external `<script src>`, `next/script`, injected scripts, tracker calls or tracker hosts in client modules); live crawl (`NO_TRACKING_BASE_URL=http://localhost:3050`): 17 rendered pages as a signed-in synthetic guardian with a child, 17-21 scripts each, all same-origin (`evidence/no-tracking-live-crawl.txt`) |
| E-1.1 audit rows after migration | PASS | `audit-before.txt` 6 -> `audit-after-migration.txt` 6, `case_ref` filled for the 5 case rows |
| E-1.2 provider_a confirms a fact | PASS | `PATCH /api/facts/:id` 200; row `actor_user_id = provider_a`, `actor_role = provider`, `child_id`/`org_id` filled (`acceptance.txt`) |
| E-1.3 delete a synthetic case via SQL | PASS | 3 rows (`case.assignment_initial`/system, `case.created`/provider, `case.updated`/provider) still present with `case_ref` |
| E-2 fail closed | PASS | dev server with `AUDIT_FAIL_ACTIONS=consent.granted`: grant -> 503 `{"error":"Could not save. Please try again."}`, 0 `consent_records` rows; restarted without the hook: 201, 1 row. Also automated (`audit-hardening`) |
| E-3 export | PASS | `Download <child>'s data` (browser, 375 px) and API: 202 -> job ran via `after()` -> `ready`; in-app notification `Your data download is ready`; download 302 to a 10-min signed URL; ZIP = `child.json` + 2 files (`export-listing.txt`); consents, health profile present; provider-only document absent; 4th request in a day -> 429; guardian_b -> 404; provider_a -> 403. Published plans: no section yet (024/025 not merged, see Notes) |
| E-4.1 deletion request `everything` | PASS | guardian_a 201 -> platform_admin approves (200) -> job completed right after approval: child `Deleted child` (no DOB), 7 storage objects -> 0 (audio, documents, exports), cases/recordings/documents/health rows 0, consents 7 granted + 7 `withdrawn` appended (state all withdrawn), `processor_deletions`: ElevenLabs conversation `deleted 200` + Gemini `not_applicable`, guardian notified (`Your deletion request is complete`), audit rows for the child 11 -> 15 (retained, free text stripped) (`deletion.txt`) |
| E-4.2 provider opens the case afterwards | PASS | `/cases/<id>` 404 and `PATCH /api/cases/<id>` 404; guardian's child page 404 |
| E-4.3 `provider_a` approving | PASS | 403 (guardian 403 as well); rejection without a cited note 400; browser: `Reject` without a note refused, with the note -> `rejected`, guardian sees `Not carried out` + the reason (`family-privacy-rejected-375.png`) |
| E-5 `/privacy` | PASS | en/hi/te: draft badge, processor table with locations (ElevenLabs USA, Gemini outside India, Resend USA, Meta WhatsApp, Supabase `SUPABASE_REGION_LABEL`), retention table from the policy in effect; Telugu at 375 px without horizontal scroll (`privacy-notice-te-375.png`). Linked from the landing footer, family footer, both login pages, every guardian permission card, the provider consent panel, paper consent form and the printed form |
| E-5 docs | PASS | `docs/privacy/incident-response.md` (detection, severity, roles, 72-hour Board report + immediate intimation to Board and guardians, containment: rotate keys / revoke tokens / disable agents, evidence preservation, templates), `docs/privacy/processors.md`, `docs/privacy/retention.md` |
| E-5 health and ops | PASS | `GET /api/health` -> 200 `{"ok":true,"db":"ok","version":"0.1.0"}`; database unavailable (mocked) -> 503 `{ ok: false, db: "unreachable" }` (unit); `/admin/ops` (platform admin) shows outbox backlog/dead, last retention run + counts, privacy jobs, failed processor deletions, stuck recordings (`admin-ops.png`); provider -> 404 |
| FR-4 `/admin/audit` | PASS | filters Action (exact or `prefix.*`), Actor (user id or role), Organisation, Child, Case, From/To; keyset pages of 50; no `details`; viewing writes `audit.viewed` (actor = platform admin); guardian redirected, provider 404 (`admin-audit.png`) |
| NFR-1 idempotent and resumable | PASS | export re-run -> `skipped`; deletion steps recorded in `deletion_requests.steps`, completed request never re-claimed; retention second run all zero |
| NFR-2 no personal data in logs | PASS | `lib/log.ts` `redact()` (unit test: emails, phones with last 4, tokens, signed-URL params; ids/dates/counts kept); dev server log of the whole acceptance run (171 lines): 0 matches for seeded emails, phones, child names, allergy, document titles, deletion reason, auth cookie or JWT (`log-grep.txt`); request log skips token URLs (`next.config.ts`) |
| NFR-3 env vars | PASS | `.env.example` + `lib/env.ts`: `GRIEVANCE_OFFICER_EMAIL`, `PRIVACY_NOTICE_REVIEWED`, `SUPABASE_REGION_LABEL`, `RETENTION_AUDIO_DAYS` (+ optional `RETENTION_*` overrides, dev-only `AUDIT_FAIL_ACTIONS`) |
| 375 px, translated, accessible | PASS | family privacy page en/te at 375 px without horizontal scroll, labelled radios/checkbox/textarea, no console errors, no external scripts (`ui.txt`, screenshots); all new strings in en/hi/te (`privacy` namespace, 175 keys), `messages/REVIEW.md` regenerated (1331 rows), `i18n-keys` test green |

## Deviations

- **Export job queue.** FR-7 names an outbox topic `privacy.export_requested` for the job. 032's outbox delivers
  notifications (topic -> recipients -> channels) and its internals are on the don't-touch list, so the durable queue is
  the `privacy_exports` row itself (lease, attempts), run by `after()` right after the request and by
  `/api/cron/privacy` every 5 minutes. The outbox is used for the notifications: `privacy.export_ready`,
  `privacy.deletion_requested` (admins), `privacy.deletion_completed`, `privacy.deletion_rejected` (in-app + email, no
  WhatsApp, no child name).
- **Strict actions implemented in SQL.** Consent (020), sharing (022), care team (022), documents (023) and claims (020)
  already write their audit row inside one security-definer function (same transaction, fail closed). They are listed
  in `strict-actions.ts` as `sql` implementations (the test checks the function body) rather than being rewritten to
  call `auditStrict` (their internals are on the don't-touch list). Their modules honour the `AUDIT_FAIL_ACTIONS` hook
  (`auditWouldFail` / `assertAuditWritable`), which is how E-2 is exercised for `consent.granted`; a real failing
  audit insert inside `record_consent` is also tested (DB trigger).
- **Pending document uploads after 1 h** (023 hand-off) instead of 24 h; session uploads after 24 h. Both are within
  FR-6 and overridable.
- **FR-9 withdrawn-consent audio** is deleted only for recordings at least 1 hour old whose child has a consent record
  for the feature that is no longer granted (never-granted legacy rows and in-flight uploads are left to the 020 gates
  and the 24 h rule).
- **`all_ai_processing`** (not specified in detail): withdraws the six AI features, deletes audio, transcripts, red
  flags, unconfirmed AI facts, draft reports, Ask-the-case answers and the ElevenLabs conversations; facts confirmed by
  the clinician and final reports stay (clinical record), as do the child, links, documents and health profile.
- **`everything`** deletes the child's cases in every organisation (the guardian's right is platform-wide); the child row
  stays pseudonymised because the retained consent log references it.
- **No-tracking crawl.** The rendered-page crawl needs a running app, so it runs when `NO_TRACKING_BASE_URL` is set
  (done for this ticket against the dev server, 17 pages); in a plain `npx vitest run` the allowlist/CSP and static
  module-graph checks run and the crawl is skipped. The CSP (019) still blocks any non-allowlisted script at runtime.
- **Allowlist routes.** The ElevenLabs/Razorpay entries are scoped to the routes 040/031 are expected to use
  (`/family/children/*/ask|follow-up`, `/family/appointments/**`); `FAMILY_CSP_EXCEPTIONS` stays empty until those
  tickets add their exception (the test requires it to be a subset of the allowlist).
- **Admin pages for other roles** answer 404 like the other `/admin/*` pages (guardians are redirected home by the
  proxy); the review API answers 403 (E-4.3).
- **Health check DB-down case** is shown with a mocked database (unit test), not by stopping the shared Docker stack.
- **ElevenLabs deletion API** is never called for real (no key): DEMO_MODE / missing key records `deleted 200` with
  `demo: true` in code paths; tests stub the deleter (success, 503 failure, retry).
- **Extra:** `provider.registered` (028, guardian -> provider role change) is now strict too; the rd lists "role
  changes" without naming it.

## Notes

- **For 026 / 027 (and M2/M3; 024 and 025 are registered, see the merge section):** register your data in `lib/privacy/registry.ts` (append to `REGISTRY` or
  `registerPrivacyCategory()`): `export()` returns only what the guardian can see (published versions, own threads),
  `erase.objects/externalRefs/rows` and `scopes`; see `docs/privacy/retention.md` ("how later tickets register").
  Published plans/assessments/messages appear in the export once those entries exist. Add your security-critical
  actions to `lib/audit/strict-actions.ts` (039: `rx.signed`) and use `auditStrict(event, tx)`.
- **Audit API:** `audit(event)` best effort; `auditStrict(event, tx?)` throws `AuditWriteError`; `auditFailure(err)`
  -> 503; `getAuditActor()` / `auditActorOf(user, role)` (never from the body); omit `actor` to use the session;
  `setTxAuditActor(tx, actor)` attributes raw SQL audit inserts in a transaction (used by facts/speakers). The legacy
  `actor` column now gets the role (`provider` / `guardian` / `platform_admin`) for session actors; SQL functions keep
  `therapist` / `parent` and get `actor_role` from the trigger.
- **Tests must not `delete from audit_events`** (append-only): use `tests/helpers/audit.ts` `purgeTestAudit()`; six
  existing cleanups were switched to it. `tests/intake-completion.test.ts` no longer expects a hard-coded `therapist`.
- **New helpers:** `lib/log.ts` (`redact`, `logger`, `errorMessage`), `lib/cron.ts` (`cronAuthorized`),
  `lib/elevenlabs/conversations.ts`, `lib/privacy/{registry,retention,export,deletion,jobs,ops,zip,recipients,third-party-allowlist}.ts`,
  `lib/audit/{strict-actions,query}.ts`, `lib/children/links.ts`, `components/privacy/*`, `components/admin/*`.
- **Hand-offs closed:** 017 (actor on every audit call, durable audit), 020 (consent-forms orphan sweep, scans kept with
  the consent log, ElevenLabs deletion on erasure), 023 (pending uploads 1 h, orphan sweep, objects before cascading
  deletes, export includes documents), 028 (credential orphan sweep), 029 (production host logs: documented in
  incident response / processors as outside the app; dev log skips token URLs).
- **028 `user_has_guardian_links()` fails open if `guardian_links` is missing:** with 020 merged the table always
  exists (checked by 020's tests); not changed here (existing migration), noted for ops.
- **`vercel.json`:** `/api/cron/privacy` every 5 min, `/api/cron/retention` daily 21:30 UTC (03:00 IST).
- **Shared files touched additively:** `lib/notify/{topics,recipients}.ts` + 4 templates, `tests/notify-templates.test.ts`
  (samples), `lib/auth-access.ts` (`/api/health` public), `lib/env.ts`, `.env.example`, `next.config.ts` (log ignore),
  `messages/*.json` (`privacy` namespace), `messages/REVIEW.md`, `docs/system-design.md`, `docs/notifications.md`,
  footer/login/consent components (privacy link), `lib/consent/records.ts`, `lib/sharing/grants.ts`,
  `lib/documents/store.ts`, `lib/children/index.ts`, `lib/cases/team.ts` (dev hook only), `lib/orgs.ts`,
  `lib/providers/index.ts` (strict audit), `lib/facts.ts`, `lib/speakers.ts` (actor).
- **Open questions for human owners (legal review, plan section 6):** every retention period (in particular raw audio 90
  days and the outpatient therapy record-keeping period that justifies rejecting erasure), the privacy notice text in
  en/hi/te (draft badge until `PRIVACY_NOTICE_REVIEWED=true`), the grievance officer (`GRIEVANCE_OFFICER_EMAIL`) and DPO,
  processor DPAs and regions (`SUPABASE_REGION_LABEL`; Mumbai region decision, risk 6), Gemini paid-tier no-retention
  terms (recorded as `not_applicable`), nomination procedure, Hindi/Telugu copy review (`messages/REVIEW.md`, notification
  templates).
- The acceptance data (`e041-*` accounts, synthetic children) was wiped by the final `db reset` before the last full
  test run; the slot 5 stack is left running.

## Merge with `main` (024 assessments / clinical contracts, 025 IEP, claim-code test fix)

- `git merge main`. Conflicts resolved keeping both sides: `app/api/reports/[id]/route.ts` (main's
  `actorUserId: gate.actor.user.id`, without the hard-coded `therapist`), `app/family/(portal)/children/[id]/page.tsx`
  (`Plan` and `Privacy and data` links), `lib/notify/recipients.ts` (`platformAdmins` + 024's
  `assignedAssessmentGuardian`), `messages/{en,hi,te}.json` (deep-merged, no value clashes), `messages/REVIEW.md`
  regenerated (`npx tsx scripts/i18n-review.ts`, 1610 rows). `lib/authz.ts`, `lib/notify/topics.ts`, templates, docs,
  `tests/notify-templates.test.ts`, `tests/outbox.test.ts` auto-merged; `vercel.json` and seed scripts had no conflict.
- **Registry:** `assessments` (export: questionnaires assigned to the requesting guardian with their answers - no score or
  reviewer note; erase with the cases), `published_versions` (export: latest guardian-visible version of each document;
  case-linked rows go with the case cascade allowed by 024's trigger), `iep_plans` (export: 025 `getGuardianPlans` -
  published wording, live values, no drafts or notes; erase plans -> goals, progress, publications). The privacy
  notice lists questionnaires and therapy plans (en/hi/te).
- **New migration `20261113004102_privacy_published_versions.sql`:** 024's append-only `published_versions` rows without a
  case could never be erased; `privacy_delete_published_versions(child)` (service role only) sets the transaction-local
  `dnm.privacy_maintenance` flag that the replaced `published_versions_append_only()` honours for deletes only. 024's
  other rules are unchanged; a direct delete still raises (tested).
- **Audit actors:** 024/025 wrote raw `audit_events` inserts with hard-coded `therapist` / `parent`. Their `auditTx`
  helpers now call `auditStrict(event, tx)` with the session user id from the routes (role from `user_profiles` by the
  audit trigger), still in the same transaction; `setTxAuditActor()` also sets 024's `app.actor_user_id`
  (`published_by`). No 024/025 test deleted audit rows (nothing to switch to `tests/helpers/audit.ts`).
- **No-tracking crawl** now also covers `/family/assessments`, `/family/assessments/[id]` (a synthetic questionnaire is
  created for the crawl guardian) and `/family/children/[id]/plan`: 20 pages, all scripts same-origin.
- After `dnm-db.sh 5 <worktree> reset` (19 migrations): `npm run lint` exit 0, `npm run typecheck` exit 0,
  `npx vitest run` 69 files, 1029 passed, 11 skipped (the opt-in `CT_DB_TESTS` block of 10 + the live crawl; every DB
  suite ran, incl. 024/025's), `npm run build` exit 0; the eval command 4 files, 56 passed, 1 skipped.
- Live re-check (dev server 3050, fresh `seed:users --prefix e041`): `acceptance.txt` 43/43 PASS - E-1 (attribution,
  case deletion), E-2 (hook on 503 / off 201), E-3 export now containing the questionnaire with answers, the published
  plan and published versions (hidden version absent), E-4 erasure removing assessments, IEP plans and published versions
  too, E-5. Dev log grep: no seeded identifiers (`log-grep-merge.txt`).
