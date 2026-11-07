# 009: Intake link and browser voice call - Evaluation

## Setup

- Start Docker Desktop and the local Supabase stack in the main checkout. Apply migrations and install
  dependencies in this worktree as described in `specs/.super-agent/project.md`.
- Ensure tickets 001, 002 and 004 are available on the branch. Run
  `npm run -s seed:demo -- --new` and note the printed case ID and intake token; use a fresh seed for
  each run. Run `DEMO_MODE=true npm run dev -- -p <port>` and use `http://localhost:<port>`.
- Use only synthetic data. Live provider and microphone checks belong to the manual smoke test in
  `rd.md`; automated checks use mocks and do not require provider credentials.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/intake-message.test.ts --reporter=verbose` exits 0; tests cover exact message
  text and WhatsApp URL encoding with and without a phone number.
- `npx vitest run tests/intake-call.test.ts tests/intake-routes.test.ts --reporter=verbose` exits 0.
  Mock provider, database and browser boundaries for the applicable E-2 through E-4 scenarios,
  including failures and secret isolation. Browser appearance and the agent guide are reviewed
  separately in E-2 and E-5.

## Acceptance checks

### E-1: Create and share an intake link

1. Open the fresh seeded case's Brief tab. Confirm `Intake call` and `Create intake link` are shown.
2. Select `Create intake link`. Verify the displayed URL contains the case's intake token, copying
   copies that URL, and the WhatsApp link opens in a new tab with the exact message in FR-2.
3. Repeat creation and verify the same URL is returned and only one `intake.link_created` audit event
   exists for the case.
4. With a case without parent email, verify `Email to parent` is disabled with the specified title.
   With a case with email, test delivery, demo mode and delivery failure using a mocked sender; verify
   the corresponding FR-1 status and FR-2 response and audit event.

### E-2: Intake page, consent and language

1. Open a valid token on a 375-pixel-wide viewport. Verify the child alias, AI disclosure,
   recording disclosure, language options and case-language default match FR-3, with no horizontal
   scrolling and a Start button at least 44 pixels high.
2. Verify Start is disabled until consent is checked. Select each language and verify its `en`, `hi`
   or `te` value is posted to the start endpoint.
3. Open an unknown token and verify the invalid-link page. For a case with an intake recording, verify
   only the completion thank-you message is shown.

### E-3: Demo and live-call control

1. In demo mode, start the call after consent. Verify `Demo mode: no live call.` and `#demo-actions`;
   verify microphone access and the ElevenLabs SDK are not invoked.
2. With the live start endpoint and SDK mocked, verify `connecting`, `connected`, and post-connection
   `disconnected` display the specified messages. Verify End calls `endSession`.
3. Mock microphone denial and SDK failure separately; verify the specified errors and that the user
   can retry. Verify a non-2xx start response displays its API error.

### E-4: API and server boundaries

Use automated route tests with isolated seeded cases and mocked sender/provider responses:

- Unknown token returns the FR-5 404; an existing intake recording returns 409. Demo mode returns
  `{ "demo": true }`; live mode returns the token, agent ID and all dynamic variables from FR-5.
- A provider failure returns the specified 502. A successful start records `intake.started` with
  actor `parent`. An invalid case ID on the link endpoint returns the FR-2 404; requesting email
  without an address returns 422.
- Mock the provider HTTP call and verify the token endpoint URL, agent ID and `xi-api-key` header from
  FR-6. Confirm the API key is absent from browser responses and client bundles.

### E-5: Agent setup guide

Review `docs/elevenlabs-agent.md` against every item in FR-7, including the exact first message and
system prompt, all case-sheet fields, language settings and environment variable names. Do not send
a webhook to localhost; the separate local-completion feature belongs to ticket 010.

## Definition of done

- [ ] All automated and acceptance checks pass, with evidence recorded in `results.md`.
- [ ] The worker remains within the affected areas and does not build the 010 completion feature.
- [ ] A builder reviews results and manually merges the passing ticket branch into `int/<role>`.
