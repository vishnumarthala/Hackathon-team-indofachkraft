# 023: Document vault

**Status:** draft
**Mode:** solo
**Runs:** waits for 022: uses case access, guardian links and the sharing registry (`documents` scope)

## Summary

A private, per-child document store: guardians upload prior reports, school letters and prescriptions;
providers attach documents to a case and choose whether the guardian sees them. Uploads use signed
upload URLs into a private bucket; every download is authorised server-side and served through a
short-lived signed URL. Documents reach another organisation only via a `documents` sharing grant (022).

## Functional requirements

- **FR-1** - Migration `<ts>_documents.sql`: private storage bucket `documents` (file size limit 20 MB);
  table `documents(id, child_id -> children, case_id null -> cases, org_id null -> organizations,
  uploaded_by -> auth.users, uploader_kind text check in ('guardian','provider'), category text check in
  ('prior_report','prescription','school','medical','assessment','consent_form','other'), title (1-120),
  file_name (<= 200), mime_type, size_bytes, storage_path unique, sha256 text null, status text check in
  ('pending','ready','deleted') default 'pending', visible_to_guardian boolean not null default true,
  created_at, deleted_at, deleted_by)`; `document_org_shares(document_id, org_id, shared_by, created_at,
  revoked_at)` for guardian-uploaded documents. Storage path `<child_id>/<document_id>.<ext>`.
- **FR-2** - Allowed types: `application/pdf`, `image/jpeg`, `image/png`, `image/heic`; extension must
  match the MIME type; > 20 MB -> 413 `{ error: "Files can be up to 20 MB" }`; other type -> 415
  `{ error: "Upload a PDF, JPG, PNG or HEIC file" }`. Magic-byte check on completion; mismatch -> document
  `deleted`, object removed, 422 `{ error: "This file does not match its type" }`.
- **FR-3** - Upload API (two steps, both authz-checked):
  - Guardian: `POST /api/family/children/:id/documents` `{ title, category, file_name, mime_type,
    size_bytes, share_with_org_ids?: uuid[] }` -> 201 `{ document_id, signed_upload_url, token, path }`;
    `share_with_org_ids` must be orgs with a case for the child (422 otherwise).
  - Provider: `POST /api/cases/:id/documents` `{ title, category, file_name, mime_type, size_bytes,
    visible_to_guardian }` (017 `requireCaseAccess`) -> 201 same shape; `org_id = cases.org_id`.
  - Both: `POST /api/documents/:docId/complete` -> 200 `{ document }` (verifies object exists, size,
    magic bytes, computes sha256, sets `ready`). Uploads not completed within 1 h are cleaned by the
    retention job (041) - until 041 ships, `status = 'pending'` rows are never listed.
- **FR-4** - Who can read a `ready` document (`lib/documents/access.ts`, single function used by every route):
  guardian with an active link to the child, if `uploader_kind = 'guardian'` or `visible_to_guardian`;
  provider with case access to `case_id` (provider-uploaded) or whose org is in `document_org_shares`
  (guardian-uploaded); provider in an org holding a `documents` sharing grant whose `source_org_id` =
  document `org_id` (read-only, via `requireSharedAccess`). Everyone else -> 404.
- **FR-5** - `GET /api/documents/:docId/download` -> 302 to a signed URL valid 300 s with
  `download=<file_name>`; responses carry `Cache-Control: no-store`. Audit `document.downloaded` (strict).
  `GET /api/documents/:docId` -> 200 `{ document }` metadata.
- **FR-6** - Delete: `DELETE /api/documents/:docId` - only the uploader, or org owner/admin for
  provider uploads -> soft delete (`status = 'deleted'`, storage object removed immediately), 200
  `{ deleted: true }`; audit `document.deleted`. Guardians cannot delete provider documents.
- **FR-7** - Guardian UI `/family/documents` (all children) and `/family/children/[id]/documents`: list
  (title, category, date, uploaded by `You` / `<org name>`), `Upload document` dialog (fields `Title`,
  `Category`, `File`, `Share with` org checkboxes), `Download`, `Delete` (own uploads), and per-document
  `Sharing` to add/revoke org shares.
- **FR-8** - Provider UI: case workspace `Documents` tab with the case's documents, guardian documents
  shared with the org, an `Upload` dialog with checkbox `Parent can see this document` (default on), and
  shared documents from other orgs under `Shared with us` (registry scope `documents`, 022).
- **FR-9** - Notifications: when a provider uploads a guardian-visible document, emit outbox event
  `document.shared_with_guardian` if 032 is merged (no document title in WhatsApp/email body).

## Non-functional requirements

- **NFR-1** - The bucket is private; no public URLs; signed URLs only after FR-4 passes; no signed URL
  is logged.
- **NFR-2** - Upload from a 375 px phone camera (`accept="application/pdf,image/*" capture` allowed).
- **NFR-3** - Translated (en/hi/te).

## Affected areas

- `supabase/migrations/<ts>_documents.sql` (new)
- `lib/documents/**` (new), `lib/sharing/registry.ts` (register `documents`)
- `app/api/family/children/[id]/documents/route.ts`, `app/api/cases/[id]/documents/route.ts`,
  `app/api/documents/[docId]/**` (new)
- `app/family/documents/**`, `app/family/children/[id]/documents/**`, case workspace `Documents` tab (new)
- `messages/*.json`; `tests/documents-access.test.ts`, `tests/documents-upload.test.ts` (new)

## Don't touch

- `recordings` bucket and session upload flow, consent (020), existing migrations, `BOARD.md`

## Out of scope

- Virus scanning (open question), OCR, AI summarisation of documents, versioning of the same document,
  folders, bulk download (export is 041).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Feature kept | Document vault | plan §2 "Old DRnME features kept" |
| D-2 | Storage | Private Supabase bucket, signed URLs (5 min) | rule 3 signed URL authz |
| D-3 | Cross-org | Guardian per-document shares or `documents` grant | rule 2 |
| D-4 | Download audit | Strict (fails closed) | rule 7 |

## Open questions

- Malware scanning for uploaded files before providers open them (ClamAV/function) - needed before a
  wider rollout; not in MVP.
