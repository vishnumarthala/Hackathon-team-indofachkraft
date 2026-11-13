# 023: Document vault - Results

Branch: `ticket/023-document-vault` (base: 017-020, 022, 028, 029 merged; local `main` with 032 and then 021 merged in afterwards, see the merge sections at the end). Tested against the local Supabase
stack of slot 6 (all migrations applied by `supabase db reset`), `DEMO_MODE=true`, dev server on port 3060.
Acceptance script and UI check (isolated headless Chrome via `playwright-core`, own cookie jar) live in the
git-ignored `.tmp/`; their output is in `evidence/`. Synthetic accounts (`seed:users --prefix d023`), child
`Asha (synthetic d023)` and synthetic files (1-page PDF, 1x1 PNG, 21 MB file, `.txt`, PNG bytes named
`.pdf`) only.

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002300_documents.sql` | PASS | private bucket `documents` (20 MB, PDF/JPEG/PNG/HEIC), `documents` (checks: category, title 1-120, file name <= 200, type, size, guardian vs provider ownership, deleted <-> `deleted_at`), `document_org_shares` (one active share per doc/org), access rule `document_access` + `case_documents` + `can_read_document` (RLS), security-definer writes with audit in the same transaction (`create_document`, `complete_document`, `reject_document`, `delete_document`, `set_document_visibility`, `share_document`, `unshare_document`, `log_document_download`); all service-role only. `db reset` applies cleanly |
| `npm run lint`, `npm run typecheck`, `npx vitest run`, `npm run build` (after the 032 merge, `db reset`) | PASS | all exit 0; vitest 59 files, 850 passed, 10 skipped (the pre-existing opt-in `CT_DB_TESTS=1` suite, which needs `.env.local`); every DB suite ran against the slot-6 database. Before the merge: `npm run verify` exit 0, 56 files, 785 passed, 10 skipped |
| `npx vitest run tests/documents-access.test.ts tests/documents-upload.test.ts --reporter=verbose` | PASS | 33 passed, 0 skipped (`evidence/vitest-023-verbose.txt`, with notify-templates/sharing/guardian/case-access/i18n suites: 7 files, 150 passed). FR-4 matrix {linked guardian, second linked guardian, other family, org A owner, assigned member, unassigned member, org B without grant, other org} x {family upload shared with A, family upload not shared, provider upload visible, provider upload hidden}; grant / wrong-scope grant / revoked grant; shares by a guardian who left; deleted documents; size/type/extension/magic-byte rejections (incl. HEIC/AVIF sniffing); bucket refuses > 20 MB on the actual PUT; strict audit failures -> 503 and no signed URL / upload stays pending; RLS; static scan: every `app/api/documents/**` handler calls `requireDocumentAccess` / `requirePendingUpload` first |
| E-1 guardian upload and share | PASS | `guardian_a` uploads `d023 School letter` (School, shared with org A): 201 `{ document_id, signed_upload_url, token, path }`, PUT, `complete` 200 `ready` + sha256; listed as `Uploaded by You`, `Shared with: d023 Centre A`. `provider_a` sees it in the case `Documents` tab; download 302, `Cache-Control: no-store`, signed URL `exp - iat = 300`, `download=letter.pdf`, serves the bytes as attachment; a signed URL past its expiry is refused by storage (400 `InvalidJWT`, 1 s TTL stand-in for 5 min); audit `document.downloaded`. `provider_b`: not listed, download 404; unassigned `provider_a2` 404 (`evidence/acceptance.txt`) |
| E-2 provider upload visibility | PASS | `provider_a` uploads a PNG with `Parent can see this document` unticked: not on the guardian page or family API, guardian download 404; `PATCH visible_to_guardian: true` -> guardian sees it (`Uploaded by d023 Centre A`) and downloads (302); guardian PATCH 403. Re-checked after the 032 merge. Browser: provider uploads with the box unticked -> `Parent cannot see this`, `Show to parent` toggles it (`evidence/ui.txt`, `provider-upload-dialog.png`, `provider-documents-tab.png`) |
| FR-9 notification (outbox, after the 032 merge) | PASS | the `PATCH` (and a guardian-visible provider upload) writes one `document.shared_with_guardian` outbox event in the same transaction (payload `{ document_id, child_id }` only); `drainSoon` delivers it right after the response: `guardian_a` gets `in_app:sent` + `email:sent` (DEMO_MODE), no WhatsApp row; title/body `New document` / `Your child's care team shared a document with you.`, link `/family/documents` (no document title, no child name); listed by `GET /api/notifications` and on `/family/notifications` with the bell `Notifications, <n> unread` (`family-notifications-en-375.png`); family uploads enqueue nothing. Tests: a forced outbox-insert failure -> `complete` 503, document stays `pending`, no audit row; fan-out to both linked guardians (in-app + email); recipients re-checked at fan-out (hidden document, other child, family upload, guardian who left -> excluded); hiding/showing again does not notify twice |
| E-3 validation | PASS | 21 MB -> 413 `Files can be up to 20 MB`; `.txt` -> 415 `Upload a PDF, JPG, PNG or HEIC file`; PDF-named PNG bytes -> 422 `This file does not match its type`, row `deleted`, no object in `storage.objects`. Same messages in the dialog (`family-upload-mismatch-en-375.png`) |
| E-4 cross-org via grant | PASS | grant org A -> org B `documents`: `provider_b` sees org A's provider documents under `Shared with us` (`provider-b-shared-with-us.png`), download 302 (audit `access: grant`, `grant_id`), DELETE 403 (read only), shared item page (registry scope `documents`) 200 with the download link; the family upload shared only with org A stays hidden (404). Revoke -> download 404, shared item 404 |
| E-5 delete | PASS | `guardian_a` deletes own upload: 200 `{ deleted: true }`, object gone from storage, listed nowhere (family page, org A tab, org B tab), audit `document.deleted` (actor `parent`). `guardian_a` DELETE on a provider document -> 403; another family 404 |
| E-6 private bucket | PASS | anonymous `GET <SUPABASE_URL>/storage/v1/object/public/documents/<path>` -> 400 (`Bucket not found` for public access); `/object/authenticated/...` with the anon key refused; anonymous `/api/documents/:id/download` -> 401 |
| NFR-1 no signed URL logged | PASS | dev-server log during the acceptance run shows only route paths and statuses; download failures log ids only (code review of `lib/documents/store.ts`) |
| NFR-2 375 px | PASS | headless Chrome 375 px: upload dialog with PDF through the real browser flow (signed upload from the browser under the family CSP, no console errors), no horizontal scroll (`family-upload-dialog-en-375.png`, `family-child-documents-en-375.png`); file input `accept="application/pdf,image/*"` |
| NFR-3 translated | PASS | `documents.*` and `caseTabs.documents` in en/hi/te, `messages/REVIEW.md` regenerated, `tests/i18n-keys.test.ts` green; Telugu `/family/documents` (`family-documents-te-375.png`), Hindi case tab |

## Deviations

- **Share loader body:** `docs/sharing.md` describes file items as "a short-lived signed URL". The `documents`
  loader returns `/api/documents/<id>/download` instead, so every open re-checks access and writes the strict
  `document.downloaded` row before a 300 s URL is minted (no signed URL in rendered HTML). `docs/sharing.md`
  updated.
- **`capture` attribute (NFR-2):** not set. `capture` makes most phones open the camera only, which blocks
  picking an existing PDF; `accept="application/pdf,image/*"` still offers the camera on Android and iOS.
- **FR-9 channels:** in-app + email only (no WhatsApp) for `document.shared_with_guardian`, as requested when
  wiring the outbox; 032 had registered the topic with WhatsApp too. The `document_shared` Meta template stays
  listed in `docs/notifications.md` but is marked unused.
- **Browser screenshots:** taken with an isolated headless Chrome (`playwright-core` in `.tmp/`, not a project
  dependency) because the shared integrated browser's `localhost` cookies collide with other workers' dev
  servers on other ports.

## Notes

- **Decisions:** a `documents` grant shares all `ready` provider uploads of the source org for the child,
  including ones hidden from the parent (the grant shares the organisation's records, like 022 `reports`);
  guardian uploads are shared only per document. Any linked guardian may share/unshare a family upload; only
  the uploader deletes it. A per-document share (like a grant) counts only while the guardian who made it is
  still linked. Providers of the case (owner/admin or assigned) switch `visible_to_guardian`; only the
  uploader or an org owner/admin deletes a provider upload. `PATCH /api/documents/:docId` was added for E-2.
- **Consent:** uploading/serving documents sends nothing to an external processor, so no 020 consent feature
  gates it. A future AI feature over documents (OCR, summaries) must add one.
- **Audit:** `document.uploaded`, `document.rejected`, `document.visibility_changed`, `document.shared`,
  `document.share_revoked`, `document.deleted`, `document.downloaded`; all strict (same transaction). No titles
  or file names in audit details or notifications.
- **For 041 (retention):** delete `pending` rows older than 1 h with their objects; sweep objects whose row is
  `deleted` (an upload token stays valid for 2 h, so an object can reappear at a rejected path; it is never
  served); remove storage objects before cascading row deletes (children/cases -> documents). Export should
  include `documents` + `document_org_shares`.
- **Open question kept:** malware scanning before providers open uploaded files.
- **Evidence runs** re-use the `d023` accounts; each acceptance run adds a new synthetic child, so the Telugu
  screenshot lists several `Asha (synthetic d023)` children.
- No new env vars. Helpers for later tickets: `lib/documents/access.ts` (`requireDocumentAccess`,
  `getDocumentAccess`), `lib/documents/store.ts`, `components/documents/*`, test helper
  `tests/helpers/documents.ts`. Full reference: `docs/documents.md`.

## Merge with main (032 notifications outbox)

- `git merge main` (032 merged). Conflicts: `lib/notify/topics.ts` (kept 032's registry; `DOCUMENT_TOPICS`
  kept as a registry-typed constant; the `notifyLater` stub is gone) and `messages/REVIEW.md` (regenerated with
  `npx tsx scripts/i18n-review.ts`, 1085 rows). `messages/*.json`, `docs/sharing.md`, `docs/system-design.md`,
  `tests/sharing-grants.test.ts` auto-merged with both sides kept.
- `notifyLater()` replaced: `complete_document` and `set_document_visibility` (migration
  `20261113002300_documents.sql`, not yet on `main`, so edited in place) call `document_notify_guardians`, which
  runs `public.outbox_enqueue('document.shared_with_guardian', 'document', id, { document_id, child_id },
  'document:<id>:shared_with_guardian')` in the same transaction; plpgsql resolves the function at call time,
  so applying 0023 before 032's 0032 migration is fine. `lib/documents/store.ts` calls `drainSoon([eventId])`.
  Topic `document.shared_with_guardian`: channels in-app + email; recipients `visibleDocumentGuardians`
  (new in `lib/notify/recipients.ts`). `grep notifyLater` finds nothing outside `specs/`.
- `supabase db reset` on slot 6, then lint / typecheck / vitest / build (row above), acceptance re-run
  (`evidence/acceptance.txt`, 55 PASS, 0 FAIL, incl. E-2 and FR-9) and headless UI re-run (`evidence/ui.txt`,
  13 PASS).
- Local dev note: after `npm run build` in the same worktree, a stale `.next` made `next dev` reload every page in
  a loop (HMR "rebuilding" on connect, even on `/find`); deleting `.next` fixed it. Not a code issue.

## Merge with main (021 health profile, `b6b331d`)

- `git merge main`. Conflicts resolved keeping both sides: `lib/sharing/registry.ts` (both loaders:
  `health_profile` and `documents`), `tests/sharing-grants.test.ts` (expects `reports`, `health_profile`,
  `documents`), `app/family/(portal)/children/[id]/page.tsx` (`Care team`, `Documents` and `Health` links),
  `docs/sharing.md`, `docs/system-design.md` (both sections, API rows and doc lists), `messages/{en,hi,te}.json`
  (deep-merged; `caseTabs` has `health` and `documents`), `messages/REVIEW.md` regenerated (1156 rows).
- `supabase db reset` on slot 6, then with the slot env: `npm run lint` exit 0, `npm run typecheck` exit 0,
  `npx vitest run` 60 files, 870 passed, 10 skipped (only the opt-in `CT_DB_TESTS=1` suite; every other DB
  suite ran, incl. documents, sharing and health profile), `npm run build` exit 0.
