# E-prescriptions (ticket 039)

Verified prescribers (developmental paediatricians, child psychiatrists, paediatricians/GPs with an NMC or State
Medical Council registration, 028 rule) turn an AI Rx draft (038) - or a blank form - into a signed prescription PDF.
Signing is checked on the server, produces an immutable version with signer and timestamp (design rule 9), checks the
child's allergies from the health profile (021) and publishes the signed version to the guardian (024). Non-prescribers
never see prescription features. Drug databases, interaction checks, Schedule H/X rules and DSC/Aadhaar eSign are out
of scope (legal review, see the ticket's open questions).

## Model (`supabase/migrations/20261113003900_prescriptions.sql`)

| Table | What |
|-------|------|
| `prescriptions` | `case_id` (cascade), `child_id`, `org_id` (copied from the case by the trigger; `child_id` follows a 020 claim merge), `appointment_id` (no FK, 030 owns appointments), `prescriber_profile_id` (creator, replaced by the signer at signing), `source_report_id` (the 038 `rx_draft`, `on delete set null`), `status` `draft` / `signed` / `void`, `current_version` (the version row in effect), `version` (optimistic concurrency for edits), `void_reason` (1-500) / `voided_by` / `voided_at`, `created_by`. |
| `prescription_versions` | `prescription_id`, `version` (unique together), `items` (FR-2, <= 15), `advice` (<= 2000), `follow_up` (<= 300); set at signing: `allergies_snapshot`, `child_snapshot`, `prescriber_snapshot`, `content_md` (authoritative), `content_hash` (sha256 hex of `content_md`), `pdf_path`, `signed_by` (kept: no `set null`), `signed_at`. A check makes a signed row complete. |

While a prescription is a draft its content is the current version row with `signed_at` null (editable). Signing fills
the row in; from then on:

- trigger `prescription_versions_guard`: a signed row can be neither updated nor deleted (it goes only with its
  prescription, i.e. with the case); a row can only become signed when `signed_by` owns a provider profile for which
  `provider_can_prescribe` is true (NFR-1 in the database too); truncate is refused;
- trigger `prescriptions_guard`: status moves only `draft -> signed -> void`; a signed prescription keeps its case,
  prescriber, version and appointment; a void one is frozen; `void` needs `void_reason` + `voided_at` (check); signed
  and void prescriptions are deleted only with their case.

Voiding creates **no** new prescription version. Storage: private bucket `prescriptions` (PDF only, 5 MB), object
`<case_id>/<prescription_id>/v<version>.pdf`; never a public or signed URL - the PDF routes stream the bytes after the
access check (`Cache-Control: private, no-store`).

RLS (browser reads only): the case's care team (`can_access_case`) reads both tables; no client writes. The server uses
the service role and the gates in `lib/rx/authz.ts`.

### Item (FR-2, `lib/rx/schema.ts`, shared with 038's `RxItemSchema` shape)

```ts
{ drug: 1-120 (generic name), strength: <= 60, form: "tablet"|"syrup"|"drops"|"capsule"|"other", dose: <= 60,
  frequency: <= 60, duration_days: 1-365, route: <= 40, instructions?: <= 300 | null }   // at most 15 items
```

Drafts may leave `dose` / `frequency` / `route` empty; signing requires them (422 `Complete every medicine before
signing`, `details` like `{ "items.0.dose": "Enter the dose" }`).

### Snapshots (`lib/rx/document.ts`)

- `child_snapshot` `{ name, age, date_of_birth, weight_kg? }` - name from `children.display_name`, age on the signing
  date in IST from the date of birth (fallback: the case's `child_age_months`), e.g. `4 years 2 months`, or null.
  Weight is not captured in the pilot.
- `prescriber_snapshot` `{ name, qualifications, provider_type, council, council_state, registration_number, org,
  address }` - from the signer's profile; `org` = the organisation's public name (or name), `address` = the practice
  location the prescriber is linked to (else the organisation's first location).
- `allergies_snapshot` `{ status, allergies, medications, health_profile_version, matches, override_reason }` from
  021 `getPrescribingHealthFacts(childId)`: `status` = `listed` (allergies on record), `none_known` (the family recorded
  "No known allergies") or `not_recorded` (no profile or an empty allergy list: **UNKNOWN**, printed as `NOT RECORDED -
  allergy status unknown`, never "none").

## Signing (FR-4, `signPrescription` in `lib/rx/index.ts`)

One transaction:

1. lock the prescription; must be `draft` (409 `This prescription is already signed`);
2. re-check the prescriber rule for the **signer**: their own profile, `provider_can_prescribe`, locked `for share`
   (a concurrent suspension is ordered before or after the signature, never in between) -> 403
   `Only verified prescribers can write prescriptions`; the route gate checked it already and the trigger checks again;
3. at least one item (422 `Add at least one medicine before signing`), complete items (422);
4. allergy check: item drug names vs the recorded allergies (`allergyMatches`: case/punctuation-insensitive, whole
   words, either name containing the other). A match without `allergy_override_reason` -> 422
   `A medicine matches a recorded allergy. Give a reason to prescribe it anyway.` with
   `details.matches: [{ item_index, drug, substance, severity }]`; with a reason the matches and the reason are stored
   in `allergies_snapshot` and printed (`Allergy override: ...`);
5. snapshots, `content_md` (`prescriptionMarkdown`), `content_hash`, `pdf_path`, `signed_by`, `signed_at`;
   `prescriptions.status = signed`, `prescriber_profile_id` = the signer;
6. 024 `publishVersion(tx, { entityType: "prescription", visibleToGuardian: true, ... })`;
7. `auditStrict({ action: "rx.signed", details: { version, items, content_hash, prescriber_profile_id,
   allergy_status, allergy_override, health_profile_version, published_version } }, tx)` - no drug names, no reason
   text (041 strict action: an audit failure -> 503 `Could not save. Please try again.` and nothing is signed);
8. outbox `prescription.signed` `{ prescription_id, child_id, case_id }` (dedup `prescription:<id>:signed`);
9. render and upload the PDF (last step; the object is removed again if the commit fails). Any failure -> 503.

`voidPrescription` (FR-1/FR-5): signed only (draft -> 409 `Only a signed prescription can be cancelled`, void -> 409),
reason 1-500 (400 otherwise), sets `void` / `void_reason` / `voided_by` / `voided_at`, publishes a new guardian-visible
published version `# Prescription cancelled ...` (so 040's follow-up agent never reads a cancelled prescription as
current; the reason is not published), strict audit `rx.voided`, outbox `prescription.voided`.

## PDF (`lib/rx/pdf.ts`, dependency `pdf-lib`)

`pdf-lib` (MIT, pure JavaScript, no native code or headless browser) is the one dependency this ticket adds. A4,
standard Helvetica. Content: prescriber name, qualifications, registration council + number, clinic and address,
date (IST), child name and age, allergy status (and override), medicines (name, strength, form, dose, frequency,
duration, route, instructions), advice, follow-up. Footer on every page: `<name> - <council> - Reg. No. <number>`,
`Digitally generated on DoctorNearMe; signed by <name> on <IST timestamp>.`, `Content hash (SHA-256): <hash>`,
`AI drafts are reviewed and signed by the prescriber. Generated by DoctorNearMe.`, `Page n of m`.

Deterministic (NFR-2): no "now" in the document (dates = `signed_at`, IST formatted by hand, metadata auto-update
off, fixed producer/creator), so regenerating a version gives the same `content_md`/`content_hash` **and** the same
PDF bytes. A missing storage object is regenerated from the snapshots, only if the regenerated hash matches
(`prescriptionPdfBytes`). Standard fonts are WinAnsi: characters outside it (Devanagari/Telugu names) print as `?` in
the PDF; `content_md` (shown in the app) keeps the original text. Embedding a Unicode font is a follow-up.

## Access (NFR-1)

| Who | Gate |
|-----|------|
| Providers, `/api/cases/:id/prescriptions` | `requireCaseActor` (022 case access, else 404) then `requirePrescriber` (028 rule on the caller's **own** profile, derived in SQL each time, else 403 `Only verified prescribers can write prescriptions`) |
| Providers, `/api/prescriptions/:id/**` | `requirePrescriptionActor`: case of the prescription (missing / malformed / other tenants' ids -> 404), then the prescriber rule (403) |
| Case workspace tab | the layout shows `Prescriptions` only when `userCanPrescribe(session user)`; the page itself 404s for everyone else (`requirePrescriberCasePage`) |
| Guardians | `requireGuardian` + active link to the child; the PDF needs a `signed` (not void) prescription whose latest published version is visible to guardians; anything else 404 |

Nothing in a request body can enable prescribing (bodies are `.strict()`: unknown fields -> 400).

## API

| Route | Body | Answer |
|-------|------|--------|
| `GET /api/cases/:id/prescriptions` | - | 200 `{ prescriptions: [{ id, status, items, drugs, prescriber_name, signed_at, voided_at, created_at, from_ai_draft }] }` |
| `POST /api/cases/:id/prescriptions` | `{ from_report_id? }` | 201 `{ created: true, prescription, current, prescriber_name }` (prefilled from the case's `rx_draft`: items without citations, advice, follow-up); the same `from_report_id` again -> 200 `{ created: false, ... }` with the existing (not void) prescription; unknown / other case's / non-`rx_draft` report -> 404 |
| `GET /api/prescriptions/:id` | - | 200 `{ prescription, current, prescriber_name }` |
| `PATCH /api/prescriptions/:id` | `{ items, advice, follow_up, version }` | 200 detail; stale `version` -> 409 `This prescription was changed by someone else. Reload to see the latest version.` `{ details: { version } }`; signed/void -> 409 `Signed prescriptions cannot be changed` |
| `POST /api/prescriptions/:id/sign` | `{ confirm: true, allergy_override_reason? }` | 200 `{ version, published_version, allergy_matches }`; 400 without `confirm: true`; 403 / 409 / 422 / 503 as above |
| `POST /api/prescriptions/:id/void` | `{ reason }` | 200 `{ prescription }`; 400 / 409 |
| `GET /api/prescriptions/:id/pdf` | - | 200 `application/pdf` (signed or void); draft -> 404 |
| `GET /api/family/children/:id/prescriptions` | - | 200 `{ prescriptions: [{ id, status, org_name, prescriber_name, signed_at, voided_at, content_md, published_at, pdf_url }] }` (`pdf_url` null when cancelled) |
| `GET /api/family/prescriptions/:id/pdf` | - | 200 `application/pdf`; cancelled, draft, other families -> 404 |

PDF downloads write a best-effort audit row `rx.pdf_downloaded`. Draft writes audit `rx.draft_created` /
`rx.draft_updated` (ids and counts only) in their transaction.

## UI

- Provider: case workspace tab `Prescriptions` (`app/cases/[id]/prescriptions`, `components/rx/PrescriptionsPanel.tsx`).
  `?from_report_id=<rx_draft>` (038's `Review in prescriptions`) shows the AI draft card (`Suggested by DoctorNearMe -
  the clinician decides`) with `Start from this draft` (or a link to the prescription already started from it);
  `?rx=<id>` selects a prescription. Draft editor: allergy banner (listed / no known allergies / **not recorded**, plus
  current medicines), one fieldset per medicine (`Medicine (generic name)`, `Strength`, `Form`, `Dose`, `How often`,
  `Days`, `Route`, `Instructions (optional)`, `Remove medicine <n>`), inline `Matches a recorded allergy: <substance>`,
  `Add medicine` (max 15), `Advice`, `Follow-up`, `Save draft`, `Sign and generate PDF` -> dialog `Sign this
  prescription?` with the checkbox `I have reviewed every item and take responsibility for this prescription.` and,
  when a medicine matches an allergy, `Reason to prescribe despite the allergy`. Signed view: read only, signer and
  date, content hash, `Download PDF`, `Void` (dialog with `Reason`). List `All prescriptions` with status badges.
- Guardian: `/family/children/[id]/prescriptions` (linked from the child page as `Prescriptions`): per prescription the
  organisation, `Signed by <name> on <date>`, the published text and `Download PDF`; cancelled ones show `Cancelled by
  prescriber` and `Do not use this prescription...` without a download.
- UI chrome translated (en/hi/te, namespace `rx`, `caseTabs.prescriptions`); prescription content is shown as written.

## Notifications (032)

| Topic | Recipients (re-checked at fan-out) | Channels | Template |
|-------|------------------------------------|----------|----------|
| `prescription.signed` | active guardians of the live child, while the prescription is still `signed` and its latest published version is guardian-visible | in-app, email | `prescription_signed` (`New prescription`, links to `/family/children/<id>/prescriptions`) |
| `prescription.voided` | the same guardians, while it is `void` | in-app, email | `prescription_voided` (`Prescription cancelled`) |

No WhatsApp template; no medicine names, child name or other clinical content in email (032 content rule).

## Privacy (041)

Registry key `prescriptions` (`lib/privacy/registry.ts`): tables `prescriptions`, `prescription_versions`, bucket
`prescriptions`. Export: the guardian's portal view (signed and cancelled prescriptions with their published text; the
PDF of signed ones); drafts and void reasons never. Erasure (`everything`): the PDFs are removed first, the rows go with
the child's cases. Signed prescriptions are clinical records: deleting a signer's account is refused while their signed
versions exist (`signed_by` keeps its FK).

## For later tickets

- **040 follow-up agent**: read prescriptions through `listGuardianVisible(sql, childId, "prescription")` (024) or
  `listGuardianPrescriptions(childId)` (`lib/rx`); a cancelled prescription's latest published version is the
  cancellation notice, so it is never presented as current.
- **030/035 appointments**: `prescriptions.appointment_id` exists without FK; set it when a prescription is written
  for an appointment and add the FK once `appointments` is merged.

## Tests

`tests/prescriptions.test.ts` (pure: schema limits, allergy matching, allergy wording, IST/age, deterministic markdown,
hash and PDF bytes with every required field; database: gate matrix, E-1 draft -> edit -> sign -> PDF -> guardian +
notification, NFR-2 regeneration equals the stored PDF, E-2 allergy override, immutability triggers, void, E-3 authz
negatives, suspension between draft and sign at all three layers, strict audit failure -> 503 with nothing signed, the
privacy export): `npx vitest run tests/prescriptions.test.ts --reporter=verbose`.
