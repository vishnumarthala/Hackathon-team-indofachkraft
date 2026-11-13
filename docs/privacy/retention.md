# Data retention, export and deletion (ticket 041)

Status: **draft - pending legal review** (the same periods are shown on `/privacy`). Periods are defaults in
`lib/privacy/retention.ts` and can be overridden by env (`.env.example`). The privacy notice always shows the values in
effect.

## Retention table (FR-6)

| Data | Rule | Job step (`retention.run` count key) | Env override |
|------|------|--------------------------------------|--------------|
| Raw session / intake audio (`recordings` bucket) | Deleted **90 days after successful transcription** (`recordings.transcribed_at`). The transcript, facts and reports stay. Row keeps `audio_deleted_at`, `storage_path = null` | `audio_after_transcription` | `RETENTION_AUDIO_DAYS` (90) |
| Audio of a child whose `session_recording` / `ai_intake_call` consent was withdrawn, not yet processed (`created`/`failed`, never transcribed, older than 1 h) | Deleted by the next daily run (020's queued-work re-check already blocks processing) | `withdrawn_consent_audio` | - |
| Unfinished session uploads (`recordings.status = created`) | Row and object deleted after 24 h | `pending_recordings` | `RETENTION_PENDING_UPLOAD_HOURS` (24) |
| Unfinished document uploads (`documents.status = pending`) | Row and object deleted after **1 h** (023 hand-off; within FR-6's 24 h) | `pending_documents` | `RETENTION_PENDING_DOCUMENT_HOURS` (1) |
| Storage objects no live row points at (`documents`, `recordings`, `consent-forms`, `credentials`, `exports`) | Deleted after 24 h (an upload token is valid for 2 h, so an object can appear after its row was removed or rejected) | `orphan_*` | `RETENTION_ORPHAN_OBJECT_HOURS` (24, min 3) |
| Guardian data exports (`exports` bucket) | Deleted 7 days after they are ready (`status = expired`) | `expired_exports` | `RETENTION_EXPORT_DAYS` (7) |
| In-app notifications | Deleted after 180 days | `in_app_notifications` | `RETENTION_IN_APP_NOTIFICATION_DAYS` (180) |
| Email / WhatsApp delivery rows | `title` / `body` stripped after 90 days (date, status, channel stay) | `delivery_content` | `RETENTION_DELIVERY_CONTENT_DAYS` (90) |
| Public developmental check-ins not saved to a child (`screen_sessions`, 033) | Deleted **30 days** after they started; check-ins saved to a child (consent `screen_result_save`) stay with the child until erasure | `unsaved_screen_sessions` | - |
| Website pilot sign-ups (`pilot_signups`) | Deleted after 24 months | `pilot_signups` | `RETENTION_PILOT_SIGNUP_MONTHS` (24) |
| Audit events | Kept **7 years**, then deleted by `audit_purge_expired()` (refuses anything younger than 1 year) | `audit_events` | `RETENTION_AUDIT_YEARS` (7) |
| Consent records (020) and signed paper forms | Kept (legal proof of consent), also after erasure, with free text stripped | - | - |
| Appointments (030: `appointments`, `appointment_events`) | Kept as the provider's appointment record (period pending legal review). Erasure (`everything`): future appointments cancelled (provider notified), the child removed from every appointment (`booking_erase_child`) | - | - |
| Payments (031: `payments`, `payment_events`) | Kept as a financial record (period pending legal review; Indian accounting rules usually require 8 years), also after erasure (`retainedOnErasure`). Amounts, statuses and Razorpay ids only; no child data, no card/UPI details (webhook payloads allowlisted). Export: the requesting guardian's payments for the child's appointments | - | - |
| Messages with the care team (027: `message_threads`, `messages`, `thread_reads`) | Kept with the clinical record of the case; a deleted message's text is overwritten at once; removed with the child's threads (every organisation) and their outbox events on erasure | - | - |
| Clinical records (cases, transcripts, confirmed facts, final reports) | Kept while the child is in care and as long as the law requires the clinic to keep them; erasure is reviewed (D-5) | - | - |

Job: `GET|POST /api/cron/retention` with `Authorization: Bearer <CRON_SECRET>`, daily at 21:30 UTC (03:00 IST,
`vercel.json`). Every step is idempotent (a second run finds nothing) and removes storage objects before rows. Each run
writes one `retention.run` audit row (`details.counts`, `details.policy`); `/admin/ops` shows the last run.

Open (human): legal review of every period, in particular the outpatient therapy record-keeping period (state clinical
establishment rules), and whether 90 days of raw audio is needed at all.

## Privacy registry (FR-5) - how later tickets register their data

`lib/privacy/registry.ts` lists every category of personal data once:
`{ key, label, owner: child|case|user, tables, buckets?, retention, retentionEnv?, processors, retainedOnErasure?, export?, erase? }`.
The privacy notice, the export, the erasure job and this document are driven by it.

Registered so far: child profile, case records, session audio, intake conversations, 024 `assessments` (guardian's own
questionnaires + answers) and `published_versions` (latest guardian-visible versions), 025 `iep_plans` (published plan
views; drafts and progress notes never exported), 026 `home_programs` (the current published programs plus the requesting
guardian's own practice logs; drafts and other guardians' notes never exported; logs deleted on erasure), 027 `messages` (the conversations this guardian can open, with the text they see and
their own read markers; attachments as document ids), 038 `ai_scribe` (session-note/Rx drafts and goal-progress
suggestions; shared notes are exported through `published_versions`), documents, health profile, consent records, sharing/care team,
notifications, exports, audit, provider credentials, pilot sign-ups, 030 `appointments` (export: the requesting
guardian's own bookings of the child; erase: `booking_erase_child`), 037 `google_meet` (providers' Google connections,
Meet links and calendar event ids; export: the Meet links of the guardian's own video bookings; erasure: the cancelled
appointments' `meet.delete` jobs remove the calendar events, links carry no child data). `published_versions` is append-only (024): rows with a
case go with the case; case-less rows are removed only by `privacy_delete_published_versions()` (migration
`20261113004102`).

To add a category (026 home program, M2/M3 appointments, payments, Meet events, ratings, prescriptions,
screen sessions):

1. Append an entry to `REGISTRY` (or call `registerPrivacyCategory()` from your module at load time).
2. `export({ sql, childId, guardianUserId })` returns `{ data, files? }` with **only what this guardian can already see
   in the portal** (published versions, their own threads...). `files` are `{ path: "folder/name", bucket, objectPath }`
   and are added to the ZIP.
3. `erase.scopes`: `everything` always; add `all_ai_processing` when the data is AI-derived or was sent to an AI
   processor. `erase.objects()` returns storage paths (removed before any row). `erase.externalRefs()` returns
   processor copies (`{ processor, ref }`; only `elevenlabs` has a deletion API today). `erase.rows(tx, ctx)` runs
   inside the erasure transaction **before** the child's cases are deleted: delete rows that do not cascade from
   `cases` / `children`, or that must go in `all_ai_processing`.
4. If the data needs a scheduled rule, add a step to `runRetention()` (idempotent, objects first, add a count key) and a
   row to the table above and to the notice (`privacy.notice.retention.*` in `messages/*.json`).

## Guardian export (FR-7)

`/family/children/:id/privacy` -> `Download <child>'s data` -> `POST /api/family/children/:id/exports` -> 202
`{ export_id }` (one queued/building export per child and 3 per child per 24 h, else 429). The job (`buildExport`,
lease-based, 3 attempts) writes `child.json` (`format: doctornearme-child-export/v1`, one section per registry key) and
`documents/<id>-<file name>` into a ZIP in the private `exports` bucket, then marks it `ready` and enqueues
`privacy.export_ready` (in-app + email to the requester) in one transaction. `GET /api/family/exports/:id/download`
-> 302 to a 10-minute signed URL, only for the requesting guardian while still linked (everyone else 404); every
download is audited (strict). Exports expire after 7 days.

Jobs run right after the request (`after()`) and every 5 minutes (`/api/cron/privacy`, `CRON_SECRET`).

## Deletion requests (FR-8)

Guardian: `POST /api/family/children/:id/deletion-requests` `{ scope: "all_ai_processing" | "everything", reason? }`
-> 201 (one open request per child, else 409). Platform admins get `privacy.deletion_requested` and review at
`/admin/privacy/requests` (`POST /api/admin/privacy/requests/:id` `{ decision, note? }`; a rejection needs a note of at
least 10 characters citing the record-keeping obligation; non-admins 403). Approval starts the job:

1. **processors** - every external copy is logged in `processor_deletions` (`pending` -> `deleted` / `not_found` /
   `failed`, response code, attempts). ElevenLabs conversations: `DELETE /v1/convai/conversations/{id}` per
   `recordings.external_id` (DEMO_MODE / no key: recorded as deleted, nothing leaves the app). Gemini has no deletion
   API: one `not_applicable` row. Failures are retried by later runs (up to 10 attempts per ref, 20 runs per request);
   each ref is deleted at most once.
2. **storage** - objects of every category in scope (audio, documents, exports).
3. **database** (one transaction) - consent withdrawals appended for every granted feature (on behalf of the requesting
   guardian; AI features only for `all_ai_processing`), intake links and referral links revoked, registry `rows()`
   deleters; for `everything` also: claim codes expired, every case of the child in every organisation deleted (rows
   cascade), guardian links revoked, the child pseudonymised (`Deleted child`, no date of birth or sex), consent records
   and audit rows stripped of free text (`privacy_redact_consent_records`, `audit_redact_child`), audit
   `privacy.deletion_executed`.
4. **complete** once no processor deletion is pending: `privacy.deletion_completed` (audit) and notification to the
   guardian. A request with processor failures stays `failed` (shown on `/admin/ops`) and is retried.

Each step is recorded in `deletion_requests.steps`; a re-run skips finished steps and a completed request is never
claimed again (NFR-1).

`all_ai_processing` deletes: audio objects, transcripts (`segments`), red flags, AI-suggested (unconfirmed) facts, draft
reports, Ask-the-case answers and the ElevenLabs conversations. Facts confirmed by the clinician and final reports stay
(clinical record). The child, links, documents and health profile stay.

## Audit log maintenance

`audit_events` is append-only for every role (grants revoked, trigger raises - also for the table owner). The only
paths that change rows are `audit_purge_expired(before)` (7-year retention) and `audit_redact_child(child, cases)`
(erasure), which set the transaction-local flag `dnm.audit_maintenance`. Truncate is never allowed. Test suites clean
their synthetic audit rows with `tests/helpers/audit.ts` (`purgeTestAudit`).
