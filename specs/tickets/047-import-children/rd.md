# 047: Import existing children from a spreadsheet

**Status:** done
**Mode:** solo
**Runs:** alongside (043 can use the imported children, but neither blocks the other)

## Summary

A pilot centre already has 50–200 children in therapy. Typing them in one by one is a reason not to switch.
This ticket lets an org owner/admin upload a CSV. The flow previews and validates it, then creates the
children, cases and therapist assignments. It also produces a list of **clinic codes** to share with
families on WhatsApp. It never invents consent (rule 1 and rule 6 of the decision record).

Source: [PMF check](../../grill/doctornearme-pmf-check.md) §3c and §5 item 5.

## Functional requirements

- **FR-1** – `/dashboard/import` (owner/admin): download a template CSV, upload a CSV (max 500 rows, max
  1 MB, UTF-8, Telugu/Hindi names allowed), then preview and import.
  - **Columns:** `child_first_name*`, `child_last_name`, `date_of_birth*` (YYYY-MM-DD or DD/MM/YYYY),
    `guardian_name*`, `guardian_phone` (10-digit Indian), `preferred_language` (en/hi/te),
    `therapist_email`, `notes`.
  - **Optional timetable columns** `weekdays` (e.g. `Mon;Wed;Fri`), `time`, `service_name`. When these are
    present and 043 is on `main`, a series is created.
- **FR-2** – Validation runs on the server, per row, with plain errors. Examples: "Row 12: date of birth is
  in the future", "Row 30: no therapist with this email in your organisation".
  - Ages above 8 get a warning, not an error.
  - Duplicates against existing children in the org (same first name + DOB + guardian phone) are flagged.
    The user chooses `Skip` or `Import anyway`.
- **FR-3** – Import runs in one job per file, idempotent by file hash. For each row it:
  - creates an unclaimed `children` row and an org `case`;
  - adds a `case_assignments` row for the therapist;
  - creates a `child_claim_codes` code (as 020; 72 h expiry, regenerable).
  - It records **no** consent: consent status starts as `none`.
  - The import result is auditable (`children.imported` with counts only, no names in the audit payload).
- **FR-4** – Result screen: imported, skipped and failed counts; a downloadable list (child, guardian,
  phone, code, WhatsApp link with the 020 message text); and a `Record paper consent` shortcut per child,
  which opens the existing 020 paper consent flow.
- **FR-5** – Rollback: within 24 h, owner/admin can `Undo import`. It deletes children, cases and codes
  created by that import only if nothing else was added to them since.

## Non-functional requirements

- **NFR-1** – A 500-row import finishes in < 30 s. The uploaded file is not stored after the job; only the
  hash and counts are kept.
- **NFR-2** – Phone numbers are validated but not messaged automatically. The centre chooses when to share
  codes.

## Affected areas

- `app/dashboard/import/**` (new), `app/api/org/import/**` (new), `lib/import/**` (new)
- Uses `lib/children/**`, `lib/children/codes.ts`, the case creation helpers and 043 series (if present)
- `messages/{en,hi,te}.json`, `tests/import-*.test.ts` (new)

## Don't touch

- The consent tables (other than reading them), existing migrations, `BOARD.md`.

## Out of scope

- Importing past session notes, reports or documents. Excel `.xlsx` (CSV only; Excel can save CSV).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Consent | Never imported; start at `none`, use paper or digital consent flows | Rule 1/6 of the decision record |
| D-2 | Messaging | Generate codes and links, don't auto-send | The centre controls first contact |
| D-3 | Format | CSV with a template | Simple, works from Excel or Google Sheets |
