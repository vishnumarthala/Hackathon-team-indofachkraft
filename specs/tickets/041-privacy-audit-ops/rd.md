# 041: Privacy, audit and operations baseline

**Status:** draft
**Mode:** solo
**Runs:** waits for 023, 032: deletion/export must cover documents (023); export delivery and incident/ops alerts use the outbox (032)

## Summary

The pilot handles real children's health data under India's DPDP Act. This ticket (rule 7) makes the
audit log trustworthy (authenticated actor, survives case deletion, append-only, fails closed for
security-critical writes), adds data retention jobs, guardian data export, deletion requests that also
reach external processors, a published privacy notice, an incident-response procedure, and basic
operational health checks. Later tickets register their data in the same retention/deletion registry.

## Functional requirements

### Audit

- **FR-1** - Migration `<ts>_audit_hardening.sql` (expand -> backfill -> enforce):
  `audit_events` (017 already added `actor_user_id`) gains `actor_role text null` (`platform_admin | provider |
  guardian | system | ai | anonymous`), `org_id uuid null`, `child_id uuid null`, `case_ref uuid null`
  (copy of `case_id`), `request_id text null`, `ip_hash text null`. Backfill `case_ref = case_id`.
  Replace the `case_id` FK `on delete cascade` with **no FK** (drop constraint; keep column + index) so
  audit rows survive case deletion. Extend the `actor` check to include `provider`, `guardian`,
  `platform_admin`, `anonymous` (old values kept for history). Revoke `update`, `delete`, `truncate` on
  `audit_events` from `anon`, `authenticated`, `service_role`; trigger raises on update/delete.
- **FR-2** - `lib/audit.ts` keeps `audit()` (best-effort, never throws) for low-risk events and adds
  `auditStrict(event, tx?)` which throws `AuditWriteError` when the insert fails; the actor is derived
  server-side from the session (`getAuditActor()` -> `{ actor_user_id, actor_role }`), never from the
  request body. Security-critical actions use `auditStrict` inside the same transaction as the change,
  and the route returns 503 `{ error: "Could not save. Please try again." }` on failure: consent
  grant/withdraw (020), sharing grant/revoke (022), document download/delete (023), role or org
  membership changes and invitations (017), guardian link changes (020), export and deletion (this
  ticket), Rx signing (039 later). `lib/audit/strict-actions.ts` lists them; a test asserts each listed
  route uses `auditStrict`.
- **FR-3** - All existing `audit()` call sites pass the authenticated actor (replace hard-coded
  `actor: "therapist"` with the session-derived actor; keep `parent`/`ai`/`system` where the actor is
  not a signed-in user).
- **FR-4** - `/admin/audit` (platform admin): filters `Action`, `Actor`, `Organisation`, `Child`,
  `Case`, date range; paginated table (time, actor role, actor id short, action, entity, ids); no
  `details` values for health/consent content beyond what is stored. Viewing the audit log is itself
  audited (`audit.viewed`).

### Retention, export, deletion

- **FR-5** - `lib/privacy/registry.ts`: each data category registers `{ key, table/bucket, owner
  (child|case|user), retention, exporter, deleter, processors[] }`. Initial entries: case records
  (recordings rows, facts, reports, referrals, case_questions), audio objects (`recordings` bucket),
  documents (023), messages (027 if merged), health profile (021), IEP/home program (025/026),
  consent records (kept, see FR-8), notifications (032), pilot sign-ups.
- **FR-6** - Retention defaults (`lib/privacy/retention.ts`, overridable by env, documented in the privacy
  notice): raw session/intake **audio** deleted 90 days after successful transcription (transcript and
  facts kept); `pending` uploads (documents, recordings) older than 24 h deleted; in-app notifications
  older than 180 days deleted; email/WhatsApp delivery rows older than 90 days stripped of title/body;
  `pilot_signups` older than 24 months deleted; audit events kept 7 years. Job `POST /api/cron/retention`
  (`CRON_SECRET`), daily; each run writes one `retention.run` audit with counts per category.
- **FR-7** - Guardian export: `/family/children/[id]/privacy` -> `Download <child>'s data`.
  `POST /api/family/children/:id/exports` -> 202 `{ export_id }` (max 1 running per child, 3 per day ->
  429). A job (outbox topic `privacy.export_requested`) builds a ZIP in private bucket `exports`
  (`child.json` with child, guardian links, consents, health profile, published versions, assessments,
  goals/progress, home program + logs, messages the guardian can see, documents metadata; `documents/`
  folder with files the guardian can access), notifies the guardian; `GET /api/family/exports/:id/download`
  -> 302 signed URL (10 min); exports deleted after 7 days. Only content the requesting guardian can
  already see is included.
- **FR-8** - Deletion requests: guardian `POST /api/family/children/:id/deletion-requests` `{ scope:
  "all_ai_processing" | "everything", reason? }` -> 201; table `deletion_requests(id, child_id,
  requested_by, scope, status text check in ('requested','approved','rejected','in_progress','completed',
  'failed'), reviewed_by, review_note, completed_at, created_at)`. Platform admin reviews at
  `/admin/privacy/requests` (`Approve` / `Reject` with note - rejection for legally required clinical
  record retention must cite it). Execution job: for each registry entry deletes rows/objects (or
  pseudonymises: `children.display_name -> 'Deleted child'`), withdraws all consents (append records),
  revokes tokens, and calls processor deletions: ElevenLabs `DELETE /v1/convai/conversations/{id}` for
  every `recordings.external_id`; records `processor_deletions(request_id, processor, external_ref,
  status, response_code, attempted_at)`. Consent records and audit events are retained (legal
  obligation) but stripped of free text. Guardian notified on completion.
- **FR-9** - Withdrawal hook: when consent for an AI feature is withdrawn (020), queued work is already
  blocked; this ticket adds the daily job step that deletes audio not yet processed for children whose
  `session_recording`/`ai_intake_call` consent is withdrawn.

### Notice, incident, ops

- **FR-10** - Public `/privacy` page (translated, `Draft - pending legal review` badge until a human
  removes it via env `PRIVACY_NOTICE_REVIEWED=true`): data controller, what is collected per feature,
  purposes, processors and locations (ElevenLabs - USA, Google Gemini - outside India, Resend - USA,
  Meta WhatsApp, Supabase - region from env `SUPABASE_REGION_LABEL`), retention table from FR-6, rights
  (access, correction, erasure, grievance, nominate), grievance officer contact from env
  `GRIEVANCE_OFFICER_EMAIL`, children's data statement (verifiable guardian consent, no tracking or
  targeted ads). Linked from the footer, login pages and every consent dialog.
- **FR-11** - `docs/privacy/incident-response.md`: detection sources, severity levels, roles, the
  72-hour reporting timeline to the Data Protection Board and affected guardians under DPDP Rules,
  containment steps (rotate keys, revoke tokens, disable agents), evidence preservation, communication
  templates; `docs/privacy/processors.md` (processor list, data sent, region, deletion API, contract
  status); `docs/privacy/retention.md` (FR-6 table).
- **FR-12** - Ops: `GET /api/health` (public) -> 200 `{ ok: true, db: "ok", version }` (no secrets;
  503 if DB unreachable); `/admin/ops` shows outbox backlog/dead counts (032), last retention run,
  failed processor deletions, recordings stuck in `transcribing`/`extracting` > 30 min.
- **FR-13** - Child pages tracking check: a test crawls rendered `/family/**` routes and fails if any
  `<script src>` points outside the app origin or known exceptions declared in
  `lib/privacy/third-party-allowlist.ts` (empty in this ticket).

## Non-functional requirements

- **NFR-1** - Deletion and export jobs are idempotent and resumable (re-running a completed step is a no-op).
- **NFR-2** - No personal data in server logs: a log helper redacts emails, phones (keeps last 4) and
  tokens; a test greps app log output from the eval run for seeded identifiers.
- **NFR-3** - Env vars documented in `.env.example`: `GRIEVANCE_OFFICER_EMAIL`, `PRIVACY_NOTICE_REVIEWED`,
  `SUPABASE_REGION_LABEL`, `RETENTION_AUDIO_DAYS` (default 90).

## Affected areas

- `supabase/migrations/<ts>_audit_hardening.sql`, `<ts>_privacy.sql` (new; `exports` bucket, `deletion_requests`, `processor_deletions`)
- `lib/audit.ts`, `lib/audit/**` (new), all existing `audit()` call sites (actor only)
- `lib/privacy/**` (new), `lib/elevenlabs/conversations.ts` (new: delete API), `lib/log.ts` (new)
- `app/api/cron/retention/route.ts`, `app/api/family/children/[id]/{exports,deletion-requests}/**`,
  `app/api/family/exports/[id]/download/route.ts`, `app/api/admin/privacy/**`, `app/api/health/route.ts` (new)
- `app/privacy/page.tsx`, `app/family/children/[id]/privacy/**`, `app/admin/{audit,privacy,ops}/**` (new)
- `docs/privacy/*.md` (new), `.env.example`, `vercel.json` (cron), `messages/*.json`
- `tests/audit-hardening.test.ts`, `tests/privacy-retention.test.ts`, `tests/privacy-export-deletion.test.ts`, `tests/no-tracking.test.ts` (new)

## Don't touch

- Consent semantics (020), sharing (022) and outbox internals (032) - use their APIs; existing
  migrations; `BOARD.md`

## Out of scope

- Data residency migration to an Indian region (risk 6 - human decision), DPO appointment, SIEM,
  automated breach detection, consent manager (DPDP "Consent Manager") integration, backups policy
  (Supabase managed).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Ticket placement | M1 baseline, not M3 | rule 7 "041 -> M1" |
| D-2 | Audit survives deletion | Drop cascade FK, keep `case_ref` | rule 7 |
| D-3 | Fail closed | `auditStrict` in-transaction for listed actions | rule 7 |
| D-4 | Deletion of external copies | ElevenLabs conversation delete + processor log | rule 7 "incl. external processors" |
| D-5 | Clinical record retention vs erasure | Admin review step; reject only with cited obligation | Indian clinical record retention rules vs DPDP erasure |
| D-6 | No tracking on child pages | Automated check | plan §2 "Child consent" |

## Open questions

- Legal review of retention periods, the privacy notice and the clinical-record retention period for
  outpatient therapy records (human task, plan §6).
- Gemini API data handling: confirm paid-tier no-training/no-retention terms for the pilot project; no
  deletion API exists, so `processor_deletions` records `not_applicable` for Gemini.
- M2/M3 data (appointments, payments, Meet events, ratings, prescriptions, screen sessions) must
  register in `lib/privacy/registry.ts` in their own tickets.
