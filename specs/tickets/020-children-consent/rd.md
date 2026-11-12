# 020: Children, guardian links and consent gating

**Status:** draft
**Mode:** solo
**Runs:** waits for 019: needs guardian accounts, `requireGuardian()` and verified phones

## Summary

Introduces the child as a first-class record separate from org-specific cases (care episodes), links
guardians to children, and makes **verifiable, versioned, per-child, per-feature guardian consent** a
hard gate for every AI/recording/sharing step - checked when data is collected **and** re-checked when
queued work runs. Legacy cases get unclaimed child records (never inferring a guardian or fabricating
consent). Intake and referral links become expiring, scoped and revocable. This ticket implements
design rules 1, 2 and 6.

## Functional requirements

### Data model (migration `<ts>_children_consent.sql`, expand -> backfill -> enforce)

- **FR-1** - `children`: `id uuid pk`, `display_name text not null (1-60)`, `date_of_birth date null`,
  `sex text null check in ('female','male','other','undisclosed')`, `source text not null check in
  ('guardian','provider','legacy_case')`, `created_by uuid null references auth.users`, `created_at`,
  `deleted_at timestamptz null`. RLS enabled.
- **FR-2** - `guardian_links`: `id`, `child_id -> children on delete cascade`, `user_id -> auth.users`,
  `relationship text check in ('mother','father','legal_guardian','other_family')`, `status text check in
  ('active','revoked')`, `verification_method text check in ('self_registered','claim_code')`,
  `declared_at timestamptz not null` (the "I am the parent or legal guardian" declaration),
  `revoked_at`, `revoked_by`; `unique (child_id, user_id)`.
- **FR-3** - `cases.child_id uuid null references children(id)`. Backfill: for every existing case
  without `child_id`, insert a `children` row (`source = 'legacy_case'`, `display_name = child_alias`,
  no DOB) and set `cases.child_id`. **No** `guardian_links` and **no** consent rows are created; parent
  email/phone are never used to match users. Then `alter column child_id set not null`. Case IDs and all
  dependants (recordings, facts, reports, referrals, audit) are untouched.
- **FR-4** - `consent_documents`: `id`, `feature` (FR-7 keys), `version int`, `locale ('en','hi','te')`,
  `title`, `body_md`, `processors jsonb` (e.g. `[{ "name": "ElevenLabs", "purpose": "voice call and
  transcription", "location": "USA" }, { "name": "Google Gemini", "purpose": "AI analysis",
  "location": "outside India" }]`), `published_at`; `unique (feature, version, locale)`. Seeded with v1
  for every feature in all three locales (copy flagged for legal review, plan §6).
- **FR-5** - `consent_records` (append-only log): `id`, `child_id`, `feature`, `action ('granted','withdrawn')`,
  `consent_document_id` (exact version + locale shown), `guardian_user_id`, `guardian_link_id`,
  `ip_hash` (sha256 of IP + server salt), `user_agent` (<= 200 chars), `created_at`. `update`/`delete`
  revoked from all roles; a trigger raises on update/delete. Current state =
  latest record per `(child_id, feature)`; view `child_consent_state`.
- **FR-6** - Intake links: `cases.intake_token_expires_at timestamptz`, `cases.intake_token_revoked_at`;
  referrals: `referrals.expires_at` (default `created_at + 30 days`). Existing tokens get
  `expires_at = now() + 7 days` (intake) / `now() + 30 days` (referrals) at migration time.

### Consent features and gating

- **FR-7** - Feature keys (`lib/consent/features.ts`) and the gated steps:

  | Key | Gates (collect) | Re-checked when queued work runs |
  |---|---|---|
  | `ai_intake_call` | create/send intake link, `/api/intake/:token/start` | `/api/intake/:token/complete`, ElevenLabs webhook processing, brief generation |
  | `session_recording` | `POST /api/cases/:id/sessions` (upload URL) | upload completion |
  | `ai_transcription` | `POST /api/sessions/:id/transcribe` | before the Scribe request is sent |
  | `ai_extraction` | `POST /api/sessions/:id/extract`, report drafting | before each Gemini request |
  | `ai_voice_note` | `POST /api/reports/:id/parent-voice-note` | before TTS request |
  | `referral_share` | `POST /api/cases/:id/refer` (replaces the bare `parent_consent: true`) | `/specialist/<token>` page load and `/api/cases/:id/ask` |
  | `screen_result_save` | saving a public screen result to a child (033) | - |
  | `ai_follow_up` | follow-up agent (040) | each question |

- **FR-8** - `lib/consent/index.ts`: `getConsentState(childId)`, `hasConsent(childId, feature)`,
  `requireConsent(childId, feature): Promise<Response | null>` -> 422
  `{ error: "Guardian consent required", details: { feature, child_id } }`. Queued/async processors call
  `assertConsentOrAbort(childId, feature, context)` which marks the job/recording `failed` with
  `error = 'consent_withdrawn'`, deletes any temporary audio not yet processed, audits
  `consent.blocked_processing`, and never sends data to the external processor.
- **FR-9** - Withdrawing `ai_intake_call` revokes the child's open intake tokens (`intake_token_revoked_at = now()`);
  withdrawing `referral_share` sets the child's referrals to `revoked`. Withdrawal does not delete
  already-processed records (deletion requests are 041).
- **FR-10** - Token pages: expired/revoked intake token -> page `This link has expired. Please ask your
  therapist for a new link.` and API 410 `{ error: "This link has expired" }`; same for referral links
  (`This shared case is no longer available.`). `DELETE /api/cases/:id/intake-link` -> 200 `{ revoked: true }`
  (audit `intake.link_revoked`). Re-creating after revoke issues a new token.

### Guardian flows (all under `requireGuardian`, translated)

- **FR-11** - `/family/children`: list of linked children (name, age in years+months) and buttons
  `Add a child` and `I have a code from my therapist`.
  `POST /api/family/children` `{ display_name, date_of_birth?, sex?, relationship, declaration: true }`
  -> 201 `{ child }`, creates child (`source = 'guardian'`) + active link (`self_registered`).
  `declaration` text: `I am this child's parent or legal guardian.` Missing -> 400.
- **FR-12** - Claim codes: provider calls `POST /api/cases/:id/claim-code` (requires 017
  `requireCaseAccess`) -> 201 `{ code, expires_at, whatsapp_url }`; code = 8 characters
  from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` formatted `XXXX-XXXX`, stored as sha256 in
  `child_claim_codes(id, child_id, case_id, code_hash, expires_at (72 h), used_at, used_by, created_by)`;
  a new code invalidates older unused ones for that case. Guardian `POST /api/family/claims`
  `{ code, relationship, declaration: true }` -> 201 `{ child }`; invalid/expired/used -> 404
  `{ error: "This code is not valid" }` (same message for all, no enumeration), 5 failed attempts per
  user per hour -> 429. Audit `child.claimed`. The case workspace shows `Parent account linked` once claimed.
  If the guardian already has linked children, the claim page asks `Is this one of your children?`
  (radio list + `No, add as a new child`); choosing an existing child (`existing_child_id` in the body)
  re-points `cases.child_id` to it and soft-deletes the unclaimed placeholder child, only when that
  placeholder has no other cases and no guardian links (else 409 `{ error: "This record is already linked" }`).
- **FR-13** - `/family/children/[id]` overview (requires active link, else 404): name, age, and a
  `Permissions` section listing each feature with a plain-language description, status `Allowed` /
  `Not allowed`, the processors and locations, a `Read full text` disclosure, and buttons `Allow` /
  `Withdraw`. `POST /api/family/children/:id/consents` `{ feature, consent_document_id, agree: true }`
  -> 201 `{ state }`; `POST /api/family/children/:id/consents/:feature/withdraw` -> 200 `{ state }`.
  Granting requires `user_profiles.phone_verified_at` not null (verifiable guardian): otherwise 422
  `{ error: "Verify your mobile number before giving permission" }` with a link to settings.
  Granting an outdated document version -> 409 `{ error: "Please review the updated text" }`.
  Audit `consent.granted` / `consent.withdrawn` (strict, see FR-17).
- **FR-14** - Provider view: the case workspace shows a `Consent` panel (read-only): child linked or
  `No parent account linked yet` + `Create parent code`, and per-feature status with date. Blocked
  actions show the FR-8 error text and the hint `Ask the parent to allow this in their DoctorNearMe app.`

### Access rules (rule 2)

- **FR-15** - `lib/authz.ts` adds `requireChildGuardian(childId)` (active link) and
  `requireChildAccessViaCase(childId, caseId)`. A provider sees a child's data only through a case of
  their own org that they can access (017 `requireCaseAccess`); having cases for the same child in two
  orgs never exposes one org's case data to the other (cross-org sharing is 022).
- **FR-16** - Revoking a guardian link (`POST /api/family/children/:id/leave`, or platform admin) takes
  effect on the next request: tests assert 404 for the revoked user immediately after.
- **FR-17** - Consent writes use the strict audit path (fails closed): if the `consent_records` insert or
  its audit insert fails, the API returns 503 `{ error: "Could not save. Please try again." }` and no
  state changes (single DB function `record_consent(...)` doing both inserts in one transaction).

### Paper consent recorded by the centre (product decision 2026-11-12)

For parents without a smartphone, the centre records consent given on paper. Both methods count the same
for every gate in FR-7, and both are logged in `consent_records`.

- **FR-18a** - `consent_records` gains `method text not null default 'digital' check in ('digital',
  'paper')`, and for paper rows `attested_by uuid` (the provider), `paper_guardian_name text (1-100)`,
  `paper_relationship` (FR-2 values), `paper_signed_on date`, `paper_form_path text` (private bucket
  `consent-forms`, admin/provider signed URLs only). Check constraint: `digital` rows need
  `guardian_user_id` + `guardian_link_id`; `paper` rows need `attested_by`, guardian name, relationship,
  signed date (not in the future) and the form path, and have null guardian ids.
- **FR-18b** - Printable form `/cases/[id]/consent-form?locale=en|hi|te` (case access): child name, centre
  name, every feature's current consent document text and processors with a tick box each, signature,
  relationship and date lines, and the form version id. Printing it is not consent.
- **FR-18c** - `POST /api/cases/:id/paper-consents` (multipart, case access): `features[]` (the boxes the
  parent ticked), `guardian_name`, `relationship`, `signed_on`, `consent_document_ids[]` (the printed
  versions), `scan` (PDF/JPEG/PNG <= 10 MB) and `attestation` = true for the text
  `I confirm the parent or legal guardian signed this form in person.` -> 201 `{ state }`. Missing scan or
  attestation -> 400; outdated document version -> 409. One strict-audited transaction per request
  (`consent.paper_recorded`, FR-17 behaviour). `POST /api/cases/:id/paper-consents/withdraw`
  `{ feature, guardian_name, note }` records a paper withdrawal (no scan needed; withdrawing is never harder
  than granting).
- **FR-18d** - The case `Consent` panel (FR-14) gets `Print consent form` and `Record paper consent`, and
  shows `On paper, recorded by <provider> on <date>` per feature. If a guardian later links an account,
  `/family/children/[id]` shows paper consents as `Given on paper on <date>` and the guardian can withdraw
  them digitally.
- **FR-18e** - Paper consent works for legacy cases too: the centre can unblock a legacy case by
  recording the parent's signed form.

### Legacy and demo data

- **FR-18** - `scripts/seed-demo.ts` (and `seed:users`) create, for synthetic demo cases only, a
  synthetic guardian, an active link and v1 consents with `user_agent = 'seed:synthetic'` so the demo
  flow keeps working. Real legacy cases stay unclaimed and blocked until a guardian claims and consents.

## Non-functional requirements

- **NFR-1** - Consent checks are server-side only and happen in the same request/job step as the gated
  operation (no client-trusted flags; the old `parent_consent: true` body field is ignored).
- **NFR-2** - `consent_records` and `child_claim_codes` have RLS policies: guardians select their
  children's rows; no direct writes from `authenticated`.
- **NFR-3** - All new guardian pages translated (en/hi/te), 375 px, no third-party scripts.
- **NFR-4** - Migration is safe to run twice on a copy of production data (idempotent backfill), and a
  dry-run SQL check in `scripts/db-check.ts` reports cases without `child_id` (expected 0 after).

## Affected areas

- `supabase/migrations/<ts>_children_consent.sql` (new), `scripts/seed-demo.ts`, `scripts/seed-users.ts`, `scripts/db-check.ts`
- `lib/consent/**`, `lib/children/**` (new); `lib/authz.ts` (helpers)
- Gated routes: `app/api/cases/[id]/intake-link`, `app/api/intake/[token]/{start,complete}`,
  `app/api/webhooks/elevenlabs`, `app/api/dev/simulate-intake/[token]`, `app/api/cases/[id]/sessions`,
  `app/api/sessions/[id]/{transcribe,extract,report}`, `app/api/reports/[id]/parent-voice-note`,
  `app/api/cases/[id]/{refer,ask}`, `app/specialist/[token]`, `app/intake/[token]`, `lib/intake/process.ts`
- `app/api/cases/[id]/claim-code/route.ts`, `app/api/family/children/**`, `app/api/family/claims/route.ts` (new)
- `app/family/children/**` (new), case workspace consent panel component (new)
- `app/cases/[id]/consent-form/page.tsx`, `app/api/cases/[id]/paper-consents/**` (new); storage bucket `consent-forms` (migration)
- `messages/*.json`; `tests/consent-*.test.ts`, `tests/children-*.test.ts`, `tests/legacy-backfill.test.ts` (new)

## Don't touch

- Existing migration files, ISAA scoring/extraction logic (only add the gate calls), `lib/isaa.ts`,
  `BOARD.md`, org/invitation code from 017 (use its helpers)

## Out of scope

- Health profile (021), sharing grants and care team (022), document upload (023).
- Deletion/export requests and retention (041); 041 registers `consent-forms` scans for retention.
- Co-guardian invitations by an existing guardian.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Child vs case | `children` separate; `cases` = org-specific care episode with `child_id` | rule 2 |
| D-2 | Legacy cases | Unclaimed `legacy_case` children; no guardian inference; no fabricated consent | rule 1 |
| D-3 | Consent granularity | Versioned, per child, per feature; append-only log | plan §2 "Child consent", rule 6 |
| D-4 | "Verifiable" guardian | Signed-in account with OTP-verified phone + declaration; provider claim code links clinic records | plan §2; DPDP verifiable parental consent |
| D-5 | Cross-border disclosure | Each consent text lists processors + locations | plan §2 "AI on real data" |
| D-6 | Link lifetime | Intake 7 days, referral 30 days, claim code 72 h; all revocable | rule 6 |
| D-7 | Consent failure mode | Fail closed (503, no state change) | rule 7 |
| D-8 | Parents without a smartphone | Paper consent recorded by the centre with a signed scan and provider attestation | product owner 2026-11-12: "paper consent by the center" |

## Open questions

- Legal review of v1 consent texts in en/hi/te (plan §6) - blocks the real pilot, not this ticket.
