# 039: E-prescriptions for verified prescribers

**Status:** draft
**Mode:** solo
**Runs:** waits for 021, 028, 038: prescriber verification and `provider_can_prescribe` (028); AI Rx drafts (038); allergies and current medicines from the health profile (021)

## Summary

Verified prescribers (developmental paediatricians, child psychiatrists, paediatricians/GPs) turn an AI
Rx draft - or a blank form - into a signed prescription PDF. Signing is checked server-side, produces an
immutable version with signer and timestamp (rule 9), checks allergies from the health profile, and
publishes the signed version to the guardian. Non-prescribers never see prescription features.

## Functional requirements

- **FR-1** - Migration `<ts>_prescriptions.sql`: `prescriptions(id, case_id, child_id, org_id,
  appointment_id null, prescriber_profile_id, source_report_id null (rx_draft), status text check in
  ('draft','signed','void'), current_version int, created_at)`; `prescription_versions(id,
  prescription_id, version, items jsonb, advice text, follow_up text, allergies_snapshot jsonb,
  child_snapshot jsonb ({ name, age, weight_kg? }), prescriber_snapshot jsonb ({ name, qualifications,
  council, registration_number, org, address }), content_md, content_hash, pdf_path, signed_by,
  signed_at, unique (prescription_id, version))`; trigger makes signed versions immutable; `void`
  requires `void_reason` and creates no new version.
- **FR-2** - Item schema `{ drug (generic name, 1-120), strength, form ('tablet','syrup','drops',
  'capsule','other'), dose, frequency, duration_days 1-365, route, instructions? }`, max 15 items.
- **FR-3** - APIs (provider with case access **and** `provider_can_prescribe(own profile)`, else 403
  `{ error: "Only verified prescribers can write prescriptions" }`): `POST /api/cases/:id/prescriptions`
  `{ from_report_id? }` -> 201 draft (prefilled from `rx_draft`); `PATCH /api/prescriptions/:id`
  `{ items, advice, follow_up, version }` (409 on stale); `POST /api/prescriptions/:id/sign`
  `{ confirm: true, allergy_override_reason? }`.
- **FR-4** - Signing (one transaction): re-checks `provider_can_prescribe` at sign time; compares item drug
  names to the child's allergy list (021) - a match requires `allergy_override_reason` (422 otherwise
  with `details.matches`); writes the immutable version with snapshots, `content_md` (authoritative) and
  sha256; renders the PDF (`lib/rx/pdf.ts`, `pdf-lib` - new dependency) to private bucket
  `prescriptions`; calls 024 `publishVersion` (`entity_type = 'prescription'`, `visible_to_guardian =
  true`); `auditStrict('rx.signed')`; outbox `prescription.signed` to guardian (no drug names in
  WhatsApp/email). PDF footer: prescriber name, registration, `Digitally generated on DoctorNearMe;
  signed by <name> on <IST timestamp>`, content hash, and `AI drafts are reviewed and signed by the
  prescriber.`
- **FR-5** - UI: case workspace `Prescriptions` tab (only for prescribers): list, editor with item rows,
  allergy banner (021), `Sign and generate PDF` with confirmation dialog `I have reviewed every item and
  take responsibility for this prescription.`; signed ones read-only with `Download PDF` and `Void`.
  Guardian `/family/children/[id]/prescriptions`: signed published versions with `Download PDF`.

## Non-functional requirements

- **NFR-1** - No client-side flag can enable prescribing; all checks server-side.
- **NFR-2** - PDF regeneration from a version yields identical `content_hash`.
- **NFR-3** - Register `prescriptions` in the 041 privacy registry.

## Affected areas

- `supabase/migrations/<ts>_prescriptions.sql` (new); `lib/rx/**` (new); `package.json` (`pdf-lib`)
- `app/api/cases/[id]/prescriptions/**`, `app/api/prescriptions/**` (new); case `Prescriptions` tab, `app/family/children/[id]/prescriptions/**` (new)
- `lib/audit/strict-actions.ts`, `lib/notify/topics.ts`, `messages/*.json`; `tests/prescriptions.test.ts` (new)

## Don't touch

- 028 verification logic, 038 scribe, `published_versions` schema, existing migrations, `BOARD.md`

## Out of scope

- Drug database/interaction checks, e-pharmacy integration (dropped), controlled substances rules
  (Schedule H/X handling), digital signature certificates (DSC/Aadhaar eSign) - see open questions.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Who prescribes | Verified dev-ped, child psychiatrist, GP/peds only | plan §2 "E-Rx" |
| D-2 | AI role | AI drafts; prescriber reviews/edits/signs | plan §2 "AI scribe -> Rx" |
| D-3 | Signed representation | Immutable version + hash + snapshots; published via `published_versions` | rule 9 |

## Open questions

- Telemedicine Practice Guidelines 2020 compliance (prescriber registration on Rx, list restrictions for
  video consults) and whether a DSC/eSign is required for the pilot - legal review.
