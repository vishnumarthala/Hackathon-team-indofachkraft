# 012: Referral packet, specialist page and email - Results

**Branch:** `ticket/012-referral-specialist-page` (base `int/b-backend` at `eeb2d17`)
**Database:** shared Supabase cloud project (no local Docker), schema already applied. Dev server:
`DEMO_MODE=true NEXT_PUBLIC_APP_URL=http://localhost:3002 npm run dev -- -p 3002`, env loaded through the
main checkout's `.tmp/with-env.mjs` wrapper. Cases used: C = `3d99eab4-9859-4b80-b801-d7a93c60938c`
and a re-run case `d4f0437d-a323-4dbb-9bee-c673952ee925` (both `seed:demo -- --new --confirmed`),
C2 = `e5c2e4ab-c5f8-41a6-8687-2ca355596e96` (`--new --stage transcribed`). The canonical case was not touched.

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | `evidence/gates.log` (exit 0) |
| `npm run typecheck` | PASS | `evidence/gates.log` (exit 0) |
| `npm test` | PASS | `evidence/gates.log` (11 files, 120 tests) |
| `npm run build` | PASS | `evidence/gates.log` (exit 0; only the existing `lib/demo.ts` tracing warning) |
| Extended packet tests (suggested vs confirmed, multiple sessions, 422) | PASS | `evidence/E-3-E-6-vitest.log`: serialized packet has no `suggested_total`/`suggested_band`/`"suggested"`/suggested fact ids or quotes; route test with sessions 1 and 2 picks session 2 for both the tab context and the route, and answers 422 although session 1 has confirmed items |
| E-1 Send a referral from the Referral tab | PASS | `evidence/E-1.png`, `evidence/E-1-db.json`: tab shows `Referral recommended`, reasons `ISAA total 83 is 70 or more`, `Red flag: lost speech`, `Red flag: self-injury`, the suggestion label; reason box `ISAA total 83 is 70 or more; Red flag: lost speech; Red flag: self-injury`; `Send referral` disabled until consent; after sending `Referral sent`, `http://localhost:3002/specialist/...`, `Open specialist view`, `Email not sent (demo mode)`; DB `[{"status":"sent","parent_consent":true,"emailed":false,"len":43,"ev":8,"case_status":"referred"}]` |
| E-2 Specialist page | PASS | `evidence/E-2.png`, `evidence/E-2-db.json`, `evidence/E-1-E-2-rerun.log`: all expected strings present, `AI suggested` absent; DB `[{"status":"viewed","viewed":true}]`; `ls app/api \| grep -i referral` -> `no referral listing api`; audit `referral.created` (therapist), `email.demo_skipped`, `referral.viewed` (specialist) |
| E-2 audio (FR-5/FR-6) | PASS | `evidence/E-1-E-2-rerun.log`: seeded sessions have no audio -> `Session 1 · mm:ss` is plain text; after attaching `demo/audio/sample-short.wav` to case C's session the label is a button, the click loads the 1-hour signed URL into the hidden `<audio>` and playback runs |
| E-3 Packet builder | PASS | `evidence/E-3-E-6-vitest.log`: key-evidence order and max 8, verified-only, decisions, intake highlights max 5, provisional score (`at least 47 (provisional - 2 of 40 confirmed)`), final total and band |
| E-4 Validation and preconditions | PASS | `evidence/E-4.log`: `{"error":"Invalid request","details":{"parent_consent":"Parent consent is required"}} 400`; C2 `{"error":"Confirm at least one ISAA item before referring"} 422`; `{"error":"Case not found"} 404`; C2 Referral tab shows `Process and confirm a session before referring.` (browser and curl) |
| E-5 Invalid or revoked link | PASS | `evidence/E-5.log`: `not-a-token` -> 404; after `status='revoked'` the page prints `This referral link is no longer valid.` with status 404 |
| E-6 Gemini failure stores nothing | PASS | `evidence/E-3-E-6-vitest.log`: Gemini fixture missing -> 502 `Referral could not be prepared`, no referral row, case status unchanged, no `referral.created` audit; extra test: email failure -> 201 `emailed: false`, `email_status: "failed"` |
| Copy rules (`scripts/dev/check-copy.mjs app components lib prompts tests`) | PASS | prints `clean` |
| Client imports (`scripts/dev/check-client-imports.mjs`) | PASS | prints `clean` |
| Don't touch | PASS | `git diff --name-only <merge-base> HEAD` lists only the files in "Affected areas" plus this ticket's specs |

## Deviations

- Cloud instead of local Supabase; `.env.local` was not copied (wrapper instead). No step needed a reset.
- `agent-browser` is not installed here; the browser steps of E-1, E-2 and E-4 step 4 ran with
  Playwright (same actions: fill by label, check the consent box, click `Send referral`, read body
  text, full-page screenshots).
- E-1 step 9 was captured right after sending (status `sent`); the E-2 query afterwards shows `viewed`.
- E-6 is a Vitest route test with an in-memory Supabase stand-in; the Gemini failure is produced the
  DEMO_MODE way (fixture directory missing), so `generateJson` throws `GeminiError` for real.
- `POST /api/cases/:id/refer` also returns `email_status` (`sent` | `demo` | `failed`) next to
  `{ referral_id, url, emailed }` so the form can tell `Email not sent (demo mode)` from
  `Email could not be sent`. Additive; the contract fields are unchanged.
- Validation runs before the case lookup (400 before 404). The 422 also covers "no extracted session".
- After a successful send the consent box is unticked again (prevents an accidental duplicate referral).
- Red flags on the tab and in the packet use confirmed/edited ISAA items, the brief red flags and the
  case-sheet booleans `lost_speech`/`self_injury` (system design section 7); Gemini extraction red flags
  are not passed.
- Audio for the evidence buttons: signed URLs are created for every recording of the case (null when
  `storage_path` is null or signing fails), so ticket 013 can play intake/session citations too.
- `E-1.png` shows a live specialist link of the synthetic re-run case; the intake token printed by the
  seed is redacted in `E-4.log`.

## Facts for other tickets (013)

- `components/referral/EvidencePlayer.tsx` (client): `EvidencePlayerProvider({ audioUrls, children })`
  with `audioUrls: Record<recordingId, signedUrl | null>`; `useEvidencePlayer()` returns
  `{ play(recordingId, startSec): boolean, stop(), canPlay(recordingId): boolean, current }`
  (`play` returns false without audio); `EvidenceTimestamp({ recordingId, startSec, label })` renders a
  button or plain text when the recording has no audio.
- `app/specialist/[token]/page.tsx`: `getReferralByToken(token)` -> `notFound()`; first view marks
  `viewed` (+ audit `referral.viewed`); `getAudioUrls(referral.case_id)`; renders
  `<EvidencePlayerProvider audioUrls>` containing `<PacketView packet reason sentAt />` - add
  `<AskTheCase ... />` inside the provider after `PacketView`. The footer sits outside the provider.
- `lib/queries/referrals.ts`: `getReferralByToken(token)` returns `{ referral, packet }` or null for
  unknown, malformed or revoked tokens (`referral` = row without `packet`, includes `id`, `case_id`,
  `status`); `getAudioUrls(caseId)`; `specialistUrl(token)`.
- `lib/referral/packet.ts`: `formatClock(sec)` (`mm:ss`), `sessionLabel(n, sec)` (`Session <n> · mm:ss`),
  `decidedIsaaFacts(facts)`, `ReferralPacket` type, `parsePacket(json)`.
