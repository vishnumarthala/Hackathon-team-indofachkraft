# 038: AI scribe for any provider type - Results

Branch: `ticket/038-ai-scribe` (base `f5ce41e`: 017-025, 028, 029, 032 and 041 merged). Tested against the isolated
local Supabase stack `dnmslot8` (all 21 migrations applied by `dnm-db.sh 8 <worktree> reset`), `DEMO_MODE=true`, dev
server on port 3080, own headless Chromium (playwright-core driving the cached Chromium, scripts in `.tmp/e038/`, not
committed). Accounts from `npm run -s seed:users -- --prefix e038 --extra-member` plus a synthetic verified
paediatrician (`e038-provider-rx`, NMC) and an SLP profile for `provider_a`; synthetic child `Asha (synthetic)` linked to
guardian_a with every 020 feature granted (digital) and an active, published IEP plan with 2 goals (count and percent).
Raw evidence in `evidence/`: `acceptance.txt` (scripted browser/API run, 30 checks, all PASS), screenshots,
`vitest-038-verbose.txt` (the eval test command).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113003800_scribe.sql` | PASS | `db reset` applies all 21. `recordings.kind` + `consult`; `template` (default `child_dev_isaa` = backfill of every existing row, check + kind/template consistency), `uploaded_by`, `appointment_id`; `reports.kind` + `session_note`, `rx_draft`; `goal_progress_suggestions` (trigger: case from recording, goal of the same case, value inside the measure; RLS care team read only); 024's `reports_publish_final` skips the two new kinds |
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | exit 0; new routes in the build (`/api/sessions/[id]/scribe`, `/api/goal-suggestions/[id]`, `/family/children/[id]/notes`) |
| `npx vitest run` | PASS | 70 files, 1056 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl); every DB suite ran against slot 8, including 024's regression and 025/041's suites |
| `npx vitest run tests/scribe.test.ts tests/regression-child-dev.test.ts --reporter=verbose` | PASS | 2 files, 25 passed, 0 skipped (`vitest-038-verbose.txt`): template routing by provider type; Zod validation of each fixture (and rejection of wrong shapes); every citation points to an existing, verified segment of its DEMO transcript; idempotent re-run keeps final notes and decisions; Rx draft only for verified prescribers (and removed when the prescriber is suspended); consent withdrawn between transcription and scribe -> `consent_withdrawn`, recording `failed`, audit `consent.blocked_processing`, Gemini never called; ISAA regression byte-identical to the 024 baseline |
| `npm run verify` | PASS | exit 0 (lint, typecheck, 70 files / 1056 passed / 11 skipped, build) |
| E-1 therapy note + goal progress | PASS | provider_a (SLP): `Session type` defaults to `Therapy session note`; UI upload of `demo/audio/sample-short.wav` with the in-clinic appointment -> transcribe -> scribe -> review page: draft note with 13 clickable citation buttons (audio jump), 2 goal suggestions with quotes (`G1` count 4 / `G2` 60%), AI label on every output (`e1-therapy-review.png`). `Accept` on G1 -> `goal_progress` `{ value: 4, source: ai_suggested_confirmed, recording_id }`; guardian_a's plan chart shows `Latest: 4` (`e1-guardian-plan-375.png`); `Reject` on G2 -> no progress row (`e1-decided.png`) |
| E-2 medical consult with Rx draft | PASS | provider_rx (verified paediatrician, NMC) -> `medical_consult_note` (`kind = consult`) -> 200 with `rx_draft_id`; the card shows `Melatonin 2 mg tablet ...` and `Review in prescriptions` -> `/cases/<id>/prescriptions?from_report_id=<rx_draft id>` (`e2-rx-draft.png`). provider_a (non-prescriber) with the same consult audio -> no `rx_draft`; provider_a's GET of the prescriber's session shows `rx_draft: null` |
| E-3 guards | PASS | upload for the video appointment -> 422 `The AI scribe is available for in-clinic sessions only` (also re-checked by the scribe step when an appointment turns video, DB test); guardian_a withdraws `ai_extraction` in the portal API -> scribe 422 `Guardian consent required` (`details.feature = ai_extraction`) before any Gemini request, AI scribe upload 422; re-grant -> 200. Guardian notes page empty for the draft and for the finalized-but-not-shared note; after `Share with family` it shows the note without audio links, 375 px wide (`e3-final-shared.png`, `e3-guardian-notes-375.png`); guardian on the scribe API -> 403 |
| E-4 authz negatives | PASS | provider_b (other org): `POST`/`GET /api/sessions/:id/scribe` -> 404 `Session not found`, `PATCH /api/goal-suggestions/:id` of org A's case -> 404 `Suggestion not found`, review page 404; DB test adds the unassigned org A member (404) and guardians (403) |
| FR-6 ISAA regression | PASS | `tests/regression-child-dev.test.ts` unchanged and green (facts, score, band, report, referral, parent voice note, Gemini prompts identical); ISAA sessions answer 409 on the scribe route; scribe sessions answer 409 on `extract`/`report` and never enter the Report tab's session list or the referral packet |
| NFR-1 no AI output to guardians before finalize + share | PASS | `listGuardianSessionNotes` = latest published version of a **final** `session_note` when `visible_to_guardian`; finalize defaults to not visible; drafts/suggestions/Rx drafts have no guardian reader; 041 export only contains shared versions |
| NFR-2 DEMO fixtures | PASS | `demo/fixtures/gemini/scribe-{therapy,medical,rx}.json` + per-template Scribe role-plays `scribe-response-{therapy,consult}.json` (`npm run fixtures:scribe`, deterministic); tests mock nothing but auth (Gemini spy passes through to the fixtures) |
| NFR-3 copy rules | PASS | prompts and fixtures free of the banned stem (test + `scripts/dev/check-copy.mjs` clean on all new files); AI statements rewritten by `applyCopyRules`; sharing a note that names a condition -> 422 |

## Deviations

- **`appointment_id` without FK, stand-in appointments table in tests.** 030 (appointments) and 035 are not on this base.
  `recordings.appointment_id` is a plain uuid; `lib/scribe/appointments.ts` reads `public.appointments` only if it
  exists and only as JSON (`service_snapshot.mode` / `mode` / `meet_url`, `slot`), so it works with 030's schema without
  a code change. The DB test and the live run create a minimal stand-in table only when the real one is missing (and drop
  it afterwards). 035 should add the FK.
- **`Review in prescriptions` link** points to 039's future `/cases/:id/prescriptions?from_report_id=<id>` (039 FR-3
  shape) and 404s until 039 merges.
- **Who can prescribe** = the **uploader's** own provider profile (`provider_can_prescribe`, FR-4); the Rx draft card and
  `GET .../scribe` `rx_draft` are shown only to viewers who can prescribe themselves (039: non-prescribers never see
  prescription features). A re-run by/for a prescriber who lost verification deletes the draft Rx.
- **Consent at upload**: AI scribe templates also require `ai_transcription` and `ai_extraction` at
  `POST /api/cases/:id/sessions` (FR-3 "apply at upload"); the ISAA template keeps 020's behaviour (`session_recording`
  only) so the Child Development flow is unchanged.
- **Session notes publish outside the 024 trigger**: `reports_publish_final` (replaced in this migration, same body)
  skips `session_note`/`rx_draft`; `finalizeSessionNote` calls `publishVersion` itself with the clinician's choice.
  The published text has the `[mm:ss](#seg-…)` audio links removed (guardians never get the recording); the provider's
  `reports.content_md` keeps them.
- **Additions not named in the rd**: `GET` and `PATCH` on `/api/sessions/:id/scribe` (note save / finalize / share or
  stop sharing a final note), `goal_progress_suggestions.case_id` + `decided_value`, `recordings.uploaded_by`,
  `/family/children/:id/notes` (guardian view of shared notes, linked from the child page), `lib/authz.ts`
  `requireRecordingActor`, strict audit actions `scribe.note_finalized` and `scribe.note_sharing_changed`, a privacy
  notice line (`privacy.notice.collect.scribe`).
- **Accept is two steps** (claim the suggestion, then 025 `recordProgress` in its own transaction, then link
  `progress_id`); a failing `recordProgress` (plan closed, goal discontinued, value out of range) puts the suggestion
  back to `suggested`. 025's function was not changed.
- **Child Development sessions do not get a scribe note** (409): they keep the ISAA form, report and referral exactly
  as before (FR-6).
- Hindi/Telugu strings of the new `scribe` namespace are drafts (`messages/REVIEW.md` regenerated, rows `pending`).

## Notes

- **For 039:** `reports` `kind = 'rx_draft'`, `status = 'draft'`, `content` = `RxDraftContent` (`lib/scribe/schema.ts`;
  items in 039's FR-2 shape + `citations`, `advice`, `follow_up`, `health_summary`). Prefill from `from_report_id`; check
  `provider_can_prescribe` again at signing. `rxReviewPath(caseId, reportId)` in `lib/scribe/templates.ts`.
- **For 030/035:** see "Appointments" in `docs/scribe.md`; add the FK on `recordings.appointment_id`; the upload form
  lists the child's appointments of the case's org (video ones disabled) as soon as `public.appointments` exists.
- **For 040:** shared session notes are `published_versions` rows (`entity_type = 'report'`, report kind
  `session_note`) with `visible_to_guardian`; read them with `listGuardianVisible` or `listGuardianSessionNotes`.
- **New helpers:** `lib/scribe/{templates,schema,process,appointments,run,notes,suggestions,queries}.ts`,
  `components/scribe/ScribeReview.tsx`, `lib/authz.ts` `requireRecordingActor`; `lib/elevenlabs/stt.ts`
  `transcribeAudio({ demoFixture })`; `UploadPanel` `scribe` prop and `runFlow({ template, appointmentId })`.
- **Shared files touched (additive):** `lib/clinical/reports.ts` (`inUse`), `lib/types.ts`, `lib/queries/{recordings,
  cases,reports,referrals}.ts`, `lib/referral/packet.ts`, `lib/extraction.ts` + extract/report routes (ISAA template
  only), `lib/speakers.ts` (consult), `lib/privacy/{registry,retention}.ts`, `lib/audit/strict-actions.ts`,
  `lib/consent/features.ts`, `app/api/cases/[id]/sessions/route.ts`, transcribe route, session pages, family child
  page (one link), `app/privacy/page.tsx`, `messages/*.json` (`scribe` namespace), `messages/REVIEW.md`,
  `scripts/make-scribe-fixture.ts`, tests `clinical-contracts` (in-use kinds) and `case-access` (gate list).
- No new env vars, no new dependencies. Docs: `docs/scribe.md` (new), `docs/system-design.md`, `docs/consent.md`,
  `docs/privacy/retention.md`, `demo/README.md`.
- The e038 acceptance data (accounts, the synthetic case and its sessions) is left in the slot 8 database; the stand-in
  `appointments` table was dropped after the run.

## Merge with `main` (026 home program, 027 messaging)

- `git merge main` (main at `1c51874`). Conflicts resolved keeping both sides: family child page (`Home program` and
  `Session notes` links), `app/privacy/page.tsx` (collect list: `scribe` next to 026's `homeProgram` and 027's
  `messages`), `lib/audit/strict-actions.ts` (038 scribe entries + 026/027 entries), `lib/privacy/registry.ts`
  (`ai_scribe` + `home_programs`; 027's `messages` merged automatically), `docs/system-design.md`,
  `docs/privacy/retention.md`, `messages/{en,hi,te}.json` (main's catalogue + the `scribe` namespace and
  `privacy.notice.collect.scribe`; no key clashes), `messages/REVIEW.md` regenerated (`npx tsx scripts/i18n-review.ts`,
  1846 rows). CaseTabs, `lib/notify/*`, tests and seed scripts merged automatically. Migration order:
  `...002600_home_program`, `...002700_messaging`, `...003800_scribe`, then 041's `...0041xx`.
- After `dnm-db.sh 8 <worktree> reset` (23 migrations): `npm run lint` and `npm run typecheck` exit 0; `npx vitest run`
  73 files, 1114 passed, 11 skipped (the opt-in `CT_DB_TESTS` block of 10 + the live no-tracking crawl; every DB suite
  ran, including 026/027's); `npm run build` exit 0; `npx vitest run tests/scribe.test.ts tests/regression-child-dev.test.ts
  --reporter=verbose` 2 files, 25 passed (`evidence/vitest-038-verbose.txt` refreshed).
- Live re-check on the merged code (fresh `seed:users --prefix e038`, dev server :3080, own headless Chromium): the whole
  acceptance script again 25/25 PASS, the consent withdraw/re-grant check 5/5 PASS, and the guardian child page shows both
  the 026 `Home program` and 038 `Session notes` links at 375 px (`evidence/post-merge-child-page-375.png`);
  `evidence/acceptance.txt` 31 PASS, 0 FAIL. The stand-in `appointments` table was dropped afterwards.
- Environment note: a dev server whose log file is written inside the worktree (`.tmp/`) recompiled in a loop and kept
  reloading `/login`; the re-check wrote the log outside the worktree.
