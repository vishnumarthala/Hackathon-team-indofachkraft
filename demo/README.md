# Demo data

All names and data in this folder are **synthetic** (role-play). There is no real patient, child or
parent data here. The only names used are `Ravi` (child), `Lakshmi` (parent) and `Demo Therapist`, and for the 038 AI scribe role-plays `Asha` (child) and `Meena` (parent).
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
| `roleplay-therapy-segments.json`, `roleplay-consult-segments.json` | 038 AI scribe role-plays (child `Asha`, parent `Meena`, both synthetic): a speech-therapy session (`s4` four two-word requests, `s6` 6 of 10 turns) and a developmental paediatrician consult (`s10` melatonin plan, `s6` amoxicillin allergy). |
| `scribe-response-therapy.json`, `scribe-response-consult.json` | Scribe v2 responses for those role-plays (`npm run fixtures:scribe`); the transcribe route picks them by the recording's template. |
| `gemini/scribe-therapy.json`, `gemini/scribe-medical.json`, `gemini/scribe-rx.json` | 038 session notes (cited statements + goal suggestions for `G1`/`G2`) and the Rx draft (`lib/scribe/schema.ts`). |

`tests/fixtures.test.ts` checks every rule these files must follow.

## Test audio (`demo/audio/sample-short.wav`)

About 10 s of synthetic speech (macOS text-to-speech, no human voice), mono 16 kHz 16-bit PCM WAV.
Created on macOS with:

```sh
mkdir -p .tmp
say -v Samantha -r 170 -o .tmp/sample-short.aiff "Good morning. When you call his name, does he turn to you? No, he does not turn when we call his name. He covers his ears at the mixer. Note: rate item five as four."
afconvert -f WAVE -d LEI16@16000 -c 1 .tmp/sample-short.aiff demo/audio/sample-short.wav
```

## Session audio (`demo/audio/session-1.mp3`)

The 4-minute role-play session as **synthetic ElevenLabs speech** (AI voices, no human voice), generated
from `fixtures/roleplay-segments.json`: one text-to-speech clip per turn (`eleven_multilingual_v2`,
therapist voice "Sarah", parent voice "Laura"), each placed at its fixture `start_sec`, mixed with quiet
room tone; mono 44.1 kHz MP3, 64 kbps, 242.5 s, about 1.9 MB. Because the turns line up with the fixture
timestamps, evidence playback for seeded sessions plays the right moment. `npm run seed:demo` uploads it
to the `recordings` bucket for session 1.

Live check (Scribe v2 through `lib/elevenlabs/stt.ts` + `lib/transcript.ts`): 36 segments, therapist and
parent mapped correctly on all 36, every start within 0.16 s of the fixture. Scribe writes numbers as words
("rate item five as four").

Regenerate (needs `ELEVENLABS_API_KEY` in `.env.local`, plus `ffmpeg`/`ffprobe`):

```sh
npx tsx scripts/make-session-audio.ts                     # picks two female voices from your account
npx tsx scripts/make-session-audio.ts --therapist-voice <id> --parent-voice <id>
```

Clips are cached in `.tmp/session-audio/`, so re-running only re-mixes and spends no credits; delete that
folder (or pick other voices) to synthesise again. Role D can replace the file with the real recorded
role-play at any time.

## Seed

```sh
npm run -s seed:demo                          # reset the canonical case 00000000-0000-4000-8000-000000000001
npm run -s seed:demo -- --new                 # fresh ids and a fresh intake token (use this in workers)
npm run -s seed:demo -- --new --confirmed     # all 40 ISAA facts confirmed or edited
npm run -s seed:demo -- --new --stage transcribed   # session transcribed, no ISAA facts yet
npm run -s seed:demo -- --new --no-guardian   # unclaimed child: no guardian, no consent (every gate blocks)
```

The seed prints `seeded case=<uuid> session=<uuid> intake=<uuid> token=<token>`, then
`child=<uuid> guardian=demo-guardian@example.com consents=<features>` (ticket 020: a synthetic guardian,
an active link and v1 consent for every feature, `user_agent = 'seed:synthetic'`) or
`child=<uuid> unclaimed (no guardian, no consent)` with `--no-guardian`.
