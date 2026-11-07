# 005: Session upload and Scribe v2 transcription - Results

Branch: `ticket/005-session-transcription` (base `int/a-voice` = `main` @ 711932a). Tested against the
shared Supabase cloud project with `DEMO_MODE=true` on port 3001.

**Status: built, partially verified. Blocked on 002.** `demo/fixtures/`, `demo/audio/sample-short.wav`
and `scripts/seed-demo.ts` (ticket 002) do not exist yet, so the checks that use them were run with
stand-ins: a test case made via `POST /api/cases`, a generated 2 s 16 kHz WAV, and a synthetic
3-segment `scribe-response.json` in `.tmp/ct-fx-3001`. Test rows and the Storage object were deleted afterwards.

| Check | Result | Evidence |
|-------|--------|----------|
| lint, typecheck, `npm test`, build | PASS | 93 passed, 1 skipped (fixture-equality test, waits for 002) |
| E-1 create, upload, transcribe | PASS (stand-ins) | 201 with `bucket`, `path` `<C>/<R>.wav`, upload 200, transcribe 200 in 1.4 s with `speaker_map` `{"speaker_0":"therapist","speaker_1":"parent"}`; DB row `transcribed`, n = segments_count; audits `recording.created`, `recording.consent`, `recording.transcribed`. `session_number` 2 is verified in E-4 (the stand-in case had no seeded session 1) |
| E-2 segmentation | PARTIAL | `formatTime`/`toPromptLines` output matches exactly; split-rule, fallback and empty-list tests pass; **fixture-equality test is skipped until 002 lands** |
| E-3 validation | PASS | exact 400 details for mime/size; unknown case 404 |
| E-4 transcribe before upload | PASS | 409 `Audio file not uploaded yet`, status stays `created`; second session got `session_number` 2 |
| E-5 confirmed items / unknown id | PASS (stand-in) | confirmed fact inserted by hand -> 409; unknown and malformed ids -> 404 |
| E-6 STT client | PASS | `tests/stt.test.ts`: demo fixture without fetch; scribe_v2/diarize/num_speakers/word timestamps + `xi-api-key`; non-2xx error contains status |
| E-7 key server-only | PASS | `server only` |
| E-8 Scribe failure recorded | PASS | 502 `Transcription failed`, row `failed` with error, retry 200; old `suggested` ISAA facts cleared |
| extra: no speech | PASS | empty `words` -> 422 `No speech found in the recording` |

## To finish after 002 is merged

1. `git merge origin/int/b-backend` (or `origin/main` after CP1).
2. `npx vitest run tests/transcript.test.ts --reporter=verbose` - the fixture-equality test must run and pass.
3. Re-run E-1 and E-5 exactly as written (`seed:demo -- --new`, `demo/audio/sample-short.wav`).
4. Then merge into `int/a-voice` and mark 005 `done`.

## Notes

- `npm run build` warns that `lib/demo.ts` (ticket 001) causes whole-project file tracing because
  of `readFileSync` with a dynamic path. It comes from the shared fixture loader, not from 005; B may want
  to add a `/*turbopackIgnore: true*/` hint.
