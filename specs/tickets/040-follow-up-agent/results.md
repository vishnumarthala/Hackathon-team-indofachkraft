# 040: Follow-up agent ("ask about my child's plan") - Results

Branch: `ticket/040-follow-up-agent` (base: main with 017-039, 041, 042 merged; `main` merged again before the final
run). Tested against the isolated local Supabase stack of DB slot 8 (all migrations re-applied with `supabase db reset`,
including the new `20261113004000_followup.sql`), `DEMO_MODE=true` (default `demo/fixtures`), `ELEVENLABS_TOOL_SECRET`
set to a local test value, dev server on port 3080, own headless Chromium (playwright-core in the worker's session
folder). Synthetic accounts from `npm run -s seed:users -- --prefix e040` plus `evidence/seed.ts.txt` (guardian_a's
child with a published IEP v1 and an unpublished v2 goal, a published home program, a draft report and a final parent
summary, a signed and a voided prescription; guardian_b's child with its own published plan; `ai_follow_up` granted for
guardian_a's child only). Evidence in `evidence/` (`acceptance.txt` = 31-check scripted API + browser run,
`acceptance.cjs.txt` the script, `vitest-040-verbose.txt`, screenshots at 375 px).

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0 on the merged tree; build lists `/family/children/[id]/ask`, `/family/children/[id]/ask/sources/[type]/[entityId]/[version]`, `/api/family/children/[id]/ask`, `/api/agents/followup/{session,tools/answer_question,demo/answer_question}` |
| `npx vitest run` (DB suites run, not skipped) | PASS | 90 files, 1506 passed, 11 skipped (the opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl without `NO_TRACKING_BASE_URL`); two consecutive green runs on the merged tree (see Notes for two unrelated intermittent failures seen once each) |
| `npx vitest run tests/followup-context.test.ts tests/followup-safety.test.ts --reporter=verbose` | PASS | 2 files, 37 tests (pure + database), `evidence/vitest-040-verbose.txt` |
| NFR-1 context: IEP v1 in, v2 draft out | PASS | `loadGuardianContext` contains the published goal wording, not the goal added after publishing; plan cited at `version: 1` |
| NFR-1 context: no draft report, no hidden report/note, no voided Rx, no transcript, nothing of guardian_b's child | PASS | draft parent summary, the provider-only assessment report (`# Report (synthetic)`), a not-shared session note, the voided prescription (and its `Prescription cancelled` notice), the recording's transcript line, the guardian's own practice-log note and the other child's plan are all absent; shared session note, final parent summary, signed prescription and this week's adherence (`done 1 of 5 times this week`) are present; documents newest first |
| NFR-1 revoked link | PASS | `loadGuardianContext` -> null; `POST/GET /api/family/children/:id/ask` -> 404; a voice session started before the revocation -> tool call 401 (session ended) |
| Red-flag phrases bypass the model | PASS | 17 phrases across all 9 codes (033's six + `medicine_overdose`, `unconscious`, `suicidal`) classified; plan questions ("not eating vegetables", "not talking much yet", the 3 suggestions) are not; pipeline: model spy not called, nothing stored, audit `followup.red_flag` `{ code, channel }` without text |
| Dose-change questions return the fixed message | PASS | `Can I double the syrup dose?` (and stop / skip / less / also give / increase) -> `Please don't change any medicine without talking to the prescriber.`, `safety: "medical_advice"`, no model call; `How do I give the medicine?` goes to the model and cites the prescription; a model answer suggesting a change is replaced by the fixed message |
| Rate limit | PASS | 30 per guardian per rolling 24 h: two concurrent requests for the last slot -> one 200, one 429, exactly 30 rows; a red flag still gets the 108/112 answer at the limit; rows older than 24 h no longer count |
| E-1 grounded answers (FR-1, FR-2, FR-4) | PASS | `What should we practise this week?` -> `found: true`, citation `{ entity_type: "home_program", entity_id, version: 1, label: "Home program: Home practice, term 1 (v1)", excerpt }`; browser: suggestion button -> answer card with the chip -> chip opens `/family/children/<id>/ask/sources/home_program/<id>/1` showing that version (`evidence/ask-answer-375.png`, `ask-source-375.png`); `What time does the school bus come?` -> `I couldn't find that in your child's shared plans. Please ask your provider using Messages.` with an `Open Messages` link to `/family/messages` |
| E-2 safety (FR-2, FR-3) | PASS | dose question -> fixed medicine message + `safety: "medical_advice"`; `My child is not breathing properly` -> 033's 108/112 message, `safety: "red_flag"`; dev-server log `followup model call` count unchanged (4 -> 4: the DEMO fixture reader logs every model call) and the test's fixture-reader spy saw no read; one `followup.red_flag` audit row `{ code: "breathing", channel: "text" }`, `actor_role = guardian`, no text; question not stored. UI shows only the red alert (`ask-red-flag-375.png`) |
| E-3 consent and authz (FR-2, NFR-1) | PASS | guardian_b on own child without `ai_follow_up` -> 422 `{ details: { feature: "ai_follow_up" } }` (also on voice session start); guardian_b on guardian_a's child -> 404 (API, history, voice start and the page); provider -> 403; anonymous -> 401. Page without consent: no input, link to the child's permissions (`ask-no-consent-375.png`) |
| E-4 voice (FR-5) | PASS | `POST /api/agents/followup/session` -> 201, 15-minute token as the only dynamic variable (hash stored); mocked agent tool call `POST /api/agents/followup/tools/answer_question` with `X-Agent-Secret` -> the same answer and citations as the text endpoint, stored with `channel = voice`; no/wrong secret -> 401; unknown token -> 401; guardian_b using guardian_a's session through the DEMO route -> 401; expired -> 401; after a red flag by voice -> 401; after `DELETE` (with conversation id) -> 401. Browser: DEMO voice panel answers through the same handler (`ask-voice-demo-375.png`) |
| FR-4 UI | PASS | 375 px, no horizontal scroll; `Ask about Asha (synthetic)'s plan` label, three suggested questions, disclaimer `AI answers from your child's shared plans. It is not medical advice.`, newest-first history with `Asked by voice` marker and remaining-questions counter; Hindi chrome (`hi` disclaimer) translated; link `Ask about the plan` on the child page |
| FR-5 CSP / allowlist | PASS | `/family/children/<id>/ask` CSP has the ElevenLabs `connect-src` hosts, `/family/children/<id>` does not; `tests/no-tracking.test.ts` (subset check) passes; live crawl with `NO_TRACKING_BASE_URL` 28 pages incl. `/ask` and the sources page, no third-party script |
| FR-6 logging, history, retention, registry | PASS | `followup_questions` rows with question, answer, citations, safety, channel; history = the asking guardian's own (a second guardian of the same child sees none); retention step removes rows older than 90 days; registry `followup_questions`: export only the requesting guardian's rows, erasure returns the ElevenLabs conversation ids |
| NFR-2 p95 < 6 s | PASS | 10 DEMO-fixture questions against the dev server: max 50 ms (first compile of the route ~0.8-1.5 s); live Gemini call capped at 5.5 s (`MODEL_TIMEOUT_MS`, then 502) |

## Deviations

- **No live ElevenLabs agent, Gemini key or tool secret.** The voice path is built behind the existing patterns (private
  agent, `startAgentSession(agentId)`, server tool with `X-Agent-Secret` + per-conversation session token) and tested
  with the tool route called directly ("mocked agent tool call") and a DEMO_MODE voice panel (typed speech, answer read
  aloud by the browser's Web Speech API, same tool handler). The agent must be created by hand from
  `docs/elevenlabs-followup-agent.md` and its smoke test (section 10) run once (human task). Until
  `ELEVENLABS_FOLLOWUP_AGENT_ID` and `ELEVENLABS_TOOL_SECRET` are set (outside DEMO_MODE) the page offers the text chat only.
  DEMO answers come from `demo/fixtures/gemini/follow-up.json` (keyword-picked canned answers citing `HOME1`/`PLAN1`/`RX1`/`NOTE1`),
  still resolved against the real authorised context (a cited document that does not exist -> not-found).
- **`lib/ask/citations.ts` not generalised.** The rd lists it under affected areas, but 013's specialist citations
  (facts/segments with audio moments) and its behaviour are on the don't-touch list; the follow-up agent cites documents,
  so its citation type lives in `lib/followup/constants.ts` (`FollowupCitation`). 013 is reused for the 60,000-character
  limit (`MAX_CONTEXT_CHARS`), the reservation-row question limit and the "resolve against what was sent" rule.
- **The shared red-flag classifier is new** (`lib/clinical/red-flags.ts`): 033 asks yes/no red-flag questions and has no
  free-text classifier. It uses 033's codes and fixed `URGENT_MESSAGE`, plus `medicine_overdose`, `unconscious`,
  `suicidal`. Deliberately broad; picky eating / late talking are excluded so plan questions are not blocked.
- **Red-flag questions are not stored** (not in `followup_questions`, not counted against the daily limit): the audit row
  keeps only the code and channel (FR-3 "no question text"). They are answered even at the daily limit.
- **Condition questions** ("Does my child have autism?") get a fixed sentence (`I can't say whether your child has a
  condition. Please ask your provider using Messages.`) with `safety: "medical_advice"`, without a model call (FR-2
  "never diagnose"; the rd defines no separate safety value).
- **Citation viewer shows the current authorised version.** The chip opens `/ask/sources/<type>/<id>/<version>`; when
  the cited version is still the guardian's current one it is shown as cited; if a newer version was published the page
  shows the current one with "This document has been updated since the answer"; withdrawn, cancelled (voided Rx) or
  foreign documents show "not shared with you". Older versions are never re-served (a newer hidden or cancelled version
  withdraws them, rule 9).
- **Rate limit window** is a rolling 24 hours per guardian (all children, text + voice), not a calendar day.
- **Voice session cap**: 20 tool calls per 15-minute session (like 034) on top of the daily limit; the agent gets only
  the session token (no child or guardian name). The optional ElevenLabs conversation id is attached by the browser on
  `DELETE /api/agents/followup/session` so erasure can delete the processor's copy.
- **`listGuardianPrescriptions` (039) gained a `version` field** (number of the latest published version) for citations
  (additive).
- **Questions and answers are English**; suggested questions are English literals (the agent and the classifiers are
  English, D-3); all UI chrome is translated (`followup` namespace, Hindi/Telugu drafts `pending` in `messages/REVIEW.md`).

## Notes

- **Migration** `supabase/migrations/20261113004000_followup.sql`: `followup_questions`, `followup_agent_sessions`
  (new tables only, RLS on, no browser grants).
- **New helpers:** `lib/followup/{constants,context,model,answer,store,session,tool}.ts`
  (`loadGuardianContext`, `loadGuardianDocs`, `buildFollowupContext`, `answerQuestion`, `handleAnswerTool`,
  `reserveQuestion`/`listHistory`, `createFollowupSession`/`chargeToolCall`/`endFollowupSession`),
  `lib/clinical/red-flags.ts` (`classifyRedFlagText`, `TEXT_RED_FLAG_CODES`; reusable by other agents),
  `components/followup/{FollowupChat,AnswerCard,FollowupVoice,LiveFollowupCall}.tsx`, `prompts/follow-up.md`.
- **Env:** `ELEVENLABS_FOLLOWUP_AGENT_ID` (optional), `RETENTION_FOLLOWUP_DAYS` (optional, default 90); reuses
  `ELEVENLABS_TOOL_SECRET` (034). `.env.example`, `lib/env.ts`, `docs/system-design.md` updated.
- **Shared files touched additively:** `lib/csp.ts` (`/family/children/*/ask` ElevenLabs `connect-src`; the 041
  allowlist entry already existed), `lib/auth-access.ts` (public `/api/agents/followup/tools/`), `lib/privacy/registry.ts`
  (`followup_questions`), `lib/privacy/retention.ts` (`purgeFollowupQuestions`, count key `followup_questions`),
  `lib/rx/index.ts` (`version`), family child page (one link), `app/privacy/page.tsx` + `privacy.notice.collect.followUp`,
  `messages/*.json` (`followup` namespace), `messages/REVIEW.md` (regenerated), `demo/README.md`, docs
  (`docs/elevenlabs-followup-agent.md` new, `docs/system-design.md` section 13c + env/API rows, `docs/consent.md`,
  `docs/privacy/{processors,retention}.md`). `lib/i18n/translate.ts` unchanged.
- **Consent:** `requireConsent(childId, "ai_follow_up")` on the ask route, at voice-session start and on every tool call;
  `assertConsentOrAbort` before each question reaches the model.
- **Audit:** `followup.red_flag` and `followup.question_asked` are best-effort `audit()` rows attributed to the guardian
  (no question or answer text); not strict actions (no security-critical write).
- **Merge with `main` (042 Hyderabad seed, 036 ratings, 035 intake):** conflicts only in `messages/{en,hi,te}.json`
  (deep union, no clashes), `messages/REVIEW.md` (regenerated, 2485 rows) and `app/privacy/page.tsx` (`COLLECT` keeps
  `followUp` and 036's `ratings`). Slot 8 reset afterwards; all checks above re-run on the merged tree.
- **Intermittent failures seen once each in full parallel runs, unrelated to 040** (both pass alone and in the two
  following full runs): `tests/documents-access.test.ts` (notification rows / list count) and
  `tests/appointment-intake.test.ts` (`This link is not valid.`). They look like cross-suite races in shared tables
  (outbox / appointments); not changed here.
- The browser run logged one React hydration warning about input attributes after the screenshot step (the same
  `caret-color` tooling artefact noted by 024/033); a clean page load of the ask page logs no errors.
- The e040 acceptance data (accounts, synthetic children, cases, plan, program, prescriptions) is left in the slot 8
  database.
