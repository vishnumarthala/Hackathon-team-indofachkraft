# 048: Parent check-in for children up to 8 - Results

Branch: `ticket/048-checkin-up-to-8`. Tested against the local Supabase stack of slot 2 (`supabase_db_dnmslot2`, all
migrations re-applied by the helper's `reset`, including `20261113004800_checkin_up_to_8.sql`), `DEMO_MODE=true`,
`MCHAT_LICENSED` unset (= false; the M-CHAT-R/F path is exercised in tests with `vi.stubEnv`), dev server on port 3020,
headless Chromium (playwright-core) at 375 px for the acceptance checks, with the 042 synthetic Hyderabad seed loaded
for the browser run only (removed afterwards with `--reset-synthetic`). Synthetic data only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` (DB suites running) | PASS | 97 files, 1652 passed, 11 skipped (the pre-existing opt-in `CT_DB_TESTS` intake suite and the live no-tracking crawl) |
| `npm run build` | PASS | exit 0; new routes `/api/screen/sessions/[id]/follow-up`, `/api/screen/sessions/[id]/providers` |
| `npx vitest run tests/screen-*.test.ts --reporter=verbose` | PASS | 3 files, 105 tests: `screen-checkin-up-to-8` 46 (new), `screen-flow` 38, `screen-red-flags` 21 |
| New bands validated; `9y+` and `under-18m` get no questions | PASS | `screen-checkin-up-to-8`: picker bands `under-18m, 18-30m, 31-71m, 6-8y, 9y+`; `screenQuestions("9y+")` / `("under-18m")` = `[]`; `POST /api/screen/sessions` 400 for `under-18m`, `9y+` and every 033 band; DB check constraint refuses `9y+`; concerns are codes only (free text 400 / check constraint) |
| `MCHAT_LICENSED=false` -> ISAA-derived 18-35 month items; `true` -> 20 M-CHAT items with the official scoring | PASS | pure: 18-30m instrument and item ids per flag; scoring table 0/2 -> low, 3/7 -> moderate (Follow-Up offered), 8/20 -> high; risk answer "yes" only for items 2, 5, 12; Follow-Up 2+ fails positive, 0-1 negative, only the items that scored. DB (flag stubbed on): 26 questions, `instrument = MCHAT_RF` stored, 31-71m stays ISAA, moderate -> `/follow-up` (422 incomplete, 400 unknown item/answer, 200 -> `see_professional_soon`, stored band updated, idempotent), low/high no Follow-Up (409), ISAA check-in 409 |
| Concern -> provider-type mapping (table test) | PASS | 14-row `it.each` table in `screen-checkin-up-to-8` (speech, movement, senses, movement+senses, social first, behaviour, learning 6-8 / under 6, closer look, nothing to go on, old `10y+`, cap at 4) |
| A red flag still overrides everything | PASS | `screen-red-flags` (all six codes, agent + form): finish returns `red_flag: true`, no band, `recommendation: null`, `GET .../providers` 409; on an M-CHAT-R/F session too (`screen-checkin-up-to-8`) |
| Old sessions with `10y+` still render | PASS | DB: a `10y+` row resumes (21 questions), finishes (`discuss_with_professional`, recommendation dev-ped + psychologist) and renders in `ResultView`; a finished `3-5y` row resumes as finished; `screen-flow` question lists for all four old bands |
| FR-10 providers + slot chips | PASS | DB: two synthetic providers (SLP, dev-ped) with all-week hours at an isolated spot; `GET .../providers?lat&lng` -> SLP first, dev-ped included, display order by recommended type, 2 future slots each, `book_href = /book/<id>?service=<id>&start=<ISO>`, `see_more` = `/find` with the first type and origin; the first chip's slot holds successfully; default origin central Hyderabad; 400 lat without lng; 422 outside India; 409 open / stopped, 404 unknown. `BookingFlow` with `initialSlot` renders Continue enabled |
| E-1 speech worry, 2½-5 years | PASS | browser (375 px, no horizontal scroll): picked `2½-5 years` + `Speech and talking`, tapped 21 answers -> `Some areas are worth discussing with a professional`; cards `speech_language_pathologist, developmental_pediatrician, child_psychologist`; first card "Because you mentioned speech, a speech therapist is a good first step."; `Book a visit near you` lists SLP, dev-ped, psychologist (demo profiles) with 2 time chips each; `Free government options` (DEIC, NIEPID, "Check timings before you go.", "Details last checked on 13 November 2026."). First chip -> `/book/<id>?service=...&start=2026-11-14T07:30:00.000Z` with that time pre-selected (`aria-pressed`), demo acknowledgement, `Continue` -> held (`We are holding 14 November 2026, ... Time left: 9:59`). Also via curl and `screen-checkin-up-to-8` (render + API) |
| E-2 under 18 months | PASS | browser: `Under 18 months` -> 5 milestones, "talk to your paediatrician", links `/find?...type=pediatrician` and `...type=developmental_pediatrician`; no start button, no question. Render test too |
| E-3 over 8 | PASS | browser: `9 years or older` -> "This check-in is for children up to 8. Please talk to your child's doctor or a child psychologist." with `/find` (and a child psychologist filter); no start button. Render test (en, te) too |
| FR-9 en/hi/te, agent guide | PASS | `i18n-keys` parity/placeholder/copy rules pass with the new `screen.*` keys (REVIEW.md regenerated); `docs/elevenlabs-screen-agent.md` covers the new bands, `{{age_band}}` in words and the `mchat_*` yes/no items (doc test) |
| NFR-1 no identifiers | PASS | the start body is `{ age_band, mode, concerns }` only; `screen_sessions.concerns` limited to six codes; `screen_answers_valid()` still only item ids -> scale values (`mchat_N` yes/no, `mchatfu_N` pass/fail) |
| NFR-2 clinical review marked | PASS | `docs/screen-recommendations.md` (mapping, milestones, free services, M-CHAT licence steps, review checklist); doc test |

## Deviations

- **M-CHAT-R/F item wording is a placeholder.** The licence for commercial digital use is unverified, so no instrument
  wording is shipped: `schemas/mchat-rf.json` (and the `MCHAT_RF` registry row) hold 20 clearly marked
  `[Placeholder] ...` items and 20 Follow-Up placeholders, `status: "placeholder_text_pending_licence"`,
  `licence.status: "unverified"`, `licence_ref` null. The published scoring algorithm (risk answers, 0-2 / 3-7 / 8-20,
  Follow-Up 2+ fails = positive) is implemented and tested. `MCHAT_LICENSED` stays false; steps to enable are in
  `docs/screen-recommendations.md` section 5.
- **Follow-Up simplified to pass/fail per item.** The official Follow-Up is a branching interview per item; here each
  item that scored gets one pass/fail question (placeholder text) and the official "2 or more fails" rule. The licensed
  interview steps belong in the same `follow_up.items` once licensed.
- **DEIC has no phone or address yet.** Per-district details are an open question in rd.md; the card says "At your
  district hospital. Free for children up to 6. Ask at the district hospital reception for the DEIC (RBSK)." NIEPID
  details were checked on niepid.nic.in on 2026-11-13 (`FREE_SERVICES_LAST_CHECKED`).
- **Booking page touched outside the listed areas.** FR-10 needs `/book/[profileId]?service=&start=` to pre-select the
  slot: `app/book/[profileId]/page.tsx`, `BookingFlow` (`initialSlot`) and `SlotPicker` (opens on the selected day).
  The hold still re-validates the slot. The privacy export of `screen_results` (`lib/privacy/registry.ts`) now also
  exports `instrument` and `concerns`.

## Notes

- Decisions: "closer look" = any band except `no_strong_signs`. With a closer look the developmental paediatrician
  goes second (after the first worry's professional), so E-1 gives SLP, dev-ped, psychologist; a playing/social worry
  puts the evaluation first. FR-10 picks the nearest bookable provider of each recommended type first (so the parent
  sees both a speech therapist and a dev-ped), then displays by type then distance.
- `{{age_band}}` for the voice agent is now the spoken band ("2 and a half to 5 years") instead of the id; the
  concerns are not sent to the agent.
- `under-18m` and `9y+` create no session (nothing stored); old 033 bands remain valid in the table only.
- Pre-existing flaky DB tests seen once in the baseline run (before any change): `documents-access` (2) and
  `voice-usage-db` parallel-cap test; both passed in the final runs.
