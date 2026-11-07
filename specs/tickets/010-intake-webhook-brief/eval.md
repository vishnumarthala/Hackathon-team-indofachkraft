# 010: Intake completion and pre-session brief - Evaluation

## Setup

- Tickets 001, 002 and 009 must be merged into this branch. Start Docker Desktop and the local
  Supabase stack in the main checkout; apply migrations and set up this worktree as described in
  `specs/.super-agent/project.md`.
- Run `npm run -s seed:demo -- --new` for a fresh case and create its intake link. Use unique cases
  for independent tests, not the canonical demo case. Start
  `DEMO_MODE=true ELEVENLABS_WEBHOOK_SECRET=test-secret npm run dev -- -p <port>`.
- Use only synthetic fixtures. Mock network requests and use fake timers in automated tests; do not
  expose localhost or use live provider credentials.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/intake.test.ts tests/intake-completion.test.ts --reporter=verbose` exits 0.
- Tests exercise E-1 through E-5 below, using isolated database cases for transactional and concurrency
  checks, and print explicit case names for each assertion. Keep all temporary files under `.tmp/`.

## Acceptance checks

### E-1: Signed webhook and persistence

- Send the synthetic post-call fixture with the fresh token and a valid signature. Assert status 200,
  one intake recording, 15 mapped case-sheet facts, one brief, case status `intake_done`, and a
  receipt audit event. The brief's Markdown has the FR-4 headings and parent-reported wording.
- Send a bad, missing, old, future, malformed or mismatched signature and assert 401 with no writes.
  An unrelated signed event and an unknown token return the documented ignored result.
- Repeat the same delivery and assert `duplicate: true` and no additional facts or reports.
- Force a fact insert failure and assert the recording, facts, case-status change and receipt audit
  all roll back. Force brief generation to fail separately and assert recording and facts remain,
  `brief: false` is returned, and the failure audit exists.

### E-2: Local completion endpoint

- Mock the provider response for each of `initiated`, `in-progress` and `processing`: each gives
  202 `{ "status": "processing" }`, with no writes. `done` for the expected agent and token returns
  the processed result and persists the same output as the webhook.
- A mismatched agent or token returns 403 with no writes. Invalid body returns 400, an unknown token
  returns 404, and a failed, unknown, malformed or unavailable provider response returns an explicit
  502 without saving the call.
- Send the same conversation concurrently through the endpoint and webhook; assert one recording,
  one set of facts and one receipt audit event, with a successful or duplicate response to both.

### E-3: Client completion lifecycle

- With a mocked session and fake timers, end a connected call and verify the returned conversation ID
  is posted, 202 responses cause non-overlapping retries every three seconds, and a successful
  completion displays the thank-you message.
- Verify a 120-second timeout or a non-2xx response displays an actionable error, does not claim
  success, and allows a completion retry without starting a second call. Verify unmount cancels timers.

### E-4: Demo and therapist review

- In demo mode open a fresh intake link, consent, start the call and select `Simulate completed call
  (demo)`. Verify it uses the fixture without microphone or provider access and completes the intake.
- Open the case's Brief tab and verify the parent-reported badge, summary, red flags, questions and
  reported answers. Mark it reviewed and verify `Reviewed by <therapist_name>`.
- For an intake whose brief generation failed, verify the failure message. Reviewing a case without
  a brief returns 404. Outside demo mode the simulate endpoint returns 404.

### E-5: Processor and document

- Unit tests cover transcript segment IDs, speakers, timing and skipped empty turns; known case-sheet
  fields; red flag citation filtering; and Markdown headings. Inspect the prompt against FR-5.
- Verify no provider key appears in client code or returned responses.

## Definition of done

- [ ] All checks pass and their evidence is recorded in `results.md`.
- [ ] Any migration is additive and tested on the local Supabase stack.
- [ ] The worker stays within affected areas; the builder manually integrates the passing branch.
