# 038: AI scribe for any provider type

**Status:** draft
**Mode:** solo
**Runs:** waits for 024, 025, 028, 041: uses report-kind/speaker contracts (024) and IEP goals for progress suggestions (025); provider types and the prescriber check (028); real child data needs the privacy/audit baseline (041)

## Summary

Generalises the existing session pipeline (upload -> ElevenLabs Scribe v2 -> Gemini extraction) from
ISAA-only to an AI scribe for any provider: from an **in-clinic recording** it drafts a session note,
suggests progress on the case's active IEP goals, and - for prescribers - an Rx draft for 039. Child
Development sessions keep the ISAA extraction unchanged. Nothing is final until the provider reviews it.
Not available for Meet calls.

## Functional requirements

- **FR-1** - Migration `<ts>_scribe.sql`: `recordings.kind` check adds `consult`; `recordings.appointment_id`
  (if 035 not merged, add here); `reports.kind` check adds `session_note`, `rx_draft`;
  `goal_progress_suggestions(id, recording_id, goal_id, suggested_value numeric, evidence jsonb
  (segment ids + quotes), rationale, status text check in ('suggested','accepted','rejected'), decided_by,
  decided_at, progress_id null -> goal_progress)`.
- **FR-2** - Templates `lib/scribe/templates.ts` keyed by provider type (028 `provider_type`; until 028
  merges, by a `template` select on the upload form): `child_dev_isaa` (existing ISAA path),
  `therapy_session_note` (SLP, OT, ABA, special educator, physio: goals worked on, activities, child
  response, caregiver coaching, home-program suggestions, plan for next session), `medical_consult_note`
  (dev-ped, psychiatrist, paediatrician, psychologist: history, observations, assessment impressions
  phrased as clinician-confirmable, plan; for prescribers also medication suggestions -> `rx_draft`).
  Prompts `prompts/session-note-therapy.md`, `prompts/session-note-medical.md`, `prompts/rx-draft.md`.
- **FR-3** - Upload flow: case workspace `Sessions` -> `Record or upload in-clinic session` (existing
  005/008 UI) gains `Session type` (template) and optional `Appointment`; the consent gates of 020
  (`session_recording`, `ai_transcription`, `ai_extraction`) apply at upload and are re-checked by each
  queued step. Uploading for a video (Meet) appointment is blocked: 422 `{ error: "The AI scribe is
  available for in-clinic sessions only" }`.
- **FR-4** - `POST /api/sessions/:id/scribe` -> 200 `{ session_note_id, goal_suggestions, rx_draft_id? }`:
  uses the transcript (speaker roles per 024 contract), the case's active IEP goals (025), and the 021
  health summary when available; Gemini structured output validated with Zod; each statement keeps
  segment citations. Idempotent per recording (re-run replaces drafts that are still `draft`, never
  final ones). `rx_draft` only when `provider_can_prescribe` (028) is true for the uploading provider.
- **FR-5** - Review UI: `Session note` editor (markdown, citations clickable to the audio timestamp as in
  013), `Finalize note` (publishes via 024 `publishVersion`, `visible_to_guardian` checkbox default off);
  `Goal progress` list: each suggestion with value, quote, `Accept` (creates `goal_progress` with
  `source = 'ai_suggested_confirmed'`, `recording_id`) / `Edit value` / `Reject`; `Rx draft` card ->
  `Review in prescriptions` (039). Label everywhere: `Suggested by DoctorNearMe - the clinician decides`.
- **FR-6** - Regression: ISAA sessions (`child_dev_isaa`) produce exactly the pre-change facts/score/report.

## Non-functional requirements

- **NFR-1** - No AI output is visible to guardians until finalized and explicitly shared.
- **NFR-2** - DEMO_MODE fixtures for each template (`demo/fixtures/gemini/scribe-*.json`).
- **NFR-3** - Copy rules: no "diagnose/diagnosis" in prompts' outputs shown to guardians.

## Affected areas

- `supabase/migrations/<ts>_scribe.sql` (new); `lib/scribe/**` (new); `lib/extraction.ts` (route by template only)
- `prompts/session-note-*.md`, `prompts/rx-draft.md` (new); `demo/fixtures/gemini/scribe-*.json` (new)
- `app/api/sessions/[id]/scribe/route.ts`, `app/api/goal-suggestions/[id]/route.ts` (new); case `Sessions` UI
- `lib/clinical/reports.ts` (kinds), `messages/*.json`; `tests/scribe.test.ts` (new)

## Don't touch

- ISAA prompts/scoring, Child-Dev intake, Rx signing (039), existing migrations, `BOARD.md`

## Out of scope

- Live/streaming scribe, Meet capture, built-in video room, ICD coding, billing codes.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Capture | In-clinic recordings only | plan §2 "Scribe capture" |
| D-2 | Outputs | Session note, goal progress suggestions, Rx draft for prescribers | plan §4 voice agents table "AI scribe" |
| D-3 | Human in the loop | Every output is a draft until the provider accepts/finalizes | plan §2 "AI scribe -> Rx" |

## Open questions

- Dependency gap: templates and Rx-draft gating need `provider_type`/`provider_can_prescribe` from 028,
  which is not upstream of 038 (038 <- 024, 025). Recommended: add 028 as a prerequisite; fallback is the
  manual `Session type` select and no Rx draft until 028 merges.
