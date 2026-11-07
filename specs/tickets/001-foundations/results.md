# 001: Foundations - Results

Branch: ticket/001-foundations (built by C because the critical path was blocked; merged into `int/c-frontend`)

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| lint, typecheck | PASS | `npm run lint`, `npm run typecheck` exit 0 |
| `npm test` | PASS | 78 tests across env, tokens, isaa, http, types, gemini, email/audit (+003, 004) |
| build without `.env.local` (NFR-1) | PASS | `node scripts/dev/build-without-env.mjs` exit 0 |
| E-1 scripts/dependencies | PASS | `all present`; `eslint . | vitest run | tsc --noEmit` |
| E-2 migration idempotent | PASS (cloud) | `npm run db:push` -> `applied 20261107120000_init.sql`, rerun -> `up to date` |
| E-3 tables, RLS, bucket | PASS (cloud) | `db:check` 8x ok + bucket ok; RLS `[{"n":8}]`; bucket private, 52428800 (bigint printed as a string) |
| E-4 layout/banner/home | PASS | browser: header, banner text, `Open dashboard` -> `/dashboard` |
| E-5 .env.example | PASS | `complete [...]` exact values |
| E-6 schemas | PASS | exact expected output (generated from design Appendices A-C) |
| E-7 unit tests / no `any` | PASS | `0` |
| E-8 missing fixture | PASS | `GeminiError true` |
| E-9 client imports, copy, env usage | PASS | `clean`, `clean`, `server only` |
| E-10 env getters | PASS | exact expected output |
| Live Gemini | PASS (key) | key valid; `gemini-3.8-flash` answered 503 "high demand" at test time |

## Deviations and notes

- Local Docker Supabase did not start in time, so the team uses a shared Supabase **cloud** project:
  added `npm run db:push` (`scripts/db-apply.ts`) and documented it in `docs/team-workflow.md`.
- `lib/env.ts` also accepts Supabase's newer key names `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and
  `SUPABASE_SECRET_KEY`.
- `cacheComponents` is off in `next.config.ts`: with it on, Next 16 removes the `dynamic`/`runtime`
  route config the tickets rely on.
- Gemini requests time out after 60 s; the SDK otherwise retried a 503 for minutes. If the default
  model stays overloaded, set `GEMINI_MODEL` (e.g. `gemini-3.7-flash`) in `.env.local`.
- Root layout uses an explicit `children` type instead of the build-generated `LayoutProps` global so
  `npm run typecheck` works on a fresh clone and in CI.
