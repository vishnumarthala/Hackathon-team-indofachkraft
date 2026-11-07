# 001: Foundations - scaffold, schema, shared contracts

**Status:** done
**Mode:** solo
**Runs:** alongside

## Summary

Create the Next.js app at the repo root and put every shared contract into code: local Supabase (Docker)
config and the first migration, shared Zod types, ISAA/case-sheet/FACP schemas, the core libraries (env,
db, Gemini, email, audit, tokens, HTTP helpers, demo fixtures loader), the `verify` gate and the CI
workflow that guards checkpoint PRs. Every other ticket builds on these files, so their shapes
must match `docs/system-design.md` exactly.

## Functional requirements

- **FR-1** - A Next.js app (latest stable, App Router, TypeScript `strict: true`, Tailwind CSS, ESLint,
  no `src/` folder, import alias `@/*`) lives at the repo root. `package.json` scripts, exactly:
  `dev` = `next dev`, `build` = `next build`, `start` = `next start`, `lint` = `eslint .`,
  `typecheck` = `tsc --noEmit`, `test` = `vitest run`,
  `verify` = `npm run lint && npm run typecheck && npm test && npm run build`,
  `prepare` = `node scripts/dev/install-hooks.mjs`,
  `db:migrate` = `supabase migration up --local`, `db:reset` = `supabase db reset`,
  `db:env` = `node scripts/env-from-supabase.mjs`,
  `db:check` = `tsx scripts/db-check.ts`, `db:sql` = `tsx scripts/sql.ts`,
  `seed:demo` = `tsx scripts/seed-demo.ts`, `fixtures:scribe` = `tsx scripts/make-scribe-fixture.ts`.
- **FR-2** - All runtime dependencies later tickets need are installed now: `@supabase/supabase-js`,
  `@google/genai`, `@elevenlabs/elevenlabs-js`, `@elevenlabs/react`, `resend`, `zod` (v4),
  `postgres`, `react-markdown`, `remark-gfm`, `@next/env`; dev: `tsx`, `vitest`, `supabase` (the CLI,
  so every laptop runs the same version through `npx supabase`).
- **FR-3** - `app/layout.tsx`: `<html lang="en">`; a header with a "CareThread" link to `/` and a
  "Dashboard" link to `/dashboard`; directly under it a yellow banner with the exact text
  `Demo - synthetic data only. AI documents, the clinician decides.`
- **FR-4** - `app/page.tsx` placeholder: `<h1>CareThread</h1>`, the text
  `The AI assistant for early intervention therapists.` and a link `Open dashboard` to `/dashboard`.
- **FR-5** - `.env.example` lists every variable in `docs/system-design.md` section 4 with these
  values and all others empty: `NEXT_PUBLIC_APP_URL=http://localhost:3000`, `DEMO_MODE=true`,
  `GEMINI_MODEL=gemini-3.8-flash`, `EMAIL_FROM=CareThread <onboarding@resend.dev>`,
  `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`,
  `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Each line has a
  one-line comment above it saying what it is for.
- **FR-6** - `lib/env.ts` exports `env` with one getter per variable. Required (reading one that is
  unset or empty throws `Error("Missing env var: <NAME>")`): `NEXT_PUBLIC_APP_URL`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `DATABASE_URL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_WEBHOOK_SECRET`,
  `GEMINI_API_KEY`, `RESEND_API_KEY`. Defaulted: `GEMINI_MODEL`, `EMAIL_FROM` (values above).
  Boolean: `DEMO_MODE` (`"true"` -> true, anything else false). Optional (undefined when unset or
  empty): `DEMO_EMAIL_TO`, `ELEVENLABS_VOICE_ID_EN`, `ELEVENLABS_VOICE_ID_HI`, `ELEVENLABS_VOICE_ID_TE`,
  `DEMO_FIXTURES_DIR` (test/eval only, default `demo/fixtures`). `lib/env.ts` does not load
  `.env.local` itself (Next.js and the scripts do).
- **FR-7** - Local Supabase: `supabase/config.toml` from `npx supabase init` with `project_id =
  "carethread"` (default ports 54321/54322/54323 kept). `supabase/migrations/20261107120000_init.sql`
  is exactly the SQL in `docs/system-design.md` section 5. `npm run db:migrate` applies it to the
  running local stack. `scripts/env-from-supabase.mjs` runs `npx supabase status -o env`; if that fails
  it prints `Supabase is not running - run: npx supabase start` and exits 1; otherwise it creates
  `.env.local` from `.env.example` when missing, sets `NEXT_PUBLIC_SUPABASE_URL` = `API_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` = `SERVICE_ROLE_KEY`,
  `DATABASE_URL` = `DB_URL` (replacing existing lines, appending missing ones, keeping every other
  line), and prints `wrote 4 Supabase values to .env.local`.
- **FR-8** - `scripts/db-check.ts` prints one line `<table> ok` for each of `cases recordings facts
  reports referrals case_questions audit_events pilot_signups` (or `<table> ERR <message>`), then
  `bucket recordings ok` (or `bucket recordings ERR <message>`), and exits 1 if any line is ERR.
  `scripts/sql.ts` runs the SQL string given as its first argument with `DATABASE_URL` and prints the
  rows as one line of JSON (`JSON.stringify(rows)`). All scripts load `.env.local` with
  `loadEnvConfig(process.cwd())` from `@next/env` before importing anything that reads env.
- **FR-9** - `lib/db.ts` exports `supabaseAdmin()` (singleton `createClient(NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })`) and throws
  `lib/db.ts is server-only` if `typeof window !== "undefined"`.
- **FR-10** - `lib/types.ts` exports Zod schemas and inferred types for every shape in
  `docs/system-design.md` section 6 except the scoring types (003) and `ReferralPacket` (012):
  `LanguageSchema`, `SpeakerRoleSchema`,
  `SegmentSchema`, `EvidenceSchema`, `FactRowSchema`, `IsaaRatingSchema`, `RedFlagTypeSchema`,
  `IsaaExtractionSchema`, `BriefSchema`, `ReportDraftSchema`, `ReferralSummarySchema`,
  `AskAnswerSchema`, `ParentSummarySchema`, plus TS types `CaseRow`, `RecordingRow`, `ReportRow`,
  `ReferralRow` matching the SQL columns, with the JSONB column types listed in section 6 ("Row JSONB
  columns"). Length limits from section 6 are enforced (`.max(300)` quote, `.max(400)` rationale,
  `questions_to_verify` 3..6, `recommendations` max 5, `questions_for_specialist` max 5, word limits as
  refinements counting `text.trim().split(/\s+/).length`: Brief.summary 120, ReferralSummary.summary 150,
  AskAnswer.answer 120, ParentSummary.text 120).
- **FR-11** - `schemas/isaa.json`, `schemas/facp.json` and `schemas/case-sheet.json` follow the
  canonical shapes in `docs/system-design.md` Appendix C exactly (keys, ids, labels, ranges, actions),
  with the 40 item texts of Appendix A, the domain names `Social relationship and reciprocity`,
  `Emotional responsiveness`, `Speech-language and communication`, `Behaviour patterns`,
  `Sensory aspects`, `Cognitive component`, and the 15 case-sheet fields (id, type, label, description)
  of Appendix B in that order.
- **FR-12** - `lib/isaa.ts` exports `ISAA` (typed JSON), `DomainId` type, `getIsaaItem(id)`,
  `ratingLabel(1..5)` (`Rarely`, `Sometimes`, `Frequently`, `Mostly`, `Always`), and
  `domainOf(itemId)`. `lib/caseSheet.ts` exports the typed case-sheet fields.
- **FR-13** - `lib/demo.ts`: `isDemoMode()` and `loadFixture<T>(relPath, schema?)` reading
  `<DEMO_FIXTURES_DIR or "demo/fixtures">/<relPath>` as JSON **from disk on every call** (no cache),
  validating with the schema if given (throws `Invalid fixture <relPath>: <first issue message>`;
  a missing file throws `Missing fixture <relPath>`).
- **FR-14** - `lib/gemini.ts`: `generateJson<T>({ task, system, prompt, schema })`. DEMO_MODE:
  return `loadFixture("gemini/<task>.json", schema)` (errors are wrapped in `GeminiError`). Otherwise,
  in this order: (1) call `models.generateContent` with `responseMimeType: "application/json"`,
  `responseJsonSchema: z.toJSONSchema(schema)`, `temperature: 0.2`, `systemInstruction: system`; if
  the API answers HTTP 400 and the error message contains `schema` (case-insensitive), repeat this
  call once without `responseJsonSchema` and keep that mode for the rest of this request (this does not
  count as the retry); any other API error -> `GeminiError` at once. (2) Parse the text: `JSON.parse`
  failure -> problem `Output was not valid JSON`; Zod failure -> problem = first 3 issues as
  `<path>: <message>` joined by `; `. (3) On a problem, call once more with the prompt plus
  `\n\nYour previous output was invalid: <problem>. Return only valid JSON.` (4) A second problem ->
  throw `GeminiError("Gemini returned invalid output: <problem>")`. Accepts an optional injected client
  for tests.
- **FR-15** - `lib/email.ts`: `sendEmail({ to, subject, text, html?, caseId? })` returns
  `{ id, delivered }`. DEMO_MODE: nothing is sent, an audit event `email.demo_skipped` (actor
  `system`, details `{ to, subject }`) is written, returns `{ id: "demo", delivered: false }`.
  Otherwise sends with Resend from `EMAIL_FROM`; if `DEMO_EMAIL_TO` is set the email goes there and
  the text starts with `Originally to: <to>` and a blank line. Resend errors throw `EmailError`.
  Accepts an optional injected client for tests.
- **FR-16** - `lib/audit.ts`: `audit({ caseId?: string | null, actor, action, entity?, entityId?,
  details? })` (missing caseId is stored as null) inserts
  into `audit_events` and never throws (logs `audit failed: <message>` to console.error instead).
- **FR-17** - `lib/tokens.ts`: `newToken()` = `crypto.randomBytes(32).toString("base64url")`.
- **FR-18** - `lib/http.ts`: `ok(data, status = 200)`, `fail(status, error, details?)` returning
  `NextResponse.json({ error, details? }, { status })`, and `parseJson(req, schema)` returning either
  `{ data }` or `{ response }` where response is 400 `{ error: "Invalid request", details: { <field>:
  "<message>" } }` - one entry per top-level field path with the first Zod message for it (root-level
  issues use the key `body`). A body that is not JSON gives `details: { body: "Body must be JSON" }`.
- **FR-19** - Dev helper scripts (plain Node ESM, no dependencies) used by evals so each step is one
  command: `scripts/dev/check-copy.mjs <paths...>` scans files under the paths (`.ts`, `.tsx`, `.md`)
  and prints offending lines matching `/diagnos/i` (unless the line contains `not a diagnosis`),
  `/HIPAA compliant/i` or `/fee per referral/i`, else `clean`; `scripts/dev/check-env-usage.mjs <VAR>
  <allowed paths...>` prints every file under `app`, `components`, `lib` that contains `<VAR>` and is not
  inside an allowed path, else `server only`; `scripts/dev/check-client-imports.mjs` prints every file
  whose first statement is a `"use client"` or `'use client'` directive and that either references
  `process.env.<NAME>` with NAME not starting `NEXT_PUBLIC_` or imports `@/lib/db`, `@/lib/env`,
  `@/lib/gemini`, `@/lib/email` or `@/lib/audit`, else `clean`; `scripts/dev/build-without-env.mjs`
  renames `.env.local` (if present) to `.env.local.bak-build`, runs `npm run build`, always renames it
  back, and exits with the build's exit code; `scripts/dev/install-hooks.mjs` runs
  `git config core.hooksPath .githooks` when inside a git work tree and never fails (exit 0 otherwise).
- **FR-20** - `.github/workflows/ci.yml`: workflow `ci`, job id `ci`, runs on `pull_request` (any base)
  and on `push` to `int/**`; ubuntu-latest, Node 20, `npm ci`, then `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build` with `DEMO_MODE=true` and no secrets.
- **FR-21** - Vitest config (`vitest.config.ts`, `environment: "node"`, alias `@` -> repo root) and
  tests: `tests/isaa.test.ts`, `tests/gemini.test.ts`, `tests/email.test.ts`, `tests/tokens.test.ts`,
  `tests/env.test.ts`, `tests/http.test.ts`, `tests/types.test.ts` covering FR-6, FR-10..FR-18 (Gemini/Resend/Supabase
  clients mocked, no network). Gemini test fixtures live in `tests/fixtures/gemini/` and are read via
  `DEMO_FIXTURES_DIR=tests/fixtures`.

## Non-functional requirements

- **NFR-1** - `npm run build` exits 0 with no `.env.local` present (env is read lazily; pages that read
  the DB use `export const dynamic = "force-dynamic"`).
- **NFR-2** - No secret is referenced from client code: `node scripts/dev/check-client-imports.mjs`
  prints `clean`.
- **NFR-3** - `npm run db:migrate` is idempotent: a second run exits 0 and applies nothing.
- **NFR-4** - `lib/types.ts` contains no `any` (the word does not appear in the file).

## Affected areas

- `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`,
  `postcss.config.mjs`, `vitest.config.ts`, `next-env.d.ts` (new)
- `.gitignore` (changed: merge Next defaults with the existing lines `.claude/worktrees/`, `.env*.local`,
  `.tmp/`, `specs/.super-agent/watchdog.log`; add `supabase/.temp/` and `supabase/.branches/`)
- `.env.example` (new)
- `app/layout.tsx`, `app/page.tsx`, `app/globals.css` (new)
- `lib/env.ts`, `lib/db.ts`, `lib/types.ts`, `lib/isaa.ts`, `lib/caseSheet.ts`, `lib/demo.ts`,
  `lib/gemini.ts`, `lib/email.ts`, `lib/audit.ts`, `lib/tokens.ts`, `lib/http.ts` (new)
- `schemas/isaa.json`, `schemas/case-sheet.json`, `schemas/facp.json` (new)
- `supabase/config.toml`, `supabase/migrations/20261107120000_init.sql`, `scripts/env-from-supabase.mjs`,
  `scripts/db-check.ts`, `scripts/sql.ts` (new)
- `scripts/dev/check-copy.mjs`, `scripts/dev/check-env-usage.mjs`, `scripts/dev/check-client-imports.mjs`,
  `scripts/dev/build-without-env.mjs`, `scripts/dev/install-hooks.mjs` (new)
- `.github/workflows/ci.yml` (new)
- `tests/*.test.ts`, `tests/fixtures/gemini/*.json` (new)
- `README.md` (new: setup steps for a laptop with Docker - `npm install`, `npx supabase start`,
  `npm run db:env`, `npm run db:migrate`, `npm run dev -- -p 3000` -, scripts, links to
  `docs/system-design.md` and `docs/team-workflow.md`, "No login required")

## Don't touch

- `CareThread Hackathon Team Plan.md`, `CareThread Hackathon Team Plan.pdf`
- `specs/**` (except this ticket's `results.md` and `evidence/`), `.claude/settings.json`,
  `.githooks/**`, `.github/pull_request_template.md`, `docs/team-workflow.md`
- `docs/system-design.md` - only fix it if you find a real contradiction; list the fix in results.md

## Out of scope

- Any page other than the layout and the placeholder home page (dashboard is 004, landing is 014).
- Fixtures under `demo/fixtures/` and the seed script (002). `npm run seed:demo` and
  `npm run fixtures:scribe` may fail until 002 is merged.
- Scoring (003), ElevenLabs code (005, 009, 010, 015).
- Cloud deployment (Vercel, Supabase cloud project).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | How to scaffold when the repo root is not empty? | Run `npx create-next-app@latest ../carethread-scaffold-001 --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm --yes` in a new, empty sibling folder, then copy its files into the repo root without overwriting existing files except `.gitignore` (merge) | create-next-app refuses non-empty folders (grill F-11) |
| D-2 | `server-only` package? | Not used; runtime `typeof window` guard in `lib/db.ts` | `server-only` throws when scripts import lib files under tsx/vitest |
| D-3 | Lint command | `eslint .` with the flat config from create-next-app; ignore `.next/`, `node_modules/`, `.claude/` | `next lint` is removed in current Next.js |
| D-4 | Zod version | v4 (`z.toJSONSchema` is used for Gemini schemas) | grill A-3 |
| D-5 | Where do later tickets put new types? | In their own module, never in `lib/types.ts` | avoids merge conflicts between parallel workers |
| D-6 | Where does the database run? | Local Supabase in Docker. 001 is the only ticket whose worker runs `npx supabase start` from its worktree (nothing runs yet); later tickets use the stack started in the main checkout | grill D-14 |
| D-8 | Supabase CLI version | `supabase` npm devDependency, used as `npx supabase` | same CLI on macOS and Windows laptops |
| D-9 | Migration runner | Supabase CLI (`migration up`, `db reset`), no custom migrate script | one source of truth for applied migrations |
| D-7 | Header styling | Tailwind only, no component library | speed, no extra dependency |

## Open questions

None.
