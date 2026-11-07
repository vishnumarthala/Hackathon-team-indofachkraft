# Demo data

All names and data in this folder are **synthetic** (role-play). There is no real patient, child or
parent data here. The only names used are `Ravi` (child), `Lakshmi` (parent) and `Demo Therapist`.
AI documents, the clinician decides: this is not a diagnosis.

## Fixtures (`demo/fixtures/`)

Used by `DEMO_MODE=true` instead of calling ElevenLabs or Gemini (see `docs/system-design.md` section 9).

| File | What it is |
|------|------------|
| `roleplay-segments.json` | `Segment[]` for the 4-minute role-play session: 36 segments `s1..s36`, therapist (`speaker_0`) and parent (`speaker_1`) alternate, gaps >= 2.0 s. Therapist voice notes: `s7` (`rate item 5 as 4`) and `s25` (`rate item 24 as 4`). Lost speech: `s10`. Head hitting: `s30`. |
| `scribe-response.json` | Scribe v2 response generated from the segments: `npm run fixtures:scribe` (deterministic, do not edit by hand). |
| `elevenlabs-post-call.json` | `post_call_transcription` webhook body for the intake call (22 turns, turn 9 is a tool call with `message: null`; lost speech `t8`, head hitting `t17`). |
| `gemini/extract.json` | `IsaaExtraction` for the session (15 rated items with verbatim quotes, 25 unrated, 2 red flags, 2 therapist notes). |
| `gemini/brief.json` | Pre-session brief (`BriefSchema`), red flags cite `t8` and `t17`. |
| `gemini/report.json` | Draft assessment report (`ReportDraftSchema`). |
| `gemini/referral.json` | Referral summary (`ReferralSummarySchema`). |
| `gemini/ask.json` | Answer to "When did speech regress?" citing `1:s10`. |
| `gemini/parent-summary.json` | Parent summary in Telugu (`ParentSummarySchema`). |

`tests/fixtures.test.ts` checks every rule these files must follow.

## Test audio (`demo/audio/sample-short.wav`)

About 10 s of synthetic speech (macOS text-to-speech, no human voice), mono 16 kHz 16-bit PCM WAV.
Created on macOS with:

```sh
mkdir -p .tmp
say -v Samantha -r 170 -o .tmp/sample-short.aiff "Good morning. When you call his name, does he turn to you? No, he does not turn when we call his name. He covers his ears at the mixer. Note: rate item five as four."
afconvert -f WAVE -d LEI16@16000 -c 1 .tmp/sample-short.aiff demo/audio/sample-short.wav
```

`demo/audio/session-1.mp3` (the recorded role-play) is added later by Role D. When it exists,
`npm run seed:demo` uploads it to the `recordings` bucket for session 1.

## Seed

```sh
npm run -s seed:demo                          # reset the canonical case 00000000-0000-4000-8000-000000000001
npm run -s seed:demo -- --new                 # fresh ids and a fresh intake token (use this in workers)
npm run -s seed:demo -- --new --confirmed     # all 40 ISAA facts confirmed or edited
npm run -s seed:demo -- --new --stage transcribed   # session transcribed, no ISAA facts yet
```

The last line printed is `seeded case=<uuid> session=<uuid> intake=<uuid> token=<token>`.
