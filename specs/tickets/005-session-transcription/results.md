# 005: Session upload and Scribe v2 transcription - Results

Branch: `ticket/005-session-transcription` (merged into `int/a-voice`, includes `main` @ 16661b0 with 002).
Tested against the shared Supabase cloud project, `DEMO_MODE=true`, port 3001, fixtures copied to
`.tmp/ct-fx-3001`, case from `npm run seed:demo -- --new`. Test case and Storage objects deleted afterwards.

| Check | Result | Evidence |
|-------|--------|----------|
| lint, typecheck, `npm test`, build | PASS | 122 tests passed |
| E-1 create, upload, transcribe | PASS | 201 with `session_number` 2, `bucket` `recordings`, path `<C>/<R>.wav`; upload 200; transcribe 200 in 1.68 s, 36 segments = fixture N, `duration_sec` 240.43; audits `recording.created`, `recording.consent`, `recording.transcribed` - `evidence/api-checks.txt` |
| E-2 segmentation | PASS | fixture-equality and empty-list tests pass; `01:23 [s12 \| 01:23-01:30 \| PARENT] He stopped talking.` - `evidence/vitest.txt` |
| E-3 validation | PASS | exact 400 details; unknown case 404 |
| E-4 transcribe before upload | PASS | 409 `Audio file not uploaded yet`, status `created` |
| E-5 confirmed items / unknown id | PASS | seeded session -> 409; unknown id -> 404 |
| E-6 STT client | PASS | `tests/stt.test.ts` (demo fixture without fetch; request fields + `xi-api-key`; status in error) |
| E-7 key server-only | PASS | `server only` |
| E-8 Scribe failure recorded | PASS | 502 `Transcription failed`; `failed` + error; retry 200 |
| extra: no speech | PASS | empty `words` -> 422 (checked before 002 with a synthetic fixture) |

## Notes

- `npm run build` warns that `lib/demo.ts` (ticket 001) makes Next trace the whole project because of
  `readFileSync` with a dynamic path. It comes from the shared fixture loader, not from 005.
