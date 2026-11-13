# 036: Ratings for completed appointments

**Status:** done
**Mode:** solo
**Runs:** waits for 030: only guardians of completed appointments can rate

## Summary

Verified-booking ratings: after an appointment is marked `completed`, the guardian can leave 1-5 stars
and an optional short comment. Profiles show the average once there are enough ratings. Platform admins
moderate. Comments must not expose children's identities.

## Functional requirements

- **FR-1** - Migration `<ts>_ratings.sql`: `ratings(id, appointment_id unique, provider_profile_id,
  guardian_user_id, stars int 1-5, comment text (<= 500) null, status text check in ('published',
  'hidden','pending_review') default 'published', created_at, edited_at, moderated_by, moderation_note)`;
  view `provider_rating_summary(provider_profile_id, rating_avg numeric(2,1), rating_count)` over
  `published` only; 029 `search_providers` fills `rating_avg/count` from it.
- **FR-2** - Eligibility: appointment `completed`, guardian is the booking guardian, within 30 days of
  completion, one rating per appointment (edit allowed within 7 days). Outbox topic
  `appointment.rate_prompt` sent 2 h after completion (in-app + email).
- **FR-3** - `POST /api/appointments/:id/rating` `{ stars, comment? }` -> 201; not eligible -> 403
  `{ error: "You can rate only your completed appointments" }`; duplicate -> 409; `PATCH` within 7 days.
- **FR-4** - Comment screening `lib/ratings/screen.ts`: phone numbers, emails, URLs, and the booked
  child's display name -> rejected with 422 `{ error: "Please remove names and contact details from
  your comment" }`; a small profanity/abuse list -> status `pending_review`.
- **FR-5** - Profile `/p/[slug]`: `4.6 ★ (12 ratings)` shown only when `rating_count >= 3`, else
  `New on DoctorNearMe`; latest 10 published comments with `Verified booking` and month/year only (no
  names). `/family/appointments` shows `Rate this visit` for eligible ones.
- **FR-6** - Admin `/admin/ratings`: `pending_review` queue, `Publish` / `Hide` with note (audit).
  Providers can `Report a rating` (`POST /api/ratings/:id/report` `{ reason }`) -> `pending_review`.

## Non-functional requirements

- **NFR-1** - Ratings are anonymous publicly; guardian identity visible only to platform admins.
- **NFR-2** - Register `ratings` in the 041 privacy registry (deleted with the guardian's account).

## Affected areas

- `supabase/migrations/<ts>_ratings.sql` (new); `lib/ratings/**` (new)
- `app/api/appointments/[id]/rating/route.ts`, `app/api/ratings/**`, `app/admin/ratings/**` (new)
- `app/p/[slug]/**`, `/family/appointments`, `search_providers` (rating columns), `lib/notify/topics.ts`, `messages/*.json`
- `tests/ratings.test.ts` (new)

## Don't touch

- Booking state machine (030), existing migrations, `BOARD.md`

## Out of scope

- Provider replies, rating sub-categories, sorting the directory by rating, incentives.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Who can rate | Booking guardian of a completed appointment | plan §2 ratings kept; prevents fake reviews |
| D-2 | Display threshold | Average shown from 3 ratings | small-sample noise |
| D-3 | Privacy | No names, contact details or child names in comments | child data protection |

## Open questions

None.
