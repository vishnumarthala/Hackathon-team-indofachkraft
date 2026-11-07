# 007: Therapist review screen

**Status:** draft
**Mode:** solo
**Runs:** waits for 002, 003, 004: needs seeded sessions, lib/scoring.ts and the case layout/tabs

## Summary

The screen judges will remember: the session audio and transcript on one side, the 40 ISAA items on the
other, each with the AI's suggested rating, a verbatim quote and a timestamp that jumps the audio to
that moment. The therapist confirms or edits every item; score, band, red flags and the suggested next
step update immediately. AI documents, the clinician decides.

## Functional requirements

- **FR-1** - Page `/cases/<id>/sessions/<recordingId>` (server component + client parts). 404
  (`notFound()`) when the recording does not exist, is not `kind = 'session'` or belongs to another case.
  If `status` is not `extracted`, the page shows only `This session is <status>. Process it from the New
  session page.` with a link `New session page` to `/cases/<id>/sessions/new`.
- **FR-2** - Left column: heading `Session <n>`; an `<audio controls>` element with a 1-hour signed URL
  when `storage_path` is set, otherwise the text `No audio uploaded for this session (transcript only).`;
  a transcript list: one row per segment with `Therapist`/`Parent` label, `mm:ss` start time and text.
  Clicking a row seeks the audio to `start_sec` and plays it (when audio exists) and highlights the row.
  Each row has `id="seg-<segment id>"`; the highlighted row (only one at a time) has `data-active="true"`.
- **FR-3** - Right column, top: a score panel showing `formatIsaaScore(score, { showSuggested: true })`
  (003; the review screen is the only place the AI-suggested total appears), per-domain scores
  `<domain name>: <score> / <max>`, the FACP band when `cases.facp_score` is set (`FACP <score>:
  <band>`), the recommendation from `recommend()` (`Referral recommended` + reasons, or `No referral
  rule triggered`), the suggested action, and the label `Suggested by CareThread - the therapist decides`.
  Red flags come from `collectRedFlags({ isaaFacts, extractionRedFlags: recordings.red_flags })` with
  all ISAA facts of the recording (suggestions included - this screen is for the therapist).
- **FR-4** - When there is at least one red flag, a red banner at the top of the page:
  `Red flag: lost speech` / `Red flag: self-injury` (joined with ` · `) followed by
  ` - consider referral`.
- **FR-5** - ISAA form grouped by the 6 domains (domain name as heading). Each item row
  (`data-item="<n>"`) shows: `<n>. <item text>`; five rating buttons `1`..`5` with
  `aria-pressed="true"` on the current value and `title` = rating label; a status badge
  (`AI suggested`, `Confirmed`, `Edited`, `Voice note` when `source` is `therapist_voice`); the
  confidence as `<n>%` while `AI suggested`; the evidence quote in quotes with a button
  `▶ <mm:ss>` that seeks the audio and highlights `seg-<segment_id>`; `Unverified quote` when
  `evidence.verified` is false; `No evidence - needs rating` when value is null; a `Confirm` button,
  enabled only when value is set and status is `suggested`.
- **FR-6** - `PATCH /api/facts/:id` body `{ action: "confirm" }` or `{ action: "edit", value: 1..5 }`:
  404 `{ error: "Fact not found" }`; 422 `{ error: "Only ISAA items can be rated here" }` for non-ISAA
  facts; confirm with a null value -> 422 `{ error: "Rate this item before confirming" }`. Confirm ->
  `status` `confirmed`. Edit -> `value` = new value, `status` `edited`, except when the new value equals
  the current value and the status is `suggested`, which counts as `confirmed`. Both set
  `confirmed_by` = the case's `therapist_name` and `confirmed_at` = now, keep `ai_value` and `source`,
  and write audit `fact.confirmed` or `fact.edited` (actor `therapist`, case id, entity `fact`,
  entity_id = fact id, details `{ item_id: <number>, from_value, to_value, from_status, to_status }`).
  Response 200 `{ fact, score }` where `score` = `scoreIsaa` of all ISAA facts of that recording.
  Lock the recording row and update fact plus audit in one transaction. If its status is `extracting`,
  return 409 `{ error: "Extraction already running" }` without changes.
- **FR-7** - Clicking a rating button sends `edit`; `Confirm` sends `confirm`. The row, badge and score
  panel update without a full page reload; on an error the message appears in red under the row.
- **FR-8** - `POST /api/sessions/:id/bulk` body `{ action: "confirm_suggested" }` (all ISAA facts of the
  recording with `status` `suggested` and a value -> `confirmed`) or `{ action: "rate_unrated", value: 1 }`
  (all ISAA facts with value null -> value 1, `status` `edited`). Sets `confirmed_by`/`confirmed_at`,
  audit `facts.bulk_confirmed` / `facts.bulk_rated` with `entity` `recording`, `entity_id` = the
  recording id, actor `therapist` and details `{ count }`. 404 `{ error: "Session not found" }`.
  Response 200 `{ updated: <integer count>, score }`. Use the same recording lock and transaction
  as FR-6; return 409 without changes if extraction is running.
- **FR-9** - Above the form, buttons `Confirm all remaining suggestions` and `Rate all unrated as 1
  (Rarely)`. Each opens a confirm dialog: `Confirm <n> AI suggestions you have reviewed?` /
  `Set <n> unrated items to 1 (Rarely)?` with buttons `Yes` and `Cancel`; `Yes` calls FR-8 and refreshes
  the form and score.
- **FR-10** - Read helper `lib/queries/sessions.ts` `getSessionReview(caseId, recordingId)` returns case,
  recording, ISAA facts and a signed audio URL (or null).

## Non-functional requirements

- **NFR-1** - All 40 items and the transcript render in < 2 s on the seeded case (local dev, warm).
- **NFR-2** - Rating buttons and Confirm buttons have accessible names (`Rate item <n> as <r>`,
  `Confirm item <n>`).
- **NFR-3** - UI copy follows project.md wording rules (no "diagnos" except "not a diagnosis").

## Affected areas

- `app/cases/[id]/sessions/[recordingId]/page.tsx` (new)
- `components/session/*.tsx` (new: AudioTranscript, ScorePanel, IsaaForm, ItemRow, BulkActions)
- `app/api/facts/[id]/route.ts`, `app/api/sessions/[id]/bulk/route.ts` (new)
- `lib/queries/sessions.ts`, `lib/facts.ts` (new: shared update helpers used by both routes)
- `tests/facts.test.ts` (new: unit tests for the status rules in FR-6/FR-8 in `lib/facts.ts`)

## Don't touch

- `app/cases/[id]/layout.tsx`, `app/cases/[id]/sessions/page.tsx` (004), `lib/scoring.ts` (003),
  `lib/types.ts`, `supabase/migrations/**`, `package.json`

## Out of scope

- Upload/processing panel and the `Swap speakers` button (008).
- Comparison with a previous session, editing transcript text, therapist free-text notes per item.
- Report (011) and referral (012).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Bulk confirm | Allowed behind a confirm dialog, audited | grill D-10 |
| D-2 | Unrated items | Bulk "rate as 1" is an explicit therapist action | grill D-3 |
| D-3 | Same value as AI clicked | Counts as confirm | fewer clicks, same meaning |
| D-4 | Audio URL lifetime | 1 hour signed URL | section 13 |
| D-5 | Layout on narrow screens | Columns stack (transcript above form) below 1024 px | demo is on a laptop; mobile just must not break |

## Open questions

None.
