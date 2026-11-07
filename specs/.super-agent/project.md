# Project facts for the Super Agent

Every agent reads this file. Keep it short and exact.

## Basics

- Name: CareThread - AI assistant for early intervention therapists (intake call -> ISAA session form -> specialist referral). Full plan: `CareThread Hackathon Team Plan.pdf` in the repo root.
- Stack: Next.js (App Router, TypeScript) + Tailwind, Supabase (Postgres + Storage), Gemini API, ElevenLabs (Scribe v2, Agents, TTS), n8n Cloud. Deploys to Vercel.
- Status: NOT SCAFFOLDED YET. The repo holds only the plan PDF. The first ticket must create the Next.js app in the repo root (not in a `carethread/` subfolder) with the scripts below. Until then, install/start/build/lint do not exist.
- Package manager: npm
- Main branch: main
- Install: `npm install`
- Start on a port: `npm run dev -- -p <port>` (works in bash and PowerShell; `PORT=<port> npm run dev` only works in bash)
- Build: `npm run build`
- Lint: `npm run lint`
- Tests: none planned. Checks are done in the browser and by calling the API routes with curl.

## Ports

| Who | Port |
|-----|------|
| Main checkout (team tickets, checker) | 3000 |
| Worker 1 / 2 / 3 / ... | 3001 / 3002 / 3003 / ... |
| Reproducer | 3090 |

## Test accounts

The plan has no login, no multi-tenant setup ("WON'T BUILD TODAY"). There are no accounts.

| Account | How to get it | Used by |
|---------|---------------|---------|
| none - open app | go straight to the page | checker, workers, reproducer |
| test case data | create a fresh case per run with a synthetic child name, e.g. `t001-<worker>` (workers), `t090` (reproducer) | everyone |

Never use real patient or child data. Only synthetic role-play data.

## Per-worktree setup

- Copy `.env.local` from the main checkout into the worktree (secrets live only there; never commit it; `.env.example` is committed).
- Run `npm install`.
- Expected env vars (names fixed by the first scaffold ticket in `.env.example`): Supabase URL + anon key + service role key, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, ElevenLabs agent id, Twilio settings for the outbound call.
- All worktrees share ONE Supabase cloud project. Prefix test rows you create with your worker id so they don't clash, and don't delete rows you didn't create.

## Notes

- Contracts are frozen (from the plan, "do not change after"): `/schemas/isaa.json` (40 items, 6 domains, 1-5 scale, single source of truth for prompt and UI) and the API routes `POST /api/webhooks/elevenlabs`, `POST /api/sessions/:id/transcribe`, `POST /api/sessions/:id/extract`, `PATCH /api/facts/:id`, `POST /api/cases/:id/refer`, `POST /api/cases/:id/ask`.
- Folder layout: `app/` (pages + API routes), `lib/` (elevenlabs.ts, gemini.ts, scoring.ts, db.ts), `schemas/`, `prompts/` (extract.md, brief.md, report.md, ask.md), `demo/` (role-play audio, sample transcript, seed.sql).
- Data model: every piece of information is a `fact` with its source, evidence (quote, start_sec, end_sec, recording_id), confidence and status `suggested | confirmed | edited`. Tables: cases, recordings, facts, reports, referrals.
- Scoring: FACP >=80 Typical, 60-79 Borderline, 40-59 Moderate, <40 Severe. ISAA <70 no autism, 70-106 mild, 107-153 moderate, >153 severe. ISAA >=70 or any red flag -> suggest referral. Bands have no gaps at the edges.
- Wording in the UI: "AI documents, the clinician decides". Never "AI diagnoses", never "HIPAA compliant". The therapist confirms every AI suggestion.
- External APIs (Gemini, ElevenLabs) cost credits and can be slow. Keep a cached transcript and extraction JSON in `demo/` and use them in checks where the eval allows it.
- Secrets only in `.env.local`. Never commit API keys.
- Windows machine: agents run commands in Git Bash.
