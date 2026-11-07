# 003: Scoring and routing

**Status:** done
**Mode:** solo
**Runs:** waits for 001: needs schemas/isaa.json, schemas/facp.json, lib/types.ts and the Vitest setup

## Summary

Pure functions that turn ISAA facts, the FACP score and red flags into a score, a band and a suggested
next step, exactly as the team plan's routing table says (with the gaps at 40/60/80 fixed). Every
screen that shows a score (review screen, report, referral, specialist page) uses these functions, so
the numbers are always the same.

## Functional requirements

- **FR-1** - `lib/scoring.ts` exports types `IsaaBand` (`"no_autism" | "mild" | "moderate" | "severe"`),
  `FacpBand` (`"typical" | "borderline" | "moderate" | "severe"`), `IsaaScore`, `RedFlag`,
  `Recommendation` with the fields in `docs/system-design.md` sections 6-7.
- **FR-2** - `isaaBand(total)`: `< 70` no_autism, `70..106` mild, `107..153` moderate, `>= 154` severe.
  `ISAA_BAND_LABELS` re-exports the labels from `schemas/isaa.json`.
- **FR-3** - `facpBand(score)`: `>= 80` typical, `60..79` borderline, `40..59` moderate, `< 40` severe;
  `null` input -> `null`. `FACP_ACTIONS` holds the 4 exact action texts from section 7.
- **FR-4** - `scoreIsaa(facts)` takes `{ item_id: string, value: number | null, status: string }[]`
  (the caller passes only ISAA facts of one recording; rows whose `item_id` is not `"1"`..`"40"` are
  ignored; missing item rows count as null) and returns `{ rated, confirmed, total, minimum_total,
  suggested_total, band, minimum_band, suggested_band, by_domain }` per section 7: `total` only when
  all 40 items are confirmed/edited with a value; `minimum_total` = confirmed/edited values + 1 for
  every other item; `suggested_total` = all non-null values + 1 for every null item;
  `by_domain` = `[{ domain_id, name, score, max, rated, confirmed }]` in domain order, `score` = sum of
  the non-null values passed in.
- **FR-5** - `collectRedFlags({ isaaFacts?, extractionRedFlags?, intake? })` returns `RedFlag[]`:
  item 15 value >= 2 -> `lost_speech`, item 29 value >= 2 -> `self_injury` (source `isaa_item`,
  `item_id` set); extraction flags of type lost_speech/self_injury (source `extraction`, `quote`,
  `segment_id`); `intake` = `{ lost_speech?: boolean, self_injury?: boolean, brief_red_flags?:
  Brief["red_flags"] }` (source `intake`; brief flags carry `turn_id` and `quote`, booleans carry
  neither). `RedFlag` = `{ type, source, item_id?, quote?, segment_id?, turn_id? }`. Type `other` is
  ignored. One flag per type: the first in the order isaa_item, extraction, intake brief flag, intake
  boolean. Result order: lost_speech before self_injury.
- **FR-6** - `recommend({ isaa, facpScore, redFlags })` returns `{ referral_recommended, reasons,
  action, isaa_band, facp_band, provisional }` per section 7, with these exact texts:
  reasons `ISAA total <n> is 70 or more` / `ISAA total at least <n> is 70 or more` (provisional),
  `Red flag: lost speech`, `Red flag: self-injury`, `FACP score <n> is below 40`;
  actions: FACP action, + ` + referral to specialist (Phase 3)` when referral is recommended and FACP
  band is not severe; `Referral to specialist (Phase 3)` with no FACP and a referral;
  `Enter the FACP score to get a suggested action` with no FACP and no referral.
  The ISAA rule uses `total` when final, else `minimum_total` (confirmed values only, so AI suggestions
  never trigger the ISAA reason on their own; red flags may). `isaa_band` = `band` if final else
  `minimum_band` when `minimum_total >= 70`, else null.
- **FR-7** - `formatIsaaScore(score, { showSuggested })` returns `ISAA total: <total> · <band label>`
  when final, else `ISAA total: at least <minimum_total> (provisional - <confirmed> of 40 confirmed)`,
  followed by `; AI-suggested total <suggested_total>` inside the parentheses only when
  `showSuggested` is true (the review screen; never in reports or for specialists).
- **FR-8** - `SUGGESTION_LABEL = "Suggested by CareThread - the therapist decides"` is exported.
- **FR-9** - `tests/scoring.test.ts` covers every rule above, including boundaries 69/70/106/107/153/154
  and 39/40/59/60/79/80, provisional vs final, dedupe order, and every reason/action string.

## Non-functional requirements

- **NFR-1** - `lib/scoring.ts` has no I/O (no DB, no fetch, no env) so it runs in server and client code.
- **NFR-2** - Line coverage of `lib/scoring.ts` >= 95% (`npx vitest run tests/scoring.test.ts --coverage`
  using `@vitest/coverage-v8`).

## Affected areas

- `lib/scoring.ts` (new)
- `tests/scoring.test.ts` (new)
- `package.json`, `package-lock.json` (changed: add dev dependency `@vitest/coverage-v8` only)

## Don't touch

- `schemas/*.json`, `lib/types.ts`, `lib/isaa.ts`

## Out of scope

- Any UI. Showing scores is done in 007, 011, 012.
- FACP item-level scoring (only the 0-100 total is used).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Red flag threshold for items 15/29 | value >= 2 (reported at least "Sometimes") | any lost speech or self-injury matters; grill A-6 |
| D-2 | Score while items are unconfirmed | `total` null, `minimum_total` lower bound | grill D-3: AI never decides the final score |
| D-3 | Referral rule with provisional score | Use `minimum_total` (confirmed values, others counted as 1) | a true lower bound: if it is >= 70 the final total will be too, whatever the therapist changes |
| D-4 | Band wording | Labels from schemas/isaa.json, e.g. `Moderate (107-153)` | avoid diagnosis wording in UI |

## Open questions

None.
