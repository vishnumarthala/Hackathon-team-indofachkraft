# Importing existing children from a CSV (ticket 047)

A pilot centre already has 50-200 children in therapy. `/dashboard/import` lets an organisation **owner or admin**
bring them in from a spreadsheet in one go. Members see a notice instead; the API answers 403 for members and 404 for
anyone outside the organisation.

## Flow

1. **Template** - `GET /api/org/import/template` (header row only, UTF-8 with BOM so Excel shows Telugu/Hindi names).
2. **Upload + preview** - `POST /api/org/import/preview` (multipart `org_id`, `file`). The server decodes the file
   (UTF-8 only; anything else -> "Save As > CSV UTF-8"), checks the header, the limits (1 MB, 500 data rows) and every
   row, and returns the rows with plain messages. Nothing is stored.
3. **Import** - `POST /api/org/import` with the same file plus `import_duplicates` (JSON array of row numbers the user
   chose `Import anyway` for). The server validates again (the browser's preview is never trusted) and imports the
   valid rows plus the chosen duplicates in **one transaction** (`lib/import/store.ts` `runImport`).
4. **Result** - imported / skipped / failed counts and the code list: child, guardian, phone, one-time claim code
   (020, 72 h), the 020 WhatsApp message as a `wa.me` link, consent `Not given`, and a `Record paper consent`
   shortcut (`/cases/:id/consent/paper`). `Download the list (CSV)` builds the list in the browser (formula cells are
   neutralised). The codes are shown once; the import page (`/dashboard/import/:id`) can `Make new codes` for every
   child no family has linked yet (older codes stop working).
5. **Undo** - within 24 h (`undo_until`), all or nothing, see below.

## Columns

| Column | Rules |
|---|---|
| `child_first_name`* | required; first + last name <= 60 characters (any script, NFC-normalised) |
| `child_last_name` | optional |
| `date_of_birth`* | `YYYY-MM-DD` or `DD/MM/YYYY` (also `D/M/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`); not in the future; 18+ refused; **above 8 = warning only** (decision 11) |
| `guardian_name`* | required, <= 60 |
| `guardian_phone` | optional; 10-digit Indian mobile (`+91` / `91` / `0` prefixes, spaces, hyphens allowed); stored as `+91XXXXXXXXXX`; missing = warning (share the code in person) |
| `preferred_language` | `en` / `hi` / `te` (or English / Hindi / Telugu); default `en` |
| `therapist_email` | optional; must be an **active member** of the organisation -> the therapist becomes the case `lead` (022). Without one the importing owner/admin is the lead |
| `notes` | optional, <= 500; kept on the import row (provider-only, shown on the import page) |
| `weekdays`, `time`, `service_name` | optional timetable, all three together plus `therapist_email`; `Mon;Wed;Fri` (1-4 days), `10:00` / `4:30 pm`; the service must be an active `in_clinic`/`video` service of the organisation |
| `billing_mode` | optional with a timetable (044): 043's `package` / `per_session` / `free` (`per session`, `per-session` accepted); empty = `per_session` |

Row numbers are spreadsheet row numbers (the header is row 1). Messages look like `Row 12: date of birth is in the
future`; the API returns `{ code, params, message }` and the UI translates `code` (`childImport.issues.*` in
`messages/{en,hi,te}.json`).

**Duplicates** (FR-2): same first name (whole word at the start of the child's name) + date of birth + guardian phone
as a child of one of the organisation's cases, or as an earlier row of the same file. Default `Skip`; `Import anyway`
per row.

## What is created (per imported row)

`children` (`source = provider`, unclaimed), `cases` (org case, `status = booked`, `parent_alias`/`parent_phone`/
`language` from the row, `therapist_name` = therapist's display name or the organisation's name), `case_assignments`
(therapist as `lead`), `child_claim_codes` via 020's `create_child_claim_code` (hash only), `child_import_rows`.
Never: `consent_records` (consent starts at `none`, decision record rules 1 and 6), outbox messages (NFR-2), guardian
links. One strict audit row `children.imported` with **counts only** (`import_id`, `total_rows`, `imported`, `skipped`,
`failed`, `timetable_pending`, `series_created`).

**Idempotency** (FR-3): `child_imports` has a unique `(org_id, file_hash)` for imports that are not undone, and imports
run under a per-organisation advisory lock. Uploading the same bytes again returns 200 `{ result: "existing" }`
and the preview shows `already_imported`. After an undo the same file can be imported again.

## Undo (FR-5)

`POST /api/org/import/:id/undo` -> `undo_child_import_with_series()` (044; 047's `undo_child_import()` is kept but
unused): allowed for 24 h. It is refused (409, `blocked_rows`) when anything was added to an imported child or case
since: any row in any table with a foreign key to `cases(id)` or `children(id)` (session notes, recordings, reports,
documents, appointments, guardian links, consent records, another case, sharing grants, ...), a used claim code, or an
issued intake link. Care-team assignments, unused claim codes, the import rows and (044) the **import's own untouched
weekly series** do not count. The check reads the foreign keys from the catalogue, so tables added later are covered.

A series created by the import counts as untouched while it is still `active`, was never paused, is not continued by a
"this and future" change, has no resolved conflict, every session is `confirmed`, unmarked (044), in the future and at
the series time on its date, and nothing else references the series or its sessions (payments, recordings, reports,
ratings, intake links, prescriptions, ... - again read from the catalogue). A past session counts as touched: it may
have taken place.

On success the series' future sessions (their unsent jobs withdrawn) and the series are deleted, then the cases (and
their assignments, codes and import rows) and the children; the import keeps its hash and counts with `undone_at`, and a
strict `children.import_undone` audit row is written (`cases`, `children`, `series`, `sessions`). The undo takes the
same per-organisation lock as the import, then the series and provider locks in 043's order.

## Timetable columns and weekly series (043, wired by 044)

* **Import**: `defaultSeriesScheduler` (`lib/import/schedule.ts`) calls 043's `createSeries` inside the import's
  transaction (savepoint): the therapist's own provider profile, the matched service (must be that profile's service),
  047's weekdays converted to 043's numbering (047 stores 0 = Sunday, 043 uses 0 = Monday: `toSeriesWeekdays`), the
  row's `billing_mode`, `starts_on` = today in the clinic's zone, no family account (`guardian: null`, so nothing is
  messaged - 047 NFR-2) and 8 weeks materialized; clashes become 043 conflicts on `/dashboard/schedule`. The row becomes
  `scheduled` with its `series_id`.
* **Pending**: a refusal (no provider profile, a demo profile, a service of another therapist, ...) rolls back to the
  savepoint and leaves the row `pending`; the import never fails because of it. Imports made before 043 have only
  `pending` rows.
* **Schedule saved timetables** (044): the import page shows the button while `timetable_pending_count > 0`;
  `POST /api/org/import/:id/schedule` (owner/admin) or `npm run import:schedule-pending [-- --org <id>]` (every import,
  acting as the owner/admin who made it) creates the missing series under the import lock. Idempotent: scheduled rows
  are never touched again; counts on `child_imports` and a strict `children.import_timetables_scheduled` audit row
  (counts only).

## Limits and performance

1 MB, 500 rows, one transaction. 500 rows import in about 0.2 s locally (NFR-1 target < 30 s).
