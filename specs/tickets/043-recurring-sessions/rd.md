# 043: Recurring therapy sessions (weekly series)

**Status:** done
**Mode:** solo
**Runs:** alongside (builds on 030, which is done)

## Summary

Early intervention is 2–4 sessions a week for months. Today only one-off appointments exist (030), so after
the first visit the timetable leaves the app and the family's "Visits" tab goes empty. This ticket lets
centre staff put an enrolled child on a **weekly series** (for example Mon/Wed/Fri 10:00 with the speech
therapist). The series creates real `appointments` rows on a rolling horizon, so the existing exclusion
constraint, reminders, the parent's Visits tab and the provider agenda all work unchanged.

Source: [PMF check](../../grill/doctornearme-pmf-check.md) §3c; product owner decision 2026-11-13 (Q3 "yes").

## Functional requirements

- **FR-1** – Migration `<ts>_appointment_series.sql`:
  `appointment_series(id, org_id, provider_profile_id, service_id, child_id, case_id null,
  guardian_user_id null, weekdays smallint[] (0–6, 1–4 entries), start_time time, time_zone text,
  starts_on date, ends_on date null, status check in ('active','paused','ended'), billing_mode check in
  ('package','per_session','free'), created_by, created_at, updated_at)`.
  Add `appointments.series_id null` (FK) and `appointments.series_occurrence_date date null`, with a unique
  constraint `(series_id, series_occurrence_date)`. Register both tables in the 041 privacy registry.
- **FR-2** – Only org `owner`/`admin`, or the provider who owns the profile, can create, edit, pause or
  end a series. The child must have an active case in that org (rule 2), and the service must be
  `in_clinic` or `video` from the same org. `guardian_user_id` is optional: children whose families only
  gave paper consent (no app account) can still have a timetable.
- **FR-3** – SQL function `series_materialize(series_id, until date)` (security definer, idempotent).
  It creates `confirmed` appointments for each occurrence up to `until`, using the service snapshot
  (rule 11), and skips dates that already exist. An occurrence that clashes with the exclusion constraint,
  an availability override, or a slot outside the weekly hours is **not created**. Instead it is recorded
  in `series_conflicts(series_id, occurrence_date, reason check in ('slot_taken','blocked_date',
  'outside_hours'), resolved_at null)`. Occurrences never go through `held`/`pending_payment`; payment is
  handled by `billing_mode` (045/046).
- **FR-4** – Rolling horizon: the existing booking cron (`/api/cron/booking`) calls `series_materialize`
  for active series up to **8 weeks** ahead. Creating a series materializes immediately.
- **FR-5** – Editing:
  - **"This session only"** reschedules or cancels one occurrence through the 030 functions.
  - **"This and future sessions"** ends the current series the day before and creates a new series. It
    also cancels future, untouched occurrences of the old series (reason `series_changed`).
  - **Pause** cancels future occurrences in a date range (reason `series_paused`).
  - **End** cancels all occurrences after `ends_on`.
  - Past occurrences are never changed.
- **FR-6** – Provider UI:
  - The child's case page gets a `Timetable` card (new series form: therapist, service, weekdays, time,
    start date, optional end date, billing mode).
  - `/dashboard/schedule` shows series occurrences with a "repeats" marker, and a `Conflicts` list with
    `Pick another time` / `Skip this date`.
- **FR-7** – Family UI: `/family/appointments` shows the upcoming occurrences, grouped by week, with
  "Every Mon, Wed, Fri at 10:00 with <therapist>". Guardians may cancel a single occurrence under the
  org's cancellation window (reuse 030 rules); they cannot edit the series.
- **FR-8** – Notifications (032 outbox):
  - A new series sends one summary message, not one per occurrence.
  - Reminders go only for the next occurrence (24 h before, as 030 does).
  - Changes and conflicts that affect the family send one message per change.
  - Children without a guardian account get no messages.
- **FR-9** – Times show in the viewer's own time zone, with clinic time when different (decision 6).
  Occurrences keep their **local wall-clock time** across DST changes in other zones.

## Non-functional requirements

- **NFR-1** – Materializing 200 series × 8 weeks completes in < 10 s and is safe to run concurrently,
  using advisory lock per series.
- **NFR-2** – No change to 030's state machine semantics; series code only calls 030's functions or
  inserts `confirmed` rows inside the same constraint.

## Affected areas

- `supabase/migrations/<ts>_appointment_series.sql` (new)
- `lib/booking/series.ts` (new); `app/api/provider/series/**` (new); `/api/cron/booking` (call materialize)
- `app/cases/[id]/**` (Timetable card), `app/dashboard/schedule/**`, `app/family/appointments/**`
- `lib/notify/topics.ts`, `lib/privacy/registry.ts`, `messages/{en,hi,te}.json`
- `tests/series-*.test.ts` (new)

## Don't touch

- Existing migrations, 030 state machine internals, `BOARD.md` (the builder updates it).

## Out of scope

- Parents booking a recurring series themselves (centres decide the timetable).
- Group sessions.
- Therapist leave and substitution planning (beyond conflicts).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Model | Series generates real `appointments` rows on an 8-week horizon | Reuses the constraint, reminders and views |
| D-2 | Who creates | Centre staff only | Centres own the timetable; parents get one-off booking |
| D-3 | Conflicts | Skip and record; never double-book | 030 atomicity rule |
| D-4 | Children without app guardian | Allowed (paper consent families) | Decision 1 of 2026-11-12 |

## Open questions

- Should a series auto-end when a package (045) runs out? Default: no, show a warning to staff.
