# Project facts for the Super Agent

Every agent reads this file. Keep it short and exact.

## Basics

- Name: CareThread (hackathon MVP, Nov 7 2026, hard deadline 17:00 CET). AI assistant for early
  intervention therapists: browser intake call -> ISAA session form -> specialist referral.
- Stack: Next.js (App Router, TypeScript, no `src/` dir), Tailwind CSS, Supabase (local Docker for
  development; hosted Postgres + Storage in production), Gemini API (`@google/genai`), ElevenLabs
  (`@elevenlabs/elevenlabs-js` server, `@elevenlabs/react` browser), Resend, Zod, Vitest, ESLint.
  Package manager: npm. Node 20+. No n8n, no Twilio.
- Source of truth for shapes: `docs/system-design.md` (DDL, types, API contracts, prompts, env vars).
- Team rules (branches, checkpoints, no pushes to main): `docs/team-workflow.md`.
- Never use real patient or child data in the public repository, tests, fixtures or logs; use
  synthetic role-play data only.
- **Main branch: main** - GitHub's target branch, never push to it. Each builder checks out their own
  `int/<role>` branch and gives that branch explicitly to their worker as its base. Do not run the
  router's automatic merger: it checks out the configured branch and has a destructive recovery path.
  A person reviews evidence and merges passing ticket branches into `int/<role>` manually. Never set
  this field to `HEAD`: checking out HEAD detaches the checkout.
- Install: `npm install`
- Start on a port: `npm run dev -- -p <port>` (works in bash, Git Bash and PowerShell)
- Build: `npm run build`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- All gates at once: `npm run verify`
- Local database: `npx supabase start` (once per laptop, in the main checkout only), `npm run db:env`
  (writes local Supabase URL/keys into `.env.local`), `npm run db:migrate`, `npx supabase db reset`
- Seed a demo case: `npm run -s seed:demo -- --new` (prints `seeded case=<uuid> session=<uuid> intake=<uuid> token=<token>`)

All scripts above exist after ticket 001 (seed after 002). Before 001 is merged the repo has no app code.

## Ports

| Who | Port |
|-----|------|
| Main checkout (team tickets, checker) | 3000 |
| Worker 1 / 2 / 3 | 3001 / 3002 / 3003 |
| Reproducer | 3090 |
| Local Supabase API / Postgres / Studio | 54321 / 54322 / 54323 |

Max 2-3 workers per laptop (tell the router: `run up to 2 workers`). Only start tickets whose
Builder (BOARD.md table) is the person running this router.

## Test accounts

The app uses Supabase email/password login; the "test account" the router hands a worker is a **run prefix**
`<acct>` = `t<port>-<HHMMSS at the start of the run>` (e.g. `t3002-114502`). Evals use `<acct>` in
child aliases and emails so reruns never collide with earlier rows.

| Account | How to get it | Used by |
|---------|---------------|---------|
| Canonical demo case | `npm run -s seed:demo` (fixed id `00000000-0000-4000-8000-000000000001`, intake token `demo-intake-token`) | checker, demo |
| Own demo case per run | `npm run -s seed:demo -- --new` (fresh ids; add `--confirmed` to mark all 40 ISAA facts confirmed, or `--stage transcribed`) | workers, reproducer |
| Own cases | Create through the UI/API with `child_alias` starting `<acct>-` | workers |

Never reset the canonical demo case from a worker - the checker uses it.

## Per-worktree setup

1. `cp <main checkout>/.env.local .env.local` (never commit it; `.env.example` lists every variable).
   It points at this laptop's local Supabase, which all worktrees share. Do **not** run
   `npx supabase start` in a worktree.
2. `npm install`
3. `mkdir -p .tmp && cp -R demo/fixtures .tmp/fx-<port>` (after 002 is merged) - each worker gets its own
   fixture copy; evals make a call fail by renaming one file in it (`mv .tmp/fx-<port>/gemini/extract.json
   .tmp/fx-<port>/gemini/extract.json.off`) and restore it afterwards.
4. Start the dev server exactly as the ticket's eval Setup says, typically
   `DEMO_MODE=true DEMO_FIXTURES_DIR=.tmp/fx-<port> npm run dev -- -p <port>`. The tester never restarts it.
5. Run `npm run db:migrate` only if your ticket adds a file in `supabase/migrations/`. Migrations are
   additive only (new tables/columns) and named `<YYYYMMDDHHMMSS>_<name>.sql`; never edit a merged one.

## Eval conventions

- Runs on macOS and on Windows (Git Bash): no macOS-only tools (`stat -f`, `afinfo`, `mkfile`, `say`),
  no `/tmp` (Windows Node and Git Bash disagree on it) - use the git-ignored `.tmp/` folder in the
  worktree. File checks use `node -e "..."`.
- `evidence/` in an eval step means the ticket's own `specs/tickets/NNN-slug/evidence/` folder.
- Use `npm run -s ...` (silent) so `db:sql` and `seed:demo` print only their output.
- Every step is one command (no shell functions, no loops, no `$(...)`). Multi-step logic lives in
  `node -e "..."` one-liners or in the dev helper scripts from 001:
  `node scripts/dev/check-copy.mjs <paths...>` (prints `clean` or offending lines),
  `node scripts/dev/check-env-usage.mjs <VAR> <allowed paths...>` (prints `server only` or offenders),
  `node scripts/dev/check-client-imports.mjs` (prints `clean` or offenders),
  `node scripts/dev/build-without-env.mjs` (runs `npm run build` with `.env.local` moved aside).
- Behaviour that depends on env values the running server does not have (for example `DEMO_MODE=false`)
  is tested in Vitest with `vi.stubEnv`, not by restarting the server.
- Live checks against real ElevenLabs/Gemini/Resend are **not** in eval.md; they are listed under
  "Manual live smoke test" at the end of a ticket's rd.md and are done by the Builder after merge.

## Notes

- `DEMO_MODE=true` (default) makes Scribe, Gemini, ElevenLabs agent/TTS and Resend calls return
  fixtures from `DEMO_FIXTURES_DIR` (default `demo/fixtures/`, see `docs/system-design.md` section 9).
  Evals run in DEMO_MODE.
- Wording rules (a lawyer is on the jury): UI copy never says "diagnose"/"diagnosis" except "not a
  diagnosis", never "HIPAA compliant", never "fee per referral". Use "AI documents, the clinician decides".
- Synthetic data only. Never put real names or health details in fixtures, seeds or screenshots.
- Browser checks use `agent-browser` (`open`, `snapshot -i`, `find role|label ...`, `click`, `fill`,
  `select`, `check`, `upload`, `wait`, `get text|url|title`, `eval`, `screenshot`, `set viewport`).
- Windows laptops: agents run commands in Git Bash.
