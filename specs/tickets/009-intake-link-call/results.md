# 009: Intake link and browser voice call - Results

Branch: `ticket/009-intake-link-call` (base `int/a-voice`, includes 001, 002, 004, 005). Tested against the
shared Supabase cloud project, `DEMO_MODE=true`, port 3001, headless Chrome (playwright-core installed
outside the repo). Test cases were deleted afterwards.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run verify` | PASS | 155 tests |
| `tests/intake-message.test.ts` | PASS | exact message; WhatsApp URL with/without phone; encoding |
| `tests/intake-call.test.ts`, `tests/intake-routes.test.ts` | PASS | mocked SDK, mic, fetch, sender, provider, DB queries |
| E-1 create and share | PASS | `Intake call`, `Create intake link`; URL holds the token; clipboard = URL, button shows `Copied`; WhatsApp `target=_blank`, decoded text = FR-2 message; reload/repeat -> same URL, one `intake.link_created`; no email -> disabled + title; with email in demo -> `Email not sent (demo mode)` + `intake.link_emailed`; delivered / Resend failure via mocked sender in route tests - `evidence/browser-checks.txt`, `evidence/brief-link.png` |
| E-2 intake page | PASS | 375 px: no horizontal scroll, Start 48 px tall; heading, disclosure, options, default `te`; Start disabled until consent; `en`/`hi`/`te` posted; unknown token 404 `This link is not valid.`; completed case shows only the thank-you - `evidence/intake-375.png` |
| E-3 demo and live control | PASS | browser: `Demo mode: no live call.`, `#demo-actions`, no mic request (`evidence/intake-demo.png`). Live path (unit, mocked): status texts, `End call` shown when connected, startSession args, mic denial, SDK failure, non-2xx error text. `End call` -> `endSession()` is wired directly; not click-tested (no DOM test environment in the repo) |
| E-4 API and server boundaries | PASS | 404/409/400/demo/live/502 and `intake.started` (actor `parent`) in route tests; link 404/422 in browser + curl; FR-6 URL, agent id, `xi-api-key`; key absent from responses; `check-env-usage` -> `server only`; 0 hits for `xi-api-key` in `.next/static`; `check-client-imports` clean |
| E-5 agent guide | PASS | `docs/elevenlabs-agent.md`: name, private agent, Hindi + Telugu with voices, language override, 900 s, 5 dynamic variables + `intake_token` warning, exact first message and system prompt, 15 case-sheet fields, HMAC `post_call_transcription` webhook, env var names |

## Bugs found and fixed during the browser run

- The browser `fetch` was passed as a detached method (`Illegal invocation`), so Start always showed
  `Could not start the call`. Now wrapped in an arrow function. Unit tests in Node could not see this.
- The intake page rendered a second `<main>` inside the root layout's `<main>`; it is now a `<div>`.

## Notes

- The root layout's header (`CareThread`, `Dashboard` link) also shows on the public parent page. The
  layout is not in 009's affected areas; worth a follow-up so parents don't see a therapist link.
- Not done here (manual, after merge): the live smoke test in `rd.md` with real ElevenLabs credentials
  and the agent configured from `docs/elevenlabs-agent.md`.
