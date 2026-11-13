# Ratings for completed appointments (ticket 036)

Verified-booking ratings: after an appointment is `completed` (030), its booking guardian can give 1-5 stars and an
optional short comment. Public pages show only the aggregate (from 3 ratings) and approved comment text with
`Verified booking` and the month/year. Platform admins moderate; providers can report a rating.

Code: `lib/ratings/**` (`rules.ts` pure rules and constants, `screen.ts` comment screening, `display.ts` threshold and
month/year, `store.ts` data access, `authz.ts` gates, `recipients.ts` notification recipients, `schemas.ts`),
`app/api/appointments/[id]/rating`, `app/api/ratings/[id]/report`, `app/api/admin/ratings/[id]`,
`app/family/(portal)/appointments/[id]/rate`, `app/dashboard/ratings`, `app/admin/ratings`, `components/ratings/**`.
Migration: `supabase/migrations/20261113003600_ratings.sql`. Tests: `tests/ratings.test.ts`.

## Data model

| Object | What |
|---|---|
| `ratings` | `appointment_id` (unique, cascade), `provider_profile_id`, `guardian_user_id` (FK to `auth.users`, **on delete cascade**: deleted with the guardian's account), `stars` 1-5, `comment` 1-500 or null, `status` `published` (default) / `pending_review` / `hidden`, `created_at`, `edited_at`, `moderated_by`, `moderated_at`, `moderation_note`, `review_reason` (`abuse_screen` / `provider_report`: why it is or last was in review), `reported_by`, `reported_at`, `report_reason`. |
| `provider_rating_summary` (view) | `provider_profile_id`, `rating_avg numeric(2,1)`, `rating_count` over `published` ratings only. Service role only. |
| `appointment_completed_at(id)` | Completion time = the `completed` row in 030's `appointment_events` (append-only). |
| trigger `ratings_check_appointment` | Defence in depth: a rating can only be inserted for a `completed` appointment of the same guardian and provider (`rating_not_eligible`); the links never change. |
| trigger `appointments_rate_prompt` | When an appointment becomes `completed`, enqueues `appointment.rate_prompt` (dedup `appt:<id>:rate_prompt`, `deliver_after = now() + 2 h`) in the completing transaction. 030's functions are unchanged. |
| `search_providers` (029) | Now returns `rating_avg` (only when there are >= 3 published ratings, else null) and `rating_count` (published count, 0 when none). |

RLS is on; guardians may read their own rows; everything else goes through the server (service role), which gates every
route.

## Rules (`lib/ratings/rules.ts`)

- **Who / when (D-1):** status `completed`, caller is the booking guardian, within **30 days** of completion, **one**
  rating per appointment (unique constraint; concurrent duplicates -> one 201, the rest 409).
- **Edits:** `PATCH` within **7 days** of rating; a rating hidden by an admin cannot be changed (409). The comment is
  screened again. A rating in review because the provider reported it stays in review after an edit; one held for
  abuse words is published once the text is clean.
- **Display (D-2):** `4.6 ★ (12 ratings)` from **3** published ratings, else `New on DoctorNearMe`
  (`ratingBadge()`). Comments: the latest **10** published ones, text + `Verified booking` + month/year (no names, no
  per-comment stars, no visit details). Directory cards (`/find`) show the average when `search_providers` returns one.

## Comment screening (`lib/ratings/screen.ts`, D-3)

| Match | Result |
|---|---|
| Phone numbers (7+ digits with separators, any script's digits), emails (incl. `[at]`/`(dot)`), `@handles`, links (`http`, `www.`, `name.tld`) | 422 `Please remove names and contact details from your comment`, nothing saved |
| Any part of the booked child's display name, or of the guardian's other linked children (whole words, Unicode-aware incl. Devanagari/Telugu; generic tokens such as `child`, `synthetic` ignored) | 422, same message |
| Small profanity/abuse list (English, Hindi/Telugu in Latin and native script) | saved as `pending_review` (`review_reason = abuse_screen`), not public until an admin publishes it |

The lists are a first pass and need native review together with `messages/REVIEW.md`; moderation catches the rest.
Names are never stored or logged by the screen.

## APIs

| Method + path | Who | Body | Responses |
|---|---|---|---|
| `POST /api/appointments/:id/rating` | booking guardian | `{ stars: 1-5, comment?: string \| null }` | 201 `{ rating }`; 401; 403 `{ error: "You can rate only your completed appointments" }` (not completed, other guardian's, unknown id, outside 30 days, not a guardian); 409 `You already rated this visit`; 422 screening; 400 field errors |
| `PATCH /api/appointments/:id/rating` | booking guardian | `{ stars?, comment? }` | 200 `{ rating }`; 403 not eligible / `Ratings can be changed only within 7 days`; 409 `This rating can no longer be changed` (hidden); 422 |
| `POST /api/ratings/:id/report` | provider side (profile owner, or active owner/admin of the appointment's org) | `{ reason: 3-500 }` | 200 `{ rating: { id, status: "pending_review" } }` (idempotent while in review); 403 guardians; 404 other providers' / unknown ids; 409 already hidden |
| `POST /api/admin/ratings/:id` | platform admin | `{ action: "publish" \| "hide", note? }` (note >= 3 chars required to hide) | 200 `{ rating: { id, status } }`; 400; 403 everyone else; 404 |

Every write runs in one transaction with its audit row (`rating.created`, `rating.updated`, `rating.reported`,
`rating.moderated`; strict, `lib/audit/strict-actions.ts`): a failed audit write saves nothing (503). Audit details
carry stars/status/flags only, never comment text or notes.

## UI

- `/p/<slug>`: rating badge under the verified badge; `Ratings` section at the end with the comments.
- `/family/appointments`: `Rate this visit` on completed visits that can still be rated; `You rated this visit N ★`
  (+ `Waiting for review` / `Hidden by DoctorNearMe`, `Change rating` within 7 days) otherwise.
- `/family/appointments/<id>/rate`: radio group of 1-5 stars, comment with hint and counter, translated errors.
- `/dashboard/ratings` (header link `Ratings`): the provider's published ratings (month/year only) with
  `Report a rating`, and those they reported (`Reported - under review`).
- `/admin/ratings` (platform admin; others 404; in `AdminNav` and the provider header for admins): tabs
  `Waiting for review` (count) / `Published` / `Hidden`, the guardian's name and email (NFR-1: admins only), report
  reason, last note, `Publish` / `Hide` with a note.

## Notifications

`appointment.rate_prompt` (in-app + email, no WhatsApp template): `How was your visit?` / `Rate your visit with
<provider>. Your rating is shown without your name.`, link `/family/appointments/<id>/rate`. Recipients are re-checked
at fan-out: the booking guardian only while the appointment is completed, unrated and inside the 30-day window.

## Privacy (NFR-1, NFR-2)

Public and provider views never include the guardian (no name, id, or exact date). Registry category `ratings`
(`lib/privacy/registry.ts`, before `appointments`): export = the requesting guardian's ratings of the child's
appointments; erasure `everything` deletes the ratings of the child's appointments; account deletion cascades. Listed
in the privacy notice (`collect.ratings`, `retention.ratings`) and `docs/privacy/retention.md`.

## Open questions

- Native review of the abuse list and Hindi/Telugu strings.
- Whether providers should get a notification when a rating is published, and whether admins should be notified of
  reports (now: queue count on `/admin/ratings`).
