# 002: Demo fixtures and seed

**Status:** done
**Mode:** solo
**Runs:** waits for 001: needs lib/types.ts schemas, lib/db.ts, the migration and the npm scripts

## Summary

Write the synthetic role-play data every other ticket tests against: the session transcript, a Scribe
v2 response, Gemini outputs for every AI task, an ElevenLabs post-call webhook payload, a short test
audio file, and a seed script that loads a complete demo case into the database. With these, every
feature works in `DEMO_MODE=true` without calling ElevenLabs or Gemini, and the 3-minute demo has a
safe fallback.

## Functional requirements

- **FR-1** - `demo/fixtures/roleplay-segments.json` is a `Segment[]` (schema `SegmentSchema`) for a
  4-minute session between a therapist and a parent, written from the role-play script in the team plan
  section 5: ids `s1..sN` in order, N >= 30; speakers alternate between `therapist`
  (`speaker_label` `speaker_0`) and `parent` (`speaker_label` `speaker_1`), starting with the therapist;
  `start_sec` of each segment >= previous `end_sec` + 2.0; each segment lasts 3-25 s; the last
  `end_sec` is between 200 and 260; the segments contain more than 300 words in total. Parent language:
  English with a few romanised Telugu words.
  Synthetic names only: child `Ravi`, parent `Lakshmi`.
- **FR-2** - The parent clearly describes all 10 signs from the team plan (poor eye contact, no
  response to name, said words at 2 then stopped, lines up toys / plays alone, repeats cartoon lines,
  covers ears at mixer and pressure cooker, flaps hands, tantrum when the school route changes, hits own
  head when upset, does not point). Two therapist segments start with `Note:` and contain exactly
  `rate item 5 as 4` and `rate item 24 as 4` respectively (the first one is the plan's line
  `Note: child did not respond to name in three attempts, rate item 5 as 4.`).
- **FR-3** - `scripts/make-scribe-fixture.ts` (`npm run fixtures:scribe`) turns `roleplay-segments.json`
  into `demo/fixtures/scribe-response.json` shaped like the Scribe v2 response: `{ language_code:
  "eng", language_probability: 0.9, text, words }`. Each segment's text is split on single spaces into
  words spread evenly across the segment (`start`/`end` rounded to 2 decimals, first word starts at
  `start_sec`, last word ends at `end_sec`); between two words of one segment there is a
  `{ text: " ", type: "spacing", start: <prev end>, end: <next start>, speaker_id }` entry; words have
  `type: "word"` and `speaker_id` = the segment's `speaker_label`. `text` = all segment texts joined
  with a single space. The output is deterministic (running twice gives identical bytes).
- **FR-4** - `demo/fixtures/gemini/extract.json` is a valid `IsaaExtraction` for the role-play: exactly
  40 items (ids 1-40 once each); at least 12 items have a rating, a `segment_id` that exists in
  `roleplay-segments.json` and a `quote` that is a verbatim substring of that segment's text; items
  without evidence have `rating: null`, `segment_id: null`, `quote: null`, `confidence: 0`, and at least
  5 items are like that (ticket 007 needs unrated items); item 15 and
  item 29 are rated >= 3; `red_flags` has one `lost_speech` and one `self_injury` entry citing the right
  segments; `therapist_notes` has both notes (items 5 and 24, rating 4).
- **FR-5** - `demo/fixtures/elevenlabs-post-call.json` is a `post_call_transcription` webhook body:
  `{ type, event_timestamp, data: { agent_id: "demo-agent", conversation_id: "demo-conversation",
  status: "done", metadata: { call_duration_secs }, transcript: [{ role: "agent" | "user", message,
  time_in_call_secs }],
  analysis: { transcript_summary, data_collection_results: { <field>: { data_collection_id: <field>,
  value, rationale } } }, conversation_initiation_client_data: { dynamic_variables: { intake_token:
  "demo-intake-token", child_alias: "Ravi (synthetic)", parent_alias: "Lakshmi (synthetic)",
  therapist_name: "Demo Therapist", language: "te" } } } }`. Transcript has >= 12 turns; the first
  agent turn contains `I am an AI assistant` and asks for consent; exactly one agent turn (not the
  first or last) has `message: null` (a tool call, as ElevenLabs sends them); `data_collection_results`
  has every field of `schemas/case-sheet.json` with `consent_given: true`, `child_age_months: 40`,
  `lost_speech: true` and `self_injury: true`, and its answers agree with the role-play (speech lost at
  about age 2, head hitting when upset).
- **FR-6** - `demo/fixtures/gemini/brief.json` (`BriefSchema`): `red_flags` has one `lost_speech` and
  one `self_injury` entry; `turn_id`s are `t<k>` where k is the
  1-based index of a turn in the post-call transcript (every cited turn exists, is not the `null`
  turn, and its message contains the quote verbatim). `gemini/report.json` (`ReportDraftSchema`),
  `gemini/referral.json` (`ReferralSummarySchema`), `gemini/parent-summary.json` (`ParentSummarySchema`,
  language `te`, text in Telugu script, no digits, no `ISAA`, ending exactly with
  `మీ థెరపిస్ట్ తదుపరి దశల గురించి మీతో మాట్లాడతారు.`) are valid. No Gemini fixture contains
  `diagnos` (except `not a diagnosis`), `HIPAA compliant`, or a total score. `gemini/ask.json` (`AskAnswerSchema`) answers
  "When did speech regress?" with `found: true` and citations `{ kind: "segment", id: "1:s<k>" }`
  where `s<k>` is the role-play segment about lost speech (`1` = session number).
- **FR-7** - `demo/audio/sample-short.wav`: 8-15 s of synthetic speech, mono 16 kHz 16-bit PCM WAV,
  <= 1 MB. The builder may create it on macOS with `say` and `afconvert`, or use an equivalent
  locally available speech/formatting tool on Windows. Do not include real patient speech.
  `demo/README.md` lists the exact commands used and states that
  all names and data are synthetic.
- **FR-8** - `scripts/seed-demo.ts` (`npm run seed:demo`) loads `.env.local`, then:
  - default: deletes the canonical case `00000000-0000-4000-8000-000000000001` (cascade) and recreates
    it with intake recording `...0002`, session recording `...0003`, intake token `demo-intake-token`,
    intake `external_id` `seed-canonical`; before deleting it removes every Storage object under
    `<case_id>/` in bucket `recordings`;
  - `--new`: random ids, `newToken()` token, `external_id` `seed-<first 8 chars of the case id>`;
  - inserts the case (`child_alias` `Ravi (synthetic)`, `child_age_months` 40, `parent_alias`
    `Lakshmi (synthetic)`, `language` `te`, `therapist_name` `Demo Therapist`, `status`
    `in_assessment`), the intake recording (`kind` `intake_call`, `status` `transcribed`, segments
    built from the post-call transcript as `t<k>` = 1-based turn index, speaker `agent`/`parent`,
    `speaker_label` = role, `start_sec` = `time_in_call_secs`, `end_sec` = the next kept turn's
    `time_in_call_secs` or start + 5; turns with a null/empty message are skipped but ids keep the
    original index),
    one `CASE_SHEET` fact per case-sheet field (`source` `parent_call`, `status` `suggested`, value and
    rationale from the fixture), and a `pre_session_brief` report (content = brief.json, `content_md`
    = a readable Markdown rendering, `status` `draft`);
  - inserts session 1 (`kind` `session`, `session_number` 1, `status` `extracted`, segments =
    roleplay-segments, `speaker_map` `{"speaker_0":"therapist","speaker_1":"parent"}`, `duration_sec`
    = last `end_sec`, `red_flags` = extract.json red_flags, `language_code` `eng`). If
    `demo/audio/session-1.mp3` exists it is uploaded (upsert) to bucket `recordings`, object key
    `<case_id>/<session_id>.mp3`, and `storage_path` = that key, `mime_type` `audio/mpeg`; else
    `storage_path` stays null;
  - inserts 40 `ISAA` facts from extract.json: `value` = `ai_value` = rating, `source` `session`,
    `status` `suggested`, `evidence` = `{ quote, segment_id, start_sec, end_sec, recording_id,
    verified }` taken from the cited segment (`verified` true when the quote is a substring of the
    segment text) or null; then the two therapist notes set items 5 and 24 to value 4, `source`
    `therapist_voice`, `status` `confirmed`, `confirmed_by` `Demo Therapist (voice note)`,
    `confirmed_at` now;
  - `--confirmed`: afterwards every ISAA fact with a value that is still `suggested` becomes
    `confirmed`, and every null fact becomes value 1, `status` `edited`, `evidence` null; both get
    `confirmed_by` `Demo Therapist` and `confirmed_at` now;
  - `--stage transcribed`: the session recording gets `status` `transcribed`, `red_flags` `[]`, and no
    ISAA facts are inserted;
  - prints exactly one final line `seeded case=<uuid> session=<uuid> intake=<uuid> token=<token>`;
  - on any error it deletes the case it was creating (cascade), prints `seed failed: <message>` to
    stderr, prints no `seeded` line and exits 1.
- **FR-9** - `tests/fixtures.test.ts` checks FR-1..FR-6 automatically: every fixture parses with its
  schema; role-play gap/alternation/duration/id rules; both `Note:` lines present; extract quotes are
  verbatim substrings of their cited segments; item ids 1..40 unique; >= 5 null items; > 300 words;
  brief turn ids exist and quotes match; ask citations exist; post-call aliases/age match the seed
  values; parent-summary ending and no digits; copy rules in all Gemini fixtures; `make-scribe-fixture`
  output equals the committed `scribe-response.json`.

## Non-functional requirements

- **NFR-1** - All JSON fixtures together are <= 300 KB.
- **NFR-2** - No real person names, phone numbers or emails anywhere in `demo/`: the only names are
  `Ravi`, `Lakshmi`, `Demo Therapist`; emails only `@example.com`; no digit sequences that look like
  phone numbers (8+ digits, spaces allowed).
- **NFR-3** - `npm run seed:demo -- --new` finishes in < 20 s.

## Affected areas

- `demo/fixtures/roleplay-segments.json`, `demo/fixtures/scribe-response.json`,
  `demo/fixtures/elevenlabs-post-call.json`, `demo/fixtures/gemini/{extract,brief,report,referral,ask,parent-summary}.json` (new)
- `demo/audio/sample-short.wav`, `demo/README.md` (new)
- `scripts/make-scribe-fixture.ts`, `scripts/seed-demo.ts` (new)
- `tests/fixtures.test.ts` (new)

## Don't touch

- `lib/types.ts`, `lib/db.ts`, `supabase/migrations/**`, `package.json` (scripts already exist from 001)
- The canonical demo case: reset it only in E-7 of this ticket; every other check uses `--new`.

## Out of scope

- Recording the real role-play audio (`demo/audio/session-1.mp3` is added by Role D later).
- Extraction, transcription or brief logic in `lib/` (005, 006, 010) - the seed has its own small inline logic.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | "rate item 5" vs ISAA item 6 (grill F-15) | Use the script verbatim (item 5) | content decision for Role D (grill D-12) |
| D-2 | Gap between segments | >= 2.0 s so 005's > 1.5 s split rule rebuilds the same segments | keeps 005's test exact |
| D-3 | Segment reference format for "ask" citations | `<session_number>:<segment_id>`, intake turns `intake:<turn_id>` | segment ids repeat across recordings |
| D-4 | Test audio | Synthetic 8-15 s speech in mono 16 kHz 16-bit PCM WAV; creation tool is builder's choice | the fixture is portable across developer laptops |
| D-5 | Seed concurrency | Workers always use `--new`; the canonical case is for the main checkout and the demo | shared DB (grill D-2) |

## Open questions

None.
