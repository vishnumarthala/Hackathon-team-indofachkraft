# 047: Import existing children from a spreadsheet - Results

Branch: `ticket/047-import-children` (worktree `dnm-worktrees/047`). Tested against the isolated local Supabase stack of
database slot 3 (all migrations re-applied with the new `20261113004700_child_import.sql` by `supabase db reset`),
`DEMO_MODE=true`, dev server on port 3030, headless Chromium at 375 px. Synthetic accounts and data only
(`npm run seed:users -- --prefix e047 --extra-member`: org owner `org_admin_a`, members `provider_a` and
`provider_a2` as the two therapists, `provider_b` in another org, `guardian_a`).

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0 |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (DB suites running, slot 3) | PASS | 91 files, 1530 passed, 11 skipped. The 11 skips are the pre-existing opt-in suites (`intake-completion` needs `CT_DB_TESTS=1`, `no-tracking` live crawl), unchanged by this ticket |
| `npm run build` | PASS | exit 0; `/api/org/import`, `/api/org/import/preview`, `/api/org/import/template`, `/api/org/import/[id]`, `/api/org/import/[id]/undo`, `/api/org/import/[id]/codes`, `/dashboard/import`, `/dashboard/import/[id]` in the route list |
| `npm run verify` | PASS | its four steps above, each exit 0 |
| `npx vitest run tests/import-*.test.ts --reporter=verbose` | PASS | 2 files, 28 passed (22 in the new `tests/import-children.test.ts`, 6 in 042's `import-providers`) |
| - both date formats parse | PASS | `2021-03-14`, `14/03/2021`, `3/4/2020`, `27-09-2022`; `31/02/2021` and `2021/03/14` refused |
| - each row error names the row | PASS | `errors.csv`: every error/warning matches `^Row N: `, e.g. `Row 3: date of birth is in the future`, `Row 4: no therapist with this email in your organisation` |
| - duplicates detected | PASS | `dupes.csv` after `valid-20.csv`: rows 2-3 `duplicate_existing` (same first name + DOB + phone, phone formats differ), row 5 `duplicate_in_file` of row 4; Skip by default, `import_duplicates: [3]` imports row 3 -> imported 2, skipped 2 |
| - re-upload is idempotent | PASS | same file again -> 200 `{ result: "existing" }` with the first import's id, still 20 cases; preview shows `already_imported` |
| - no `consent_records` | PASS | 0 rows for the 20 imported children; `getConsentState` all `granted: false, action: null` |
| - no outbox messages | PASS | 0 `outbox_events` referencing the imported children/cases since the import |
| - undo inside 24 h; refused once a session note exists | PASS | undo -> 200 `{ result: "undone", cases: 2, children: 2 }`, cases/children/codes gone, strict `children.import_undone` audit; a `reports` row `kind = session_note` on row 3 -> 409 `blocked_rows: [3]`, nothing deleted; `undo_until` passed -> 409 `The 24-hour undo window has passed`; a claimed code -> 409 `blocked_rows: [2]` |
| - member (not owner/admin) 403 | PASS | preview/import 403 for members (incl. the assigned therapist); other org / malformed org id / other org's import id 404; guardian 403; anonymous 401 |
| - 500 rows < 30 s | PASS | 500-row import (both therapists, three languages) in 0.19 s; 500 items with codes |
| E-1 happy path | PASS | Browser, 375 px, owner: `/dashboard` has `Import children`; upload `valid-20.csv` -> `20 rows: 20 ready, 0 possible duplicates, 0 with errors`, button `Import 20 children`; import (223 ms) -> `Imported: 20. Skipped: 0. Failed: 0.`, 20 codes (`XXXX-XXXX`) with 20 `https://wa.me/91...` links carrying the 020 claim message; `/dashboard` lists 20 cases; page width stays 375 px |
| E-2 errors | PASS | `errors.csv` -> `9 rows: 3 ready, 0 possible duplicates, 6 with errors`; six plain messages (`Row 3: date of birth is in the future` / `Row 4: no therapist with this email in your organisation` / `Row 5: "12345" is not a 10-digit Indian mobile number` / `Row 7: enter the child's first name` / `Row 8: "31/02/2021" is not a date ...` / `Row 10: preferred language "xx" must be en, hi or te`); button `Import 3 children`; import -> `Imported: 3. Skipped: 0. Failed: 6.` Row 9 (age 16) and row 10 show the `above 8` warning only |
| E-3 consent stays honest | PASS | Result list and import page: `Consent: Not given` for all 20; the imported child's case page consent panel shows 8/8 `Not allowed` + `Not asked yet`; `Record paper consent` opens `/cases/:id/consent/paper` (020 flow, heading `Record paper consent`) |
| FR-3 therapist assignment | PASS | row with `therapist_email` -> that therapist is the only active assignment (`lead`), can open the case (`assigned`); an unassigned member cannot; row without therapist -> importing owner is lead |
| FR-3 claim codes | PASS | 72 h, hash only (`hashClaimCode` matches), guardian claims an imported child with its code (201); `Make new codes` -> 19 new codes for the unclaimed children, older ones invalidated |
| FR-3 audit counts only | PASS | one `children.imported` row: keys `import_id,total_rows,imported,skipped,failed,timetable_pending,series_created`; no names/phones/notes; actor = owner, `org_id` set |
| NFR-1 file not stored | PASS | `child_imports` keeps `file_hash` + counts only; preview writes nothing; >1 MB -> 413 `The file is larger than 1 MB.` |
| Telugu/Hindi names | PASS | `శ్రీజ రెడ్డి`, `ఆరవ్ నాయుడు`, `अनन्या शर्मा` stored exactly; Telugu notes kept; Telugu UI (`స్ప్రెడ్‌షీట్ నుండి పిల్లలను ఇంపోర్ట్ చేయండి`) |
| FR-5 undo via UI | PASS | import page `Undo import` -> `This import was undone on ...`, import rows gone |
| Optional timetable (043 absent) | PASS | `timetable.csv`: valid timetable stored `pending` (`weekdays [1,3,5]`, `10:00`), notice in preview/result; `Mon;Funday`, unknown service, timetable without therapist -> row errors; with a mock scheduler reporting 043 available: one series `scheduled`, the failed one stays `pending` |

## Deviations

- **Weekly series (043) are not on this branch.** The optional `weekdays` / `time` / `service_name` columns are fully
  validated and stored on the import row (`child_import_rows.timetable`, `timetable_status = 'pending'`); the preview,
  result and import page say the timetable is saved and will be scheduled once weekly sessions are switched on. When
  `appointment_series` and `series_materialize` exist, `defaultSeriesScheduler` (`lib/import/timetable.ts`) creates the
  series per 043's FR-1/FR-3/FR-4 inside a savepoint (failures fall back to `pending`). That live path is written
  against 043's spec and covered only with a mock scheduler. Follow-ups after 043 merges: verify columns and
  `billing_mode`, schedule the `pending` timetables of earlier imports, and let undo remove series created by the import
  (their appointments would currently block the undo).
- **Consent wording (E-3).** The import screens show `Not given`; the existing 020 case consent panel (not changed
  here) words the same state as `Not allowed` / `Not asked yet`.
- **`notes` column.** Cases have no notes field and the case pages are outside this ticket's areas, so notes are kept on
  `child_import_rows.notes` (<= 500, provider-only) and shown on the import page; registered in the privacy registry.

## Notes

- Undo is all-or-nothing and generic: it refuses when any table with a foreign key to `cases`/`children` references
  an imported child/case (except care-team assignments, unused codes and import rows) or an intake link was issued, so
  tables added by later tickets are covered automatically.
- The importing owner/admin is not added to the care team when a therapist is given (owners/admins reach every case
  anyway): the therapist's assignment is inserted in the same statement as the case, so 022's after-insert trigger sees
  an active assignment and leaves the team alone.
- Ages: above 8 is a warning (decision 11); 18 or older is refused (children's records). `child_age_months` on the case
  is filled from the date of birth when within the existing 12-216 range.
- Row numbers are spreadsheet row numbers (header = row 1). `;`-delimited CSVs (European Excel) and a UTF-8 BOM are
  accepted; non-UTF-8 files are refused with "Save As > CSV UTF-8".
- New strict audit actions `children.imported` and `children.import_undone` are listed in
  `lib/audit/strict-actions.ts`; `child_imports` is registered in `lib/privacy/registry.ts` (docs/privacy/retention.md).
- i18n: new `childImport.*` keys in en/hi/te (hi/te drafted by this worker, `pending` in `messages/REVIEW.md`).
- Docs: `docs/import-children.md`, `docs/system-design.md` (data model + API table).
- Acceptance script and 375 px screenshots are in the session folder (`files/e2e047/`), not in the repo.
