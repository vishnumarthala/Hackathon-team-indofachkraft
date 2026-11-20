# CareThread jury video

A 3-minute animated pitch video (1920×1080, 30 fps), built with [Remotion](https://www.remotion.dev/)
in the pitch deck's colours and fonts. Output: `out/carethread-jury.mp4`.

It is a separate package so the app's dependencies stay untouched (the root `tsconfig.json` and
`eslint.config.mjs` ignore `video/`).

## Render

```sh
cd video
npm install
npm run voice    # narration -> public/voice/*.mp3 + src/voiceover.json (scene lengths follow the audio)
npm run render   # -> out/carethread-jury.mp4
npm run studio   # optional: preview and scrub in the browser
```

## Narration

- `npm run voice` uses ElevenLabs text-to-speech (`eleven_multilingual_v2`) with the key from the repo's
  `.env.local` / environment: `ELEVENLABS_API_KEY` or `ELEVEL_LABS_KEY`. It must be a secret API key
  (starts with `sk_`), not a key ID. It picks an Indian-accented female voice when the account has one;
  choose another with `npm run voice -- --voice <voice_id>`.
- With a working key it also composes a quiet instrumental music bed (ElevenLabs Music); skip it with `--no-music`.
- Without a working key it falls back to the macOS `say` voice "Tara" (placeholder quality, no music),
  so the video still renders. Fix the key and run `npm run voice` + `npm run render` again.
- Clips are cached in `../.tmp/video-voice/`, so re-runs only pay for changed lines.
- The intake-call excerpt is cut from `../public/landing/sample-intake-call.mp3` (synthetic role-play).

## Edit

- Words: `src/script.ts` (one line per scene). On-screen cues follow phrases in these lines (`cue()` in
  `src/timing.ts`), so keep the cue phrases used by the scenes, or update them.
- Team line / live link on the end card: `src/config.ts`.
- Scenes: `src/scenes/*.tsx`; shared building blocks: `src/components/`.
- Total length is the sum of the narration plus short pauses. Aim for 2:50 to 3:00, and check it after
  changing the voice: `npx remotion compositions`.
