# 006: ISAA extraction with Gemini

**Status:** draft
**Mode:** solo
**Runs:** waits for 002: needs the extract fixture, roleplay segments and `seed:demo -- --stage transcribed` (002 waits for 001)

## Summary

The core AI step: Gemini reads the diarized transcript and suggests a rating for all 40 ISAA items,
each with a verbatim quote, the segment it came from and a confidence. The server (not the model)
attaches timestamps and checks every quote. Therapist voice notes ("Note: ... rate item 5 as 4")
override items directly, and red flags (lost speech, self-injury) are recorded.

## Functional requirements

- **FR-1** - `POST /api/sessions/:id/extract`: 404 `{ error: "Session not found" }` for unknown ids or
  `kind` other than `session`; 409 `{ error: "Transcribe the session first" }` unless `status` is
  `transcribed` or `extracted`; 409 `{ error: "Extraction already running" }` when `extracting`. It
  claims the recording with one conditional update (`update recordings set status='extracting' where
  id=$1 and status in ('transcribed','extracted') returning id`; no row -> re-read the status and answer
  the matching 404/409), remembers the previous status, runs the extraction (FR-2..FR-5), saves facts,
  sets `recordings.red_flags`,
  `status` `extracted`, `error` null, and sets `cases.status` to `in_assessment` when it was `booked` or
  `intake_done`. Returns 200 `{ recording_id, facts, red_flags, therapist_notes_applied }` with `facts`
  = the 40 ISAA fact rows ordered by item number. Audit `extraction.completed` with counts
  `{ rated, verified, notes }`. Route exports `maxDuration = 300`, `runtime = "nodejs"`.
- **FR-2** - `prompts/extract.md` holds the system prompt with the rules of `docs/system-design.md`
  section 10 (document never diagnose; rate only with direct evidence; null rating + confidence 0
  without evidence; copy quotes word for word from one segment; parent statements are parent-reported;
  therapist `Note` lines go to `therapist_notes`; lost speech / self-injury go to `red_flags`). The user
  prompt lists the 40 items (`<id>. <text> [<domain name>]`), the 1-5 scale with labels and ranges, and
  the transcript via `toPromptLines`. Call: `generateJson({ task: "extract", system, prompt, schema:
  IsaaExtractionSchema })`.
- **FR-3** - `lib/extraction.ts` `postProcess({ extraction, segments, recordingId })` (pure):
  keeps the first entry per `item_id`; adds `rating: null` items for missing ids so there are exactly
  40; resolves evidence: a null/unknown `segment_id` or a null quote means no evidence -> `rating` null,
  `confidence` 0, evidence null (D-1: no rating without evidence); a quote that is not a normalized
  substring of the segment text keeps the rating with `verified: false` and confidence capped at 0.5;
  otherwise `verified: true`; `start_sec`/`end_sec` always come from the segment. Keeps only red flags
  whose `segment_id` exists.
- **FR-4** - Voice notes: `parseVoiceNotes(segments)` (pure) scans `therapist` segments whose trimmed
  text starts with `note` (case-insensitive) for `rate item <N> as|at|to <R>` where N is 1-40 and R 1-5,
  written as digits or English words (`five`, `twenty four`, `twenty-four`). Several notes for one item
  -> the last wins. It returns `{ item_id: number, rating: number, segment_id: string, text: string }[]`
  (text = the segment text). `mergeVoiceNotes(regexNotes, geminiNotes, segments)` adds Gemini
  `therapist_notes` that have an `item_id`, a `rating` and an existing therapist `segment_id`, only for
  items the regex did not find; the merged list is what FR-5 applies.
- **FR-5** - Saving: the final 40 rows (including the voice-note overrides below) are computed in
  memory and written with **one** upsert on `(recording_id, instrument, item_id)`; only then are the
  recording and case updated in the same database transaction along with the audit event. Lock the
  recording row and re-read existing facts within that transaction; do not overwrite a decision made
  while the model was running. New rows get `value` = `ai_value` = rating, `source` `session`, `status`
  `suggested`, evidence, confidence, rationale. Existing rows with `status` `suggested` get the new
  `value`, evidence, confidence, rationale and `source` `session`, but keep their `ai_value` (the first
  non-null AI suggestion for the current speaker mapping is never overwritten; if it is null, use the
  new rating). Existing `confirmed`/`edited` rows are not changed. Then each voice note sets its item (unless that row was already confirmed/edited before this
  run) to `value` = note rating, `source` `therapist_voice`, `status` `confirmed`, `confirmed_by`
  `<cases.therapist_name> (voice note)`, `confirmed_at` now, evidence = the note's segment (quote = the
  note text, `verified: true`), keeping `ai_value` = Gemini's rating. `therapist_notes_applied` = how
  many items a note changed.
- **FR-6** - On Gemini, validation, or persistence failure, roll back the result transaction, restore
  the previous status (`transcribed` or `extracted`), record the error, and return 502
  `{ error: "Extraction failed", details: "<message>" }`; no partial facts or completion audit persist.
  If recording the failure also fails, log it explicitly and return an error, never a success.
- **FR-7** - `tests/extraction.test.ts` covers FR-3 and FR-4 with the extract fixture and roleplay
  segments plus synthetic cases (unknown segment, wrong quote, duplicate item, missing items, notes in
  digits and words, last-note-wins).

## Non-functional requirements

- **NFR-1** - In DEMO_MODE the endpoint answers in < 5 s.
- **NFR-2** - Evidence timestamps always come from stored segments, never from model output.

## Affected areas

- `app/api/sessions/[id]/extract/route.ts` (new)
- `lib/extraction.ts`, `prompts/extract.md` (new)
- `tests/extraction.test.ts` (new)
- An additive migration for a transactional extraction helper if needed.

## Don't touch

- `lib/types.ts`, `lib/gemini.ts`, `lib/transcript.ts` (005 owns it; import `toPromptLines` if 005 is
  merged, otherwise write a private formatter in `lib/extraction.ts` with the same line format)
- `demo/fixtures/**`, existing migrations, `package.json`, `app/cases/**`

## Out of scope

- UI (007, 008), scoring (003), re-running extraction after a speaker swap (008).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Items without evidence | rating null, confidence 0 | grill D-3 |
| D-2 | Who sets timestamps | Server, from segments | grill A-4 |
| D-3 | Voice note status | `confirmed` directly, `source` `therapist_voice` | the therapist said it; it is their decision |
| D-4 | Re-extraction | Overwrites only `suggested` facts | never undo a therapist decision |
| D-5 | Normalize for quote matching | lower-case, remove `[^\p{L}\p{N}\s]`, collapse whitespace | section 10 |

## Open questions

None.
