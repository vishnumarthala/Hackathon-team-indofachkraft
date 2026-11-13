# Children, guardian links and consent gating (ticket 020)

Design rules 1, 2 and 6 of `specs/grill/doctornearme-mvp.md`. Read this before adding any feature that
records, sends or shares a child's data.

## Model

| Table | What |
|-------|------|
| `children` | The child, separate from org-specific `cases` (care episodes). `source`: `guardian` (added in the family app), `provider` (created with a new case), `legacy_case` (backfilled from pre-020 cases). Soft delete via `deleted_at` (merged placeholders). |
| `guardian_links` | Guardian user <-> child, `active`/`revoked`, `self_registered`/`claim_code`, with the declaration time. |
| `cases.child_id` | Not null. A trigger (`cases_assign_child`) gives every new case without a child an unclaimed `provider` child. Never matched to a guardian by contact details. |
| `consent_documents` | Versioned texts per feature and locale (`en`/`hi`/`te`) with `processors` (name, purpose, location). v1 is seeded by the migration; **draft copy, legal review pending**. |
| `consent_records` | Append-only log (trigger blocks update/delete/truncate for every role; no direct writes from `anon`/`authenticated`/`service_role`). `method` `digital` (guardian + link) or `paper` (attested by a provider, guardian name, relationship, signed date, scan path). |
| `child_consent_state` | View: latest record per (child, feature). `granted` is true for a paper grant, or a digital grant whose guardian link is still active. |
| `child_claim_codes` | One-time parent codes (sha256 only, 72 h, a new code expires older unused ones). `child_claim_attempts` rate-limits claims (5 failures per user per hour). |
| `cases.intake_token_expires_at` / `_revoked_at`, `referrals.expires_at` | Intake links live 7 days, referral links 30 days; both revocable. |
| storage bucket `consent-forms` | Private; signed paper forms. Read only through `GET /api/cases/:id/paper-consents/:recordId/scan` (60 s signed URL, members of the case's org). |

All multi-step writes are `security definer` functions called with the service role, each one
transaction: `record_consent(jsonb)` (consent rows + FR-9 side effects + audit, strict: an audit failure
rolls everything back -> API 503), `create_guardian_child`, `create_child_claim_code`, `claim_child`,
`backfill_case_children` (idempotent).

## Gating a feature

Feature keys live in `lib/consent/features.ts` (`CONSENT_FEATURES`, `FEATURE_GATES`). Server helpers in
`lib/consent/index.ts`:

- **Collection time** (the request that starts the work): `requireCaseConsent(caseId, feature)` or
  `requireConsent(childId, feature)` right after the access gate. Returns `null` or the 422
  `{ error: "Guardian consent required", details: { feature, child_id } }` (503 if consent could not be
  checked).
- **Queued / async work** (webhooks, processors, anything that runs later): call
  `assertConsentOrAbort(childId, feature, { stage, caseId, recordingId?, markRecordingFailed?, audioPath? })`
  **immediately before** data leaves for an external processor. On `false`: do not call the processor and
  return. It has already marked the recording `failed` / `consent_withdrawn` (when asked), deleted the
  unprocessed audio (when given) and audited `consent.blocked_processing`.
- Both fail closed: any error counts as "no consent". Never trust a client flag (the old
  `parent_consent: true` body field is ignored).

Current gates (FR-7):

| Feature | Collect | Re-check |
|---|---|---|
| `ai_intake_call` | `POST /api/cases/:id/intake-link`, `POST /api/intake/:token/start` | `/complete`, `/api/dev/simulate-intake`, webhook processing and before brief generation (`lib/intake/process.ts`) |
| `session_recording` | `POST /api/cases/:id/sessions` | upload completion: first transcription of a `created` recording |
| `ai_transcription` | `POST /api/sessions/:id/transcribe` | right before the Scribe request |
| `ai_extraction` | `POST /api/sessions/:id/extract`, `POST /api/sessions/:id/report` | before each Gemini call (`runExtraction`, report route) |
| `ai_voice_note` | `POST /api/reports/:id/parent-voice-note` | before TTS |
| `referral_share` | `POST /api/cases/:id/refer` | every `/specialist/<token>` load and `POST /api/cases/:id/ask` (410 when unavailable) |
| `screen_result_save` | ticket 033 must call `requireConsent` before saving a screen result to a child | - |
| `ai_follow_up` | ticket 040 must call `requireConsent` before the agent starts | `assertConsentOrAbort` before each question |

Withdrawing `ai_intake_call` revokes the child's open intake links; withdrawing `referral_share` revokes
the child's referrals (FR-9, inside `record_consent`). Processed records are not deleted (ticket 041).

Client components show the 422 text with the hint `Ask the parent to allow this in their DoctorNearMe
app.` via `withConsentHint()` (`lib/consent/features.ts`, safe in the browser).

## Access (rule 2)

- Guardians: `requireGuardian()` first (static scan in `tests/guardian-authz.test.ts`), then
  `requireChildGuardian(childId, session)` (active link to a live child, else 404). Pages:
  `requireChildGuardianPage(childId)`.
- Providers: only through a case of their own org: `requireCaseAccess` / `requireCaseActor` (017), and
  `requireChildAccessViaCase(childId, caseId)` when a child id comes from the client. Two orgs with cases for
  the same child never see each other's case data unless a guardian shares records (ticket 022,
  `docs/sharing.md`). Since 022 a plain org member needs an assignment to the case.
- Providers can never give consent digitally (`/api/family/**` -> 403). They record **paper** consent.
- Platform admins revoke a guardian link with `POST /api/admin/guardian-links/:id/revoke`.
- Ticket 028's provider self-registration refuses accounts with an active guardian link
  (`user_has_guardian_links()` reads `guardian_links.user_id/status`; this migration runs first).

## Guardian flows

`/family/children` (list, `Add a child`, `I have a code from my therapist`), `/family/children/new`,
`/family/children/claim` (asks `Is this one of your children?` when the guardian already has children:
choosing one re-points the case to that child and soft-deletes the placeholder, only if it has no other
cases, guardian links or consent records -> else 409), `/family/children/[id]` (Permissions: description,
status, processors, full text, `Allow` / `Withdraw`; paper consents show `Given on paper on <date>` and can
be withdrawn digitally). Granting needs `user_profiles.phone_verified_at` (OTP-verified phone) and the
current text version (else 409 `Please review the updated text`).

## Paper consent (FR-18a-e)

For parents without a smartphone. Case workspace `Consent` panel -> `Print consent form`
(`/cases/:id/consent-form?locale=en|hi|te`, every current text with processors, tick boxes, signature lines
and the document ids; printing is not consent) -> `Record paper consent` (`/cases/:id/consent/paper`):
ticked features, guardian name, relationship, signed date (not in the future, Asia/Kolkata), scan
(PDF/JPEG/PNG <= 10 MB, checked by magic bytes) and the attestation `I confirm the parent or legal guardian
signed this form in person.` Works for legacy cases. Withdrawals on paper need no scan.

## Demo and tests

- `npm run -s seed:demo [-- --new]` gives synthetic demo cases a synthetic guardian
  (`demo-guardian@example.com`), an active link and v1 consent for every feature (`user_agent =
  'seed:synthetic'`). `--no-guardian` leaves the child unclaimed (every gate blocks).
- Tests: `tests/consent-*.test.ts`, `tests/children-claims.test.ts`, `tests/legacy-backfill.test.ts`.
  Route unit tests that mock the database mock `@/lib/consent` with `tests/helpers/consent.ts`
  (`consentAllowedModule()`); DB suites grant synthetic consent with `grantSyntheticConsent()` and clean up
  with `purgeSyntheticChildren()` (local test databases only).
- `npm run db:check` reports `cases without child_id` (expected 0).
