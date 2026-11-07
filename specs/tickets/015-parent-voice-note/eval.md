# 015: Parent voice note - Evaluation

## Setup

- `cp <main checkout>/.env.local .env.local`, `npm install`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`
- Base URL: `http://localhost:<port>`
- Test account: none (no login).
- Seed / reset: `npm run seed:demo -- --new --confirmed | tail -1` -> case C, session S; set a parent
  email: `curl -s -X PATCH http://localhost:<port>/api/cases/<C> -H "Content-Type: application/json" -d '{"parent_email":"parent@example.com"}'`;
  generate and finalize the report: `curl -s -X POST http://localhost:<port>/api/sessions/<S>/report` -> report id R;
  `curl -s -X PATCH http://localhost:<port>/api/reports/<R> -H "Content-Type: application/json" -d '{"status":"final"}'`.

## Automated checks

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm test` exits 0
- `npm run build` exits 0
- `npx vitest run tests/parent-voice-note.test.ts --reporter=verbose` exits 0, covering all four
  email statuses across reload, unique audio paths on repeated generation, and cleanup when report
  persistence fails.

## Acceptance checks

### E-1: Create the voice note in demo mode (covers FR-1, FR-2, FR-4, NFR-1, NFR-2)

- **Type:** Browser
- **Steps:**
  1. `agent-browser open http://localhost:<port>/cases/<C>/report`
  2. `agent-browser find role button click --name "Create and send voice note"` (time it)
  3. `agent-browser get text body`
  4. `npm run db:sql -- "select status, audio_path, content_md from reports where recording_id='<S>' and kind='parent_summary'"`
  5. `agent-browser screenshot evidence/E-1.png`
- **Expected:** step 2 completes in < 5 s; step 3 contains `Parent voice note`, Telugu-script text,
  `Voice note skipped in demo mode`, `Email not sent (demo mode)` and `Recreate and send`; step 4 shows
  `final`, `audio_path` null and a `content_md` that contains neither `ISAA` nor `/200`.

### E-2: TTS client (covers FR-3, FR-5)

- **Type:** CLI
- **Steps:**
  1. `npx vitest run tests/tts.test.ts --reporter=verbose`
- **Expected:** exits 0 with tests for voice per language, `No voice configured for te` when
  `ELEVENLABS_VOICE_ID_TE` is empty, request to `/v1/text-to-speech/<voice>` with `model_id` `eleven_v3`
  and header `xi-api-key`.

## Edge cases

### E-3: Preconditions (covers FR-2)

- **Type:** API
- **Steps:**
  1. `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/reports/00000000-0000-4000-8000-00000000ffff/parent-voice-note`
  2. `npm run seed:demo -- --new --confirmed | tail -1` -> S2; `curl -s -X POST http://localhost:<port>/api/sessions/<S2>/report` -> R2 (draft); `curl -s -w " %{http_code}" -X POST http://localhost:<port>/api/reports/<R2>/parent-voice-note`
  3. `agent-browser open http://localhost:<port>/cases/<case of S2>/report` and `agent-browser get text body`
- **Expected:** step 1 `{"error":"Report not found"} 404`; step 2 `{"error":"Finalize the report first"} 422`;
  step 3 does not contain `Parent voice note`.

### E-4: TTS and email failures (covers FR-2, FR-3)

- **Type:** automated route test
- **Steps:** `npx vitest run tests/parent-voice-note.test.ts --reporter=verbose` with mocked provider,
  storage and email.
- **Expected:** verify successful unique audio storage, missing voice 422, provider failure 502,
  email failure status, persisted status after reload, and cleanup when report persistence fails.
  No live credentials or server restart are needed.

## Traceability

| Requirement | Checks |
|-------------|--------|
| FR-1 | E-1, E-3 |
| FR-2 | E-1, E-3, E-4 |
| FR-3 | E-2, E-4 |
| FR-4 | E-1 |
| FR-5 | E-2 |
| NFR-1 | E-1 |
| NFR-2 | E-1 |

## Definition of done

- [ ] All automated checks pass
- [ ] All acceptance checks E-1...E-2 pass
- [ ] All edge-case checks pass
- [ ] No items from "Out of scope" were built
- [ ] Nothing listed under "Don't touch" changed
- [ ] Evidence (screenshots, logs) saved in `evidence/` and listed in `results.md`
