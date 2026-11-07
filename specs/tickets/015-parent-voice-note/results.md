# 015: Parent voice note (Telugu TTS + email) - Results

Branch: `ticket/015-parent-voice-note` (branched from the finished 011 commit). Tested against the shared
Supabase cloud project, `DEMO_MODE=true` with a per-worker fixture copy, port 3003, headless Chrome
(playwright-core installed outside the repo). Test cases were deleted afterwards.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` (lint, typecheck, tests, build) | PASS | 220 tests - `evidence/verify.log` |
| `tests/parent-voice-note.test.ts` | PASS | all four email statuses (`sent`, `demo`, `no_email`, `failed`) persisted via `setEmailStatus` and read back through the page's `noteView` + `ParentVoiceNote` render ("reload"); unique audio object path per generation, earlier object never deleted; uploaded object removed when report persistence fails - `evidence/E-4.txt` |
| E-1 create in demo mode | PASS | `<h2>Parent voice note</h2>`; click -> done in 1.9 s (browser), API 0.8 s; body has Telugu-script text, `Voice note skipped in demo mode`, `Email not sent (demo mode)`, `Recreate and send`; status still shown after reload; DB `final`, `audio_path` null, `email_status` `demo`, no `ISAA` / `/200`; audits `email.demo_skipped`, `parent_note.sent` - `evidence/E-1-browser.txt`, `evidence/E-1-db.txt`, `evidence/E-1.png` |
| E-2 TTS client | PASS | voice per language, `No voice configured for te` when `ELEVENLABS_VOICE_ID_TE` is empty (no request made), `POST https://api.elevenlabs.io/v1/text-to-speech/<voice>`, body `{ text, model_id: "eleven_v3" }`, header `xi-api-key`, HTTP error / empty audio - `evidence/E-2.txt` |
| E-3 preconditions | PASS | unknown report 404 `Report not found`; draft report 422 `Finalize the report first`; draft case page has no `Parent voice note` - `evidence/E-3-api.txt`, `evidence/E-3-browser.txt`, `evidence/E-3-draft.png` |
| E-4 TTS and email failures | PASS | mocked: missing voice 422 (before Gemini), TTS failure 502 with no upload/report/email, Gemini failure 502, email failure -> `failed` persisted + `parent_note.email_failed` audit (`emailed: false`), save failure -> object removed, 500 - `evidence/E-4.txt` |
| NFR-1 demo makes no ElevenLabs request | PASS | route test asserts `synthesize`/upload not called in DEMO_MODE |
| Don't touch | PASS | `ReportEditor.tsx`, `app/api/reports/[id]/route.ts`, `lib/report/**`, `lib/email.ts`, `lib/types.ts`, existing migrations, `package.json` unchanged |
| Live ElevenLabs TTS / Resend / Gemini | NOT RUN | manual, needs live credentials and voice IDs |

## Migration

`supabase/migrations/20261107160000_report_email_status.sql` (additive): `reports.email_status text`
nullable, check `sent|demo|no_email|failed`. Applied to the shared cloud DB with `npm run db:push`
(`db:check` passed before).

## Decisions made while building

- New files beyond "Affected areas": `lib/parentNote.ts` (prompt, NFR-2 check, email text, unique
  audio path), `lib/parentNoteStatus.ts` (client-safe status labels, so the client component does not
  import `node:fs`), `lib/queries/parentNote.ts` (storage + report row). 011's `lib/queries/reports.ts`
  is only imported, not changed.
- The voice is checked before the Gemini call so a missing voice answers 422 without a model call.
- Model output is rejected (502, nothing stored) when it has score-like text (`ISAA`, `FACP`, `/<n>`,
  numbers 40-200) or a language other than the case language.
- Storage upload failure and report save failure answer 500 `Could not save the voice note` (FR-2 only
  names Gemini/TTS -> 502).
- Audit: `parent_note.sent` when the note is created and the email was sent / demo-skipped / not
  possible (no email); `parent_note.email_failed` when Resend failed; `parent_note.failed` on
  Gemini/TTS/upload/save failure. `details.emailed` is true only for a delivered email.
- If the 7-day signed link cannot be created, the email is not sent and the status is `failed`.
- The section appears on page load when the report is final; after clicking `Mark final` in 011's
  editor (which 015 must not touch) the section appears on the next page load.

## Bugs found and fixed

- First draft imported `lib/parentNote.ts` (uses `node:fs`) into the client component; split the status
  labels into `lib/parentNoteStatus.ts` before the build/browser run.
