# 015: Parent voice note (Telugu TTS + email)

**Status:** draft
**Mode:** solo
**Runs:** waits for 011: adds a section to 011's Report tab and needs final assessment reports

## Summary

NICE TO HAVE. After the therapist finalizes the assessment report, CareThread writes a short,
plain-language summary for the parent in their language (Telugu, Hindi or English), turns it into a
voice note with ElevenLabs, and emails the parent a link. No scores, no diagnosis words - just what was
observed and the next steps.

## Functional requirements

- **FR-1** - On the Report tab, when the selected session's assessment report is `final`, a section
  `<h2>Parent voice note</h2>` with a button `Create and send voice note`. When a `parent_summary`
  report exists for that session it shows its text, an `<audio controls>` (1-hour signed URL) when
  `audio_path` is set, otherwise `Voice note skipped in demo mode`, and the email status
  (`Email sent to parent`, `Email not sent (demo mode)`, `No parent email on the case`,
  `Email could not be sent`). Button label then becomes `Recreate and send`.
- **FR-2** - `POST /api/reports/:id/parent-voice-note` (`:id` = the assessment report): 404
  `{ error: "Report not found" }`; 422 `{ error: "Finalize the report first" }` unless the report is an
  `assessment` with `status` `final`. Steps: Gemini `generateJson({ task: "parent-summary", system:
  prompts/parent-summary.md, prompt, schema: ParentSummarySchema })` from the final `content_md` and the
  case language; then, unless DEMO_MODE, TTS (FR-3) and upload of the mp3 to
  a unique object path under `recordings/<case_id>/` for each generation; then upsert the `parent_summary`
  report (`recording_id` = the assessment's recording, `content` = summary, `content_md` = text,
  `audio_path`, `status` `final`); then email the parent if `parent_email` is set (subject
  `A voice note from <therapist_name> about <child_alias>`, text = summary text + a 7-day signed audio
  link when audio exists). Audit `parent_note.sent`. Returns 200
  `{ report, emailed, email_status }` with `email_status` one of `sent`, `demo`, `no_email`, `failed`.
  Persist `email_status` in an additive report column or a dedicated table so the UI shows the same
  result after reload. Audit both success and failure without claiming an email was sent on failure.
  Gemini or TTS failure -> 502 `{ error: "Voice note could not be created" }` and no report is stored.
  Use a unique audio object path per generation rather than overwriting a file referenced by an
  earlier email; remove an uploaded object if the corresponding report cannot be saved.
- **FR-3** - `lib/elevenlabs/tts.ts` `synthesize({ text, language })`: voice id from
  `ELEVENLABS_VOICE_ID_EN|HI|TE` (missing -> throws `No voice configured for <language>`, route answers
  422 `{ error: "No voice configured for <language>" }`), `POST
  https://api.elevenlabs.io/v1/text-to-speech/<voice_id>` with `{ text, model_id: "eleven_v3" }`,
  header `xi-api-key`, returns the mp3 `Buffer`.
- **FR-4** - `prompts/parent-summary.md`: write for the parent in their language (Telugu script for `te`,
  Devanagari for `hi`), max 120 words, warm and simple, what was observed and the next steps, no scores,
  no bands, no "autism"/diagnosis words, no medical advice; end with "Your therapist will talk with you
  about the next steps."
- **FR-5** - `tests/tts.test.ts`: voice selection per language, missing voice error, request body/model
  id/header with a mocked `fetch`.

## Non-functional requirements

- **NFR-1** - In DEMO_MODE the endpoint answers in < 5 s and makes no ElevenLabs request.
- **NFR-2** - The parent text never contains digits that look like scores (no `/200`, no `ISAA`).

## Affected areas

- `app/cases/[id]/report/page.tsx` (changed: render `ParentVoiceNote` under the report)
- `components/report/ParentVoiceNote.tsx` (new)
- `app/api/reports/[id]/parent-voice-note/route.ts` (new)
- `lib/elevenlabs/tts.ts`, `prompts/parent-summary.md` (new)
- `tests/tts.test.ts`, `tests/parent-voice-note.test.ts` (new)
- An additive migration for persistent email status.

## Don't touch

- `components/report/ReportEditor.tsx`, `app/api/reports/[id]/route.ts`, `lib/report/**` (011)
- `lib/email.ts`, `lib/types.ts`, existing migrations, `package.json`

## Out of scope

- WhatsApp sending, the parent replying, voice cloning, more languages than en/hi/te.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | TTS model | `eleven_v3` | supports Telugu and Hindi (grill F-8) |
| D-2 | When | Only after the report is final | clinician decides first |
| D-3 | Demo mode | Skip TTS, keep text and email flow | no audio fixture needed |
| D-4 | Audio link lifetime in email | 7 days | parent may listen later |

## Open questions

None.
