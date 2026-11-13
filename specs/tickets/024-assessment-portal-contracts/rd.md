# 024: Assessment portal and shared clinical contracts

**Status:** done
**Mode:** solo
**Runs:** waits for 022: assessments are case-scoped, use assignments and register the `assessments`/`reports` sharing scopes

## Summary

Two parts. (1) **Shared clinical contracts** (rule 8) that later tickets build on without breaking the
existing Child Development (ISAA) workflow: an instrument registry, a report-kind registry with one
authoritative published representation, and a speaker-role contract - plus regression evals that prove
intake, speaker swap, extraction, scoring, report finalisation, referral and parent voice note behave
exactly as before. (2) The **assessment portal**: providers assign questionnaires (templates) to a
guardian, the guardian fills them in the family portal, the provider reviews and scores them.

## Functional requirements

### Part 1 - contracts (no behaviour change for ISAA)

- **FR-1** - Instrument registry. Migration `<ts>_clinical_contracts.sql`: `clinical_instruments(key text pk,
  version text, kind text check in ('provider_rated','guardian_questionnaire','case_sheet'), title,
  definition jsonb, active boolean)`, seeded with `ISAA` (from `schemas/isaa.json`), `CASE_SHEET`
  (`schemas/case-sheet.json`) and `ISAA_PARENT_CHECKIN` (FR-4). Replace the `facts.instrument` check
  constraint with a foreign key to `clinical_instruments(key)` (expand: add FK `not valid`, validate,
  then drop the old check). `lib/clinical/instruments.ts` exposes `getInstrument(key)`,
  `InstrumentDefinition` (items with id, domain, text, scale, optional `reverse`, `red_flag` codes) and
  `score(key, answers)`; `ISAA` scoring delegates to the existing `lib/scoring.ts` unchanged.
- **FR-2** - Report-kind registry `lib/clinical/reports.ts`: `REPORT_KINDS` = existing
  `pre_session_brief`, `assessment`, `parent_summary` plus reserved `session_note` (038),
  `rx_draft` (038/039), `generic_intake_brief` (035), each with `{ audience: "provider" | "guardian" |
  "both", publishable: boolean, producer }`. Later tickets extend the DB check when they add rows.
- **FR-3** - Published versions (rule 9 contract, used by 025, 026, 039, 040):
  `published_versions(id, entity_type text check in ('report','iep_plan','home_program','prescription',
  'assessment'), entity_id uuid, version int, child_id, case_id, org_id, content_md text not null,
  content_hash text not null (sha256 of content_md), visible_to_guardian boolean, published_by uuid,
  published_at, unique (entity_type, entity_id, version))`; append-only (update/delete raise).
  `lib/clinical/publish.ts` `publishVersion(tx, {...})` is the only writer. **`content_md` is
  authoritative**; `reports.content` (jsonb) is treated as the AI draft input only. Finalising a report
  (`PATCH /api/reports/:id { status: "final" }`) publishes version 1 from the final `content_md` in the
  same transaction; `assessment` reports default `visible_to_guardian = false`, `parent_summary` `true`.
  Backfill: one published version for every existing `final` report.
- **FR-4** - `schemas/isaa-parent-checkin.json` (`ISAA_PARENT_CHECKIN`): 15 short parent-friendly
  questions derived from ISAA domains (social, emotional, speech, behaviour, sensory, cognitive), each
  `{ id, domain, text_en, answer_scale: ["never","sometimes","often","always"], age_bands }`, plus red-flag
  questions `{ id, code: "skill_regression" | "self_injury" | "seizure" | "breathing" | "not_eating_drinking"
  | "safety_concern", text_en }` and result bands `no_strong_signs | discuss_with_professional |
  see_professional_soon` with fixed copy that says `This is a developmental check-in, not a diagnosis.`
  Hindi/Telugu item text is left out (clinical translation review pending, 018 D-4).
  Used by this portal and by the public screen (033).
- **FR-5** - Speaker-role contract `lib/clinical/speakers.ts`: stored values stay `therapist | parent |
  agent | unknown` (no data rewrite) and gain `child | other_adult`; documented meaning:
  `therapist` = the clinician of any provider type, `parent` = guardian/caregiver. UI labels via i18n:
  `Clinician`, `Parent or caregiver`, `Child`, `Other adult`, `AI assistant`, `Unknown`. Swap logic
  (008) only swaps `therapist` <-> `parent` and leaves the new roles untouched.
- **FR-6** - Legacy seeds (`scripts/seed-demo.ts`, fixtures) updated to the contract (instrument rows
  exist, published version for the seeded final report). `docs/system-design.md` gains a short
  "Clinical contracts" section pointing to these modules (docs-only edit in that section).

### Part 2 - assessment portal

- **FR-7** - Tables: `assessment_templates(id, org_id null (null = global), instrument_key -> clinical_instruments,
  title, audience text check in ('guardian','provider'), active, created_by, created_at)` seeded with a
  global `Parent developmental check-in` (`ISAA_PARENT_CHECKIN`); `assessments(id, case_id, child_id,
  org_id, template_id, assigned_to -> auth.users (guardian), assigned_by, status text check in
  ('assigned','in_progress','submitted','reviewed','cancelled'), due_on date null, submitted_at,
  reviewed_by, reviewed_at, score jsonb, reviewer_note text, version int)`; `assessment_responses(
  assessment_id, item_id, value jsonb, answered_by, answered_at, primary key (assessment_id, item_id))`.
- **FR-8** - Provider: case workspace `Assessments` tab - `Send questionnaire` (template select, guardian
  select from the child's active guardian links, optional `Due date`) -> `POST /api/cases/:id/assessments`
  `{ template_id, assigned_to, due_on? }` -> 201 (guardian not linked to the case child -> 422
  `{ error: "This parent is not linked to the child" }`); list with status; open a submitted one ->
  answers, computed score/band, red-flag answers highlighted, `Mark reviewed` with note ->
  `POST /api/assessments/:id/review` -> 200; publish a summary for the guardian via `publishVersion`
  (`entity_type = 'assessment'`) with `Share result with parent` checkbox. `Cancel` for open ones.
- **FR-9** - Guardian: `/family/assessments` list (child, title, due date, status) and
  `/family/assessments/[id]` form, one question per screen on mobile, `Save and continue later`,
  `Submit`. `PUT /api/family/assessments/:id/responses` `{ answers: [{ item_id, value }], version }` -> 200
  (stale version -> 409); `POST /api/family/assessments/:id/submit` -> 200 (incomplete -> 422
  `{ error: "Please answer all questions", details: { missing: [...] } }`; already submitted -> 409).
  Any red-flag answer `yes` shows immediately: `Please contact your child's doctor now. In an emergency
  call 108 (ambulance) or 112.` and the provider is notified via outbox event `assessment.red_flag`
  (if 032 merged).
- **FR-10** - Sharing: register scope `assessments` (reviewed assessments' published versions) in the
  022 registry; the `reports` loader now reads `published_versions`.

## Non-functional requirements

- **NFR-1** - Regression: the existing Child Development pipeline output is byte-identical for the demo
  fixtures before/after (same facts, scores, bands, brief, report markdown, referral packet).
- **NFR-2** - Only guardians assigned to an assessment can read/write it; providers need case access.
- **NFR-3** - Guardian pages translated (UI chrome); question text English until clinical translation review.

## Affected areas

- `supabase/migrations/<ts>_clinical_contracts.sql`, `<ts>_assessments.sql` (new)
- `lib/clinical/{instruments,reports,publish,speakers}.ts` (new); `lib/speaker-swap.ts`, `lib/types.ts`
  (`SpeakerRoleSchema` extension only); `app/api/reports/[id]/route.ts` (publish on final)
- `schemas/isaa-parent-checkin.json` (new); `scripts/seed-demo.ts`, `demo/fixtures/**` (contract updates only)
- `app/api/cases/[id]/assessments/**`, `app/api/assessments/[id]/**`, `app/api/family/assessments/**` (new)
- Case workspace `Assessments` tab, `app/family/assessments/**` (new); `lib/sharing/registry.ts`
- `docs/system-design.md` (new "Clinical contracts" section only)
- `tests/clinical-contracts.test.ts`, `tests/assessments.test.ts`, `tests/regression-child-dev.test.ts` (new)

## Don't touch

- `lib/scoring.ts` logic, `schemas/isaa.json`, `prompts/*.md`, existing migrations, `BOARD.md`

## Out of scope

- Provider-authored custom templates UI (global seed + `org_id` column only); new standardised
  instruments (M-CHAT, etc. need licensing review); AI extraction from questionnaires.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Contract placement | Instruments, report kinds, published versions, speaker roles defined here in M1 | rule 8 |
| D-2 | Published-version table placed in 024 (not 039) | 025/026 publish in M1 and 040 reads them; 039 adds signing on top | rule 9 needs one representation before M1 publishes |
| D-3 | Speaker roles | Keep stored values, extend enum, relabel | no data rewrite; ISAA behaviour unchanged (rule 8) |
| D-4 | Parent questionnaire | ISAA-derived, "not a diagnosis", red-flag codes | plan §2 "Screening instrument", "Safety"; risk 1 |
| D-5 | Assessment portal kept | Yes | plan §2 old DRnME features |

## Open questions

- Clinical review of the 15 ISAA-derived parent questions and band thresholds before the pilot (human task).
