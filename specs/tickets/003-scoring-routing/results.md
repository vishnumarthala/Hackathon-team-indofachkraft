# 003: Scoring and routing - Results

Branch: ticket/003-scoring-routing (merged into `int/c-frontend`)
Port: none (unit tests only)

Built before ticket 001 landed, so checks ran in a temporary git-ignored harness (`.tmp/c003`) with
`schemas/isaa.json` and `schemas/facp.json` stand-ins built from `docs/system-design.md` Appendix C
(same ids, domains, bands, labels, actions and red-flag items).

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| typecheck (`tsc`, strict) | PASS (harness) | `npx tsc -p .` exit 0 |
| `npx vitest run tests/scoring.test.ts --coverage --coverage.include=lib/scoring.ts` | PASS | 26 tests; 100% lines/branches/functions |
| E-1 bands and boundaries | PASS | exact expected output |
| E-2 provisional and final score | PASS | exact expected output |
| E-3 red flags and recommendation texts | PASS | exact expected output |
| E-4 coverage >= 95% | PASS | 100% lines |
| E-5 provisional ISAA reason and FACP severe | PASS | exact expected output |
| E-6 AI suggestions alone never trigger ISAA | PASS | exact expected output |
| E-7 no I/O | PASS | prints `pure` |
| lint, build, full `npm test` | PENDING | need 001's `package.json`, ESLint and Next config |

## Still to do after 001 merges into `int/c-frontend`

1. `npm install -D @vitest/coverage-v8` (the only `package.json` change this ticket owns).
2. Rerun `npm run verify` and E-4 against 001's real `schemas/*.json`; set status `done`.

## Changes

- `lib/scoring.ts` - bands, FACP actions, `scoreIsaa`, `collectRedFlags`, `recommend`,
  `formatIsaaScore`, `SUGGESTION_LABEL`; imports only `@/schemas/isaa.json` and `@/schemas/facp.json`.
- `tests/scoring.test.ts` - every rule, boundary, dedupe order and exact string.

## Notes

- Red-flag inputs use structural types instead of importing `lib/types.ts`, so this ticket does not
  wait on 001's types and stays pure.
- Ratings outside integers 1-5 and item ids other than `"1"`..`"40"` are treated as unrated/ignored;
  the first row per item wins, so a bad row can never raise a total.
