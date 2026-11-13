# Document vault (ticket 023)

A private, per-child document store. Guardians upload prior reports, school letters and prescriptions and
choose which treating organisations see each one; providers attach documents to a case and choose whether
the guardian sees them. Design rules 2, 3 and 7 of `specs/grill/doctornearme-mvp.md`. Read this before
adding a feature that stores or serves files about a child.

## Model (`supabase/migrations/20261113002300_documents.sql`)

| Object | What |
|---|---|
| bucket `documents` | **Private**, 20 MB limit, `application/pdf`, `image/jpeg`, `image/png`, `image/heic`. Object path `<child_id>/<document_id>.<ext>`. No storage policies: only the service role touches objects. |
| `documents` | `child_id`, `case_id`/`org_id` (provider uploads only), `uploaded_by`, `uploader_kind` (`guardian` \| `provider`), `category` (`prior_report`, `prescription`, `school`, `medical`, `assessment`, `consent_form`, `other`), `title` (1-120), `file_name` (<= 200, cleaned), `mime_type`, `size_bytes`, `storage_path` (unique), `sha256`, `status` (`pending` -> `ready` \| `deleted`), `visible_to_guardian` (always true for guardian uploads), `created_at`, `completed_at`, `deleted_at`, `deleted_by`. |
| `document_org_shares` | Per-document shares of **guardian** uploads with a treating organisation (`shared_by`, `revoked_at`). One active share per (document, org). A share counts only while the guardian who made it is still linked to the child (fail closed, like 022 grants). |

## Who can read a document (FR-4)

One SQL function, `document_access(user, document)`, used by `lib/documents/access.ts`, every route, the
case list (`case_documents`) and RLS (`can_read_document`). Only `ready` documents; everything else 404.

| Path | Who | Can |
|---|---|---|
| `guardian` | active guardian link to the (live) child, and the document is a family upload or `visible_to_guardian` | read; delete own uploads; share/unshare family uploads |
| `case` | provider upload, and the user can access its case (022 `case_access_level`: owner/admin or assigned) | read; change `visible_to_guardian`; delete if uploader or owner/admin of the org |
| `org_share` | family upload shared with an org in which the user can access a case of the child | read only |
| `grant` | provider upload, and the user's org holds a `documents` sharing grant from the document's org (022) | read only |

Guardians never delete provider documents (403). A reader who may not change something gets 403; anyone
who may not read it gets 404. Pending uploads are never listed (the retention job of ticket 041 removes
uploads not completed within 1 h).

## API

| Route | Gate | Body | Response |
|---|---|---|---|
| `GET /api/family/children/:id/documents` | `requireGuardian` + `requireChildGuardian` | - | `{ documents }` (family uploads + visible provider uploads) |
| `POST /api/family/children/:id/documents` | same | `{ title, category, file_name, mime_type, size_bytes, share_with_org_ids?: uuid[] }` | 201 `{ document_id, signed_upload_url, token, path }`; 422 `This organisation is not treating your child` |
| `POST /api/family/children/:id/documents/:docId/shares` | same + guardian path | `{ org_id }` | 201 `{ shared: true }`; 422 org not treating; 403 provider document |
| `DELETE /api/family/children/:id/documents/:docId/shares/:orgId` | same | - | 200 `{ revoked: true }` |
| `GET /api/cases/:id/documents` | `requireCaseActor` | - | `{ documents }` (case uploads + family uploads shared with the org) |
| `POST /api/cases/:id/documents` | `requireCaseActor` (`org_id = cases.org_id`) | `{ title, category, file_name, mime_type, size_bytes, visible_to_guardian }` | 201 same shape as the guardian upload |
| `POST /api/documents/:docId/complete` | `requirePendingUpload` (uploader, still linked / still on the case) | - | 200 `{ document }` |
| `GET /api/documents/:docId` | `requireDocumentAccess` | - | 200 `{ document }` (never the storage path), `Cache-Control: no-store` |
| `PATCH /api/documents/:docId` | `requireDocumentAccess` + `can_edit` | `{ visible_to_guardian }` | 200 `{ document }` |
| `DELETE /api/documents/:docId` | `requireDocumentAccess` + `can_delete` | - | 200 `{ deleted: true }` (soft delete, object removed now) |
| `GET /api/documents/:docId/download` | `requireDocumentAccess` | - | 302 to a 300 s signed URL with `download=<file_name>`, `Cache-Control: no-store` |

File checks (FR-2, `lib/documents/constants.ts` + `magic.ts`): type not allowed or extension not matching
the type -> 415 `Upload a PDF, JPG, PNG or HEIC file`; more than 20 MB -> 413 `Files can be up to 20 MB`
(the bucket enforces the limit again on the actual upload). On `complete` the server downloads the object,
checks the first bytes (`%PDF-`, JPEG `FF D8 FF`, PNG signature, ISO BMFF `ftyp` with a HEIC brand; AVIF
is refused), stores the real size and the sha256. A mismatch marks the document `deleted`, removes the
object and answers 422 `This file does not match its type`. The upload dialog declares HEIC from the file
extension when the browser reports an empty type or `image/heif`.

## Audit (all written in the same transaction as the change; strict)

`document.uploaded` (complete), `document.rejected` (magic-byte/size failure), `document.visibility_changed`,
`document.shared`, `document.share_revoked`, `document.deleted`, `document.downloaded`
(`{ child_id, org_id, access, grant_id }`). The download row is written by `log_document_download`, which
re-checks access in the same call; if the row cannot be written there is no signed URL (503). Titles and
file names are never put in audit details or notifications. Signed URLs are never logged.

## Sharing with other organisations

- Family uploads: per document, `Share with` in the upload dialog or `Sharing` on the list.
- Provider uploads: only through a guardian's 022 `documents` sharing grant. The share loader
  `lib/sharing/loaders/documents.ts` lists the source orgs' `ready` provider uploads for the child (also those
  hidden from the parent: the grant shares the organisation's records). Its `get` returns
  `{ kind: "file", url: "/api/documents/<id>/download" }`: the link goes through the download route (access
  re-check + `document.downloaded`), never a pre-minted signed URL in the page.

## Notifications (FR-9)

`document.shared_with_guardian` is a transactional outbox event (ticket 032, `docs/notifications.md`): the
database functions `complete_document` (provider upload with `visible_to_guardian`) and
`set_document_visibility` (switch to visible) call `document_notify_guardians`, which runs
`public.outbox_enqueue(...)` in the same transaction as the change (if the event cannot be written, nothing is
saved). Payload `{ document_id, child_id }` only; dedup key `document:<id>:shared_with_guardian`, so a
document notifies at most once (hiding and showing it again does not repeat). The route then calls
`drainSoon([eventId])`; the cron delivers it otherwise. At fan-out the recipients are re-checked
(`visibleDocumentGuardians` in `lib/notify/recipients.ts`): active guardians of the live child, and only while
the document is still a `ready`, guardian-visible provider upload of that child. Channels: in-app + email (no
WhatsApp). Template `document_shared`: "Your child's care team shared a document with you." with a link to
`/family/documents`: no title, no clinical content, no child name. Family uploads notify nobody.

## UI

- Guardian: `/family/documents` (all children, one section each) and `/family/children/[id]/documents`
  (linked from the child page): list (title, category, date, `Uploaded by You` / `Your family` / org name),
  `Upload document` dialog (`Title`, `Category`, `File` with `accept="application/pdf,image/*"` so phone
  cameras work, `Share with` checkboxes), `Download`, `Delete` (own uploads), `Sharing`.
- Provider: case workspace `Documents` tab (`app/cases/[id]/documents`): the case's documents and family
  uploads shared with the org, `Upload` dialog with `Parent can see this document` (default on),
  `Show to parent` / `Hide from parent`, `Delete`, and `Shared with us` (documents from other orgs through a
  grant; opens the 022 shared item page).
- Components: `components/documents/*` (`UploadDocumentDialog`, `DocumentList`, `uploadFlow.ts`).

## Not in this ticket

Virus scanning (open question: needed before a wider rollout), OCR, AI summaries, versions, folders, bulk
export (041). The retention job (041) must delete `pending` rows older than 1 h with their objects, and
objects of `deleted` rows that could not be removed. Row deletion (cases, children) cascades to
`documents`; 041 must remove the storage objects first.

## Tests

`tests/documents-upload.test.ts` (validation, magic bytes, upload flow, bucket limits, strict audit on
complete) and `tests/documents-access.test.ts` (FR-4 matrix, downloads, strict download audit, deletes,
visibility, guardian shares, grants, loader, RLS, public bucket URL, static gate scan of
`app/api/documents/**`). Helpers: `tests/helpers/documents.ts` (synthetic files, three-step upload through
the routes, object cleanup).
