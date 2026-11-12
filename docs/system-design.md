# DoctorNearMe: System Design

Nov 7, 2026 · Source of truth for shapes, contracts and rules. Tickets in `../specs/tickets/` build
against this file. If a ticket and this file disagree, the ticket's "Decisions" win for that ticket;
fix this file in the same branch.

Related: [team plan](../CareThread%20Hackathon%20Team%20Plan.md) · [team workflow](team-workflow.md)
· [grill record](../specs/grill/carethread-mvp.md) · [DoctorNearMe decisions](../specs/grill/doctornearme-mvp.md)
· [ticket board](../specs/tickets/BOARD.md)

> DoctorNearMe was built as CareThread. This file describes the Child Development module (the
> "CareThread engine"); platform-wide decisions for DoctorNearMe live in the decision record above.

## 1. Scope

DoctorNearMe helps early intervention therapists: (1) a browser voice intake with the parent before
session 1, (2) AI-filled ISAA form from a recorded session that the therapist confirms item by item,
(3) a referral packet with "ask the case" for the specialist. **AI documents, the clinician decides.**

Built today: the ticket-board MVP, email/password login, admin-only account directory, running on
Vercel + Supabase cloud or locally with Supabase in Docker. Not built: multi-tenancy or per-user case
ownership, payments, live video, real phone calls (Twilio/SIP), real patient data, FHIR export.
Continue using synthetic data only until data isolation, consent, retention, and clinical security
requirements are implemented and reviewed.

## 2. Architecture

```mermaid
flowchart LR
  subgraph Browser
    T[Therapist UI<br/>/dashboard /cases/*]
    P[Parent intake page<br/>/intake/token]
    S[Specialist page<br/>/specialist/token]
    L[Landing /]
  end
  subgraph Next[Next.js app (local or Vercel)]
    API[API routes /api/*]
    RSC[Server components]
  end
  subgraph Supabase[Supabase (local or cloud)]
    DB[(Postgres)]
    ST[(Private Storage<br/>bucket: recordings)]
  end
  EL[ElevenLabs<br/>Agents · Scribe v2 · TTS]
  GM[Gemini API]
  RS[Resend email]

  T --> API
  T -- signed upload --> ST
  P -- WebRTC voice --> EL
  P --> API
  S --> API
  L --> API
  API --> DB
  RSC --> DB
  API --> ST
  API --> EL
  API --> GM
  API --> RS
  API -- fetch finished call --> EL
  EL -. post-call webhook (HMAC, only when deployed or tunnelled) .-> API
```

- **One Next.js app** (App Router, TypeScript, Tailwind) running locally (`npm run dev -- -p 3000`) and
  deployed to Vercel. Server components read the DB directly; mutations go through `/api/*` route
  handlers.
- **No workflow tool.** Every step is an API route or a webhook. Long steps (Scribe, Gemini) run inside
  the route with `export const maxDuration = 300` and `export const runtime = "nodejs"`.
- **Supabase** (local Docker via `npx supabase start` for development; hosted Supabase in production).
  Clinical tables use RLS without client policies, so only the server's service-role client reads or
  writes them. The browser uses the anon key for Auth and signed uploads, not clinical table reads.
  Schema changes are migrations in `supabase/migrations/`.
- **Authentication and roles (ticket 017).** `/dashboard`, `/cases/*`, private API routes, and
  `/admin/users` require a Supabase Auth session. Roles in `user_profiles.role`: `platform_admin`,
  `provider`, `guardian`. Since ticket 019 every new auth user is a `guardian` unless the server sets
  `app_metadata.role` (`provider`/`platform_admin`, admin API only); accounts created in the Supabase
  Auth dashboard become providers by accepting an invitation or with `org:grant`. Promote a platform admin in SQL:
  `update public.user_profiles set role = 'platform_admin' where id = (select id from auth.users where email = 'admin@example.com');`
- **Organisations and tenant isolation (ticket 017).** Every case belongs to an organisation
  (`cases.org_id`; a centre or a solo practice). A provider can read or change a case only while an
  active member of its organisation (`org_members`). The server still uses the service-role client, so
  every route and page passes a gate from `lib/authz.ts` (`requireCaseAccess`, `requireRecordingAccess`,
  `requireReportAccess`, `requireFactAccess`, `requireCasePage`, `requireProviderPage`); other tenants'
  ids answer 404. Platform admins get clinical access only through membership. RLS policies mirror this
  for future browser reads. Legacy cases were moved to the bootstrap organisation
  `00000000-0000-4000-8000-00000000a001` ("Pilot centre (migrated)") and every account that existed at
  migration time became a member. Owners/admins invite colleagues from `/dashboard/team`
  (hashed, single-use, 7-day links at `/invite/<token>`) and remove members there. Locally, add an
  account to the bootstrap org with `npm run -s org:grant -- <email> [owner|admin|member]`.
  For the Vercel Supabase project, apply migrations with `npm run db:push`, set Auth's Site URL to
  `https://carethread-two.vercel.app`, allow that same URL for redirects, and disable new sign-ups in
  the Supabase Auth settings. `supabase/config.toml` disables sign-ups for local Supabase only; the
  cloud Auth setting is managed separately.
- **Guardian sign-in and family portal (ticket 019).** Parents sign in at `/family/login` with Google or
  a phone OTP (`/api/auth/phone/send|verify`, server-side, rate limited) and use `/family/**`.
  `proxy.ts` routes by role (guardian -> `/family`, provider -> `/dashboard`, platform admin -> `/admin`)
  and sends a nonce CSP with `script-src 'self'` on every `/family` page; routing is only a convenience:
  `/api/family/**` handlers call `requireGuardian()` and `/family` pages `requireGuardianPage()`
  (`lib/authz.ts`). Google<->phone linking is explicit and never merges accounts. Local test accounts:
  `npm run -s seed:users -- --prefix <acct>`. Details, Supabase dashboard settings and the demo OTP
  backend: `docs/guardian-auth.md`.
- **Languages and time zone (ticket 018).** The UI is English, Hindi or Telugu with no URL prefix: the
  locale comes from cookie `dnm_locale`, then `user_profiles.preferred_locale`, then (on
  `/intake/<token>`) the case language, then `Accept-Language`, then `en`. Dates and times show in the
  viewer's browser time zone (cookie `dnm_tz`, then `user_profiles.time_zone`, fallback `Asia/Kolkata`);
  storage stays UTC. `proxy.ts` passes the pathname to the server in the `x-dnm-path` request header
  (always overwritten). Every new UI string goes through `t()`; see `docs/i18n.md`. Hindi/Telugu copy
  awaits human review in `messages/REVIEW.md`.
- **Real patient data** still waits for consent gating (020) and the privacy/audit baseline (041).
- Parent intake and specialist pages remain accessible only with an unguessable token. The matching
  token-based API endpoints and signed webhook are public by design.
- **Provider profiles and verification (ticket 028).** Stable `provider_profiles.id` per provider,
  public at `/p/<slug>` (and centres at `/c/<slug>`) only when a platform admin verified the registration
  (`/admin/verifications`) and the provider listed it. Self-registration at `/join`, admin seeding at
  `/admin/providers/new`, single-use claim links at `/claim/<token>`. `can_prescribe` is the SQL function
  `provider_can_prescribe(profile_id)` (type + verified + NMC/state council), never stored. See
  `docs/providers.md`.

## 3. Repo layout

```
app/
  layout.tsx                      root layout: header + demo banner (001); fonts, <html lang>, I18nProvider (018)
  api/locale/route.ts             POST UI language / time zone preference (018)
  page.tsx                        landing + pilot sign-up (014; placeholder from 001)
  dashboard/page.tsx              case list (004)
  dashboard/pilots/page.tsx       pilot sign-ups list (014)
  cases/new/page.tsx              new case form (004)
  cases/[id]/layout.tsx           case header + tabs (004)
  cases/[id]/page.tsx             overview (004)
  cases/[id]/brief/page.tsx       intake link (009) + pre-session brief (010)
  cases/[id]/sessions/page.tsx    session list (004)
  cases/[id]/sessions/new/page.tsx            upload + process panel (008)
  cases/[id]/sessions/[recordingId]/page.tsx  therapist review screen (007)
  cases/[id]/report/page.tsx      assessment report (011) + parent voice note (015)
  cases/[id]/referral/page.tsx    referral form (012)
  intake/[token]/page.tsx         parent browser voice intake (009)
  specialist/[token]/page.tsx     referral packet (012) + ask the case (013)
  api/...                         see section 8
components/<area>/*.tsx           one folder per area (case, session, intake, referral, landing)
lib/
  env.ts db.ts types.ts isaa.ts gemini.ts email.ts audit.ts tokens.ts http.ts   (001)
  demo.ts                         DEMO_MODE fixture loader (001)
  scoring.ts                      (003)
  transcript.ts                   Scribe words -> segments, speaker map (005)
  elevenlabs/stt.ts               (005)  elevenlabs/agent.ts (009)  elevenlabs/tts.ts (015)
  extraction.ts                   (006)
  intake/process.ts               post-call processing (010)
  queries/<area>.ts               read helpers, one file per ticket area
  i18n/                           config, server (getLocale/getTimeZone/getT/getFormatter), client
                                  (I18nProvider/useT/useFormatter), format, keys, translate, messages (018)
messages/  en.json hi.json te.json REVIEW.md   UI copy catalogues + human review list (018)
schemas/  isaa.json  case-sheet.json  facp.json                                  (001)
prompts/  extract.md  brief.md  report.md  referral.md  ask.md  parent-summary.md (one per ticket)
supabase/config.toml  supabase/migrations/20261107120000_init.sql               (001)
scripts/  env-from-supabase.mjs db-check.ts sql.ts dev/*.mjs (001)
          make-scribe-fixture.ts make-sample-audio.mjs seed-demo.ts (002)
.github/pull_request_template.md  .github/workflows/ci.yml (001)
demo/fixtures/ ...  demo/audio/sample-short.wav                                  (002)
tests/    *.test.ts (Vitest)
docs/     system-design.md  elevenlabs-agent.md  i18n.md  guardian-auth.md
```

Rules: `lib/types.ts` is owned by 001. Later tickets add new types in their own module, not there.
Each ticket adds read helpers in its own `lib/queries/<area>.ts` file.

## 4. Environment variables (`.env.example`)

| Variable | Used by | Notes |
|----------|---------|-------|
| `NEXT_PUBLIC_APP_URL` | links in emails, WhatsApp text | `http://localhost:3000` locally |
| | | The 4 Supabase variables below are written by `npm run db:env` from `npx supabase status -o env` (`API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL`) |
| `DEMO_MODE` | all integrations | `true` = fixtures instead of external AI/email calls (section 9) |
| `SHOW_SYNTHETIC_LISTINGS` | public provider pages (028) | default `true`: demo profiles shown with a `Demo profile` badge; `false` hides them |
| `NEXT_PUBLIC_SUPABASE_URL` | server + browser upload | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser upload only | cannot read tables (RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | never sent to the browser |
| `DATABASE_URL` | `npm run db:sql`, `db:check`, seed | local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `_SECRET` | Supabase CLI only (local Google sign-in) | not read by the app; see `docs/guardian-auth.md`. Hosted projects set Google in the Supabase dashboard |
| `ELEVENLABS_API_KEY` | Scribe, conversation token, TTS | |
| `ELEVENLABS_AGENT_ID` | intake page | agent configured per `docs/elevenlabs-agent.md` |
| `ELEVENLABS_WEBHOOK_SECRET` | webhook HMAC | only needed when the webhook is used (deployed or tunnel) |
| `ELEVENLABS_VOICE_ID_EN` / `_HI` / `_TE` | parent voice note | |
| `GEMINI_API_KEY` | Gemini | |
| `GEMINI_MODEL` | Gemini | default `gemini-3.8-flash` |
| `RESEND_API_KEY` | email | |
| `EMAIL_FROM` | email | default `DoctorNearMe <onboarding@resend.dev>` |
| `DEMO_EMAIL_TO` | email | if set, **every** email goes here (Resend test sender only delivers to the account owner); body starts with `Originally to: <address>` |

`lib/env.ts` reads variables lazily (a getter per variable that throws `Missing env var: NAME` when
used). `npm run build` must succeed with no `.env.local`.

## 5. Data model (`supabase/migrations/20261107120000_init.sql`)

```sql
create extension if not exists pgcrypto;

create table cases (
  id uuid primary key default gen_random_uuid(),
  child_alias text not null check (char_length(child_alias) between 1 and 60),
  child_age_months int check (child_age_months between 12 and 216),
  parent_alias text not null check (char_length(parent_alias) between 1 and 60),
  parent_email text,
  parent_phone text,
  language text not null default 'en' check (language in ('en','hi','te')),
  therapist_name text not null default 'Demo Therapist',
  facp_score int check (facp_score between 0 and 100),
  status text not null default 'booked'
    check (status in ('booked','intake_done','in_assessment','referred')),
  intake_token text unique,
  created_at timestamptz not null default now()
);

create table recordings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  kind text not null check (kind in ('intake_call','session')),
  session_number int,                       -- 1..n for kind='session', null for intake calls
  storage_path text,                        -- '<case_id>/<recording_id>.<ext>' in bucket 'recordings'
  mime_type text,
  duration_sec numeric,
  status text not null default 'created'
    check (status in ('created','transcribing','transcribed','extracting','extracted','failed')),
  error text,
  external_id text unique,                  -- ElevenLabs conversation_id (intake calls)
  speaker_map jsonb not null default '{}'::jsonb,  -- {"speaker_0":"therapist","speaker_1":"parent"}
  segments jsonb not null default '[]'::jsonb,     -- Segment[] (section 6)
  red_flags jsonb not null default '[]'::jsonb,    -- ExtractionRedFlag[] from Gemini
  language_code text,
  created_at timestamptz not null default now()
);

create table facts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  recording_id uuid not null references recordings(id) on delete cascade,
  instrument text not null check (instrument in ('ISAA','CASE_SHEET')),
  item_id text not null,                    -- ISAA: '1'..'40'; CASE_SHEET: field id
  value jsonb,                              -- ISAA: 1..5 or null; CASE_SHEET: string|number|boolean|null
  ai_value jsonb,                           -- first AI suggestion, never overwritten
  source text not null check (source in ('parent_call','session','therapist_voice')),
  evidence jsonb,                           -- Evidence | null
  confidence numeric check (confidence between 0 and 1),
  rationale text,
  status text not null default 'suggested' check (status in ('suggested','confirmed','edited')),
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (recording_id, instrument, item_id)
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  recording_id uuid references recordings(id) on delete cascade,
  kind text not null check (kind in ('pre_session_brief','assessment','parent_summary')),
  content jsonb not null,                   -- structured AI output
  content_md text not null,                 -- what the therapist reads/edits
  audio_path text,                          -- parent_summary mp3 in bucket 'recordings'
  status text not null default 'draft' check (status in ('draft','final')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recording_id, kind)
);

create table referrals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  share_token text not null unique,
  specialist_name text not null,
  specialist_email text not null,
  reason text not null,
  packet jsonb not null,                    -- ReferralPacket
  parent_consent boolean not null check (parent_consent),
  status text not null default 'sent' check (status in ('sent','viewed','revoked')),
  emailed boolean not null default false,
  created_at timestamptz not null default now(),
  viewed_at timestamptz
);

create table case_questions (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references referrals(id) on delete cascade,
  question text not null check (char_length(question) between 3 and 500),
  answer text not null,
  found boolean not null,
  citations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table audit_events (
  id bigint generated always as identity primary key,
  case_id uuid references cases(id) on delete cascade,
  actor text not null check (actor in ('therapist','parent','specialist','ai','system')),
  action text not null,                     -- e.g. 'fact.confirmed', 'referral.created'
  entity text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table pilot_signups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  email text not null unique,
  role text not null check (role in ('therapist','psychologist','centre_owner','parent','other')),
  country text not null check (char_length(country) between 2 and 60),
  centre text,
  clinicians int check (clinicians between 1 and 1000),
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now()
);

alter table cases enable row level security;
alter table recordings enable row level security;
alter table facts enable row level security;
alter table reports enable row level security;
alter table referrals enable row level security;
alter table case_questions enable row level security;
alter table audit_events enable row level security;
alter table pilot_signups enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('recordings', 'recordings', false, 52428800)
on conflict (id) do nothing;
```

Migrations are applied by the Supabase CLI against the local Docker stack: `npm run db:migrate`
(= `supabase migration up --local`, applies pending files, tracked in
`supabase_migrations.schema_migrations`) or `npx supabase db reset` (rebuild from scratch). New files are
named `<YYYYMMDDHHMMSS>_<name>.sql`, additive only, never edited after they reach `main`.

## 6. Shared types (`lib/types.ts`, Zod v4 + inferred TS types)

```ts
Language        = "en" | "hi" | "te"
SpeakerRole     = "therapist" | "parent" | "agent" | "unknown"
Segment         = { id: string /* "s1".. for sessions, "t1".. for intake turns */,
                    speaker: SpeakerRole, speaker_label: string /* raw "speaker_0" | "agent" | "user" */,
                    start_sec: number, end_sec: number, text: string }
Evidence        = { quote: string, segment_id: string, start_sec: number, end_sec: number,
                    recording_id: string, verified: boolean }
FactRow         = row of `facts` (value/ai_value typed as number | string | boolean | null)
IsaaRating      = 1 | 2 | 3 | 4 | 5
RedFlagType     = "lost_speech" | "self_injury" | "other"

// Gemini outputs (each also has a Zod schema exported as <Name>Schema)
IsaaExtraction  = {
  items: { item_id: 1..40, rating: IsaaRating | null, segment_id: string | null,
           quote: string | null /* <=300 chars */, confidence: 0..1, rationale: string /* <=400 */ }[],
  red_flags: { type: RedFlagType, segment_id: string, quote: string, note: string }[],
  therapist_notes: { segment_id: string, item_id: 1..40 | null, rating: IsaaRating | null, text: string }[] }
Brief           = { summary: string /* <=120 words */,
                    red_flags: { type: RedFlagType, turn_id: string, quote: string }[],
                    questions_to_verify: string[] /* 3..6 */,
                    parent_reported: { field_id: string, label: string, value: string }[] }
ReportDraft     = { background: string,
                    observations: { domain_id: DomainId, text: string, item_ids: number[] }[],
                    recommendations: string[] /* <=5 */ }
ReferralSummary = { summary: string /* <=150 words */, reason_for_referral: string,
                    questions_for_specialist: string[] /* <=5 */ }
AskAnswer       = { found: boolean, answer: string /* <=120 words */,
                    citations: { kind: "fact" | "segment", id: string }[] }
                  // segment ids are "<session_number>:<segment_id>" (e.g. "1:s12") or "intake:<turn_id>" (e.g. "intake:t4");
                  // fact ids are facts.id uuids
ParentSummary   = { language: Language, text: string /* <=120 words */ }

ReferralPacket  = { generated_at: string, child_alias: string, child_age_months: number | null,
                    isaa: { total: number | null, minimum_total: number, band: IsaaBand | null,
                            confirmed: number, by_domain: { domain_id, name, score, max }[] },
                    facp: { score: number | null, band: FacpBand | null },
                    red_flags: RedFlag[], recommendation: Recommendation,
                    key_evidence: { fact_id, item_id, item_text, rating, quote, start_sec,
                                    recording_id, session_number }[] /* <=8 */,
                    intake_highlights: string[], summary: ReferralSummary,
                    therapist: string, decisions: { item_id, rating, status, confirmed_at }[] }
                  // defined by ticket 012 in lib/referral/packet.ts (it needs the scoring types), NOT in lib/types.ts
```

Row JSONB columns in `lib/types.ts` (001): `RecordingRow.segments: Segment[]`,
`RecordingRow.speaker_map: Record<string, SpeakerRole>`, `RecordingRow.red_flags:
IsaaExtraction["red_flags"]`, `FactRow.evidence: Evidence | null`, `FactRow.value/ai_value: number |
string | boolean | null`, `ReportRow.content: unknown` and `ReferralRow.packet: unknown` (the owning
ticket parses them with its schema). Word limits ("<=120 words") are Zod refinements counting
`text.trim().split(/\s+/).length`.

`IsaaBand`, `FacpBand`, `RedFlag`, `Recommendation` come from `lib/scoring.ts` (003), section 7.

## 7. Instruments, scoring and routing

**ISAA** (`schemas/isaa.json`): 40 items, 6 domains, rating 1-5 (1 Rarely up to 20%, 2 Sometimes
21-40%, 3 Frequently 41-60%, 4 Mostly 61-80%, 5 Always 81-100%). Domains: `social` items 1-9,
`emotional` 10-14, `speech` 15-23, `behaviour` 24-30, `sensory` 31-36, `cognitive` 37-40. Item texts
in Appendix A. Red-flag items: 15 (lost speech), 29 (self-injury).

**Bands** (total 40-200): `< 70` no_autism · `70-106` mild · `107-153` moderate · `>= 154` severe.

**Score rules** (`scoreIsaa(facts)`; input = the ISAA facts of one recording as `{ item_id, value, status }`):
- `rated` = items with a non-null value; `confirmed` = items with status confirmed or edited and a value.
- `total` = sum of values **only when all 40 items are confirmed/edited with a value**, else `null`.
- `minimum_total` = sum of confirmed/edited values + 1 for every other item (a true lower bound: the
  therapist can still change suggestions). Shown as "at least N".
- `suggested_total` = sum of all non-null values (suggested included) + 1 for every null item. Shown as
  "AI-suggested total N" on the therapist's review screen only.
- `band` = band of `total` (null if provisional); `minimum_band` = band of `minimum_total`.
- `by_domain` = per domain: score (sum of the non-null values passed in), max (5 x items), rated count.
- **Anything shown in a report or to a specialist (011, 012, 013) is computed from confirmed/edited
  facts only**: those callers filter before calling `scoreIsaa` and `collectRedFlags`, and do not pass
  Gemini extraction red flags.

**FACP** (manual, `cases.facp_score` 0-100): `>= 80` typical · `60-79` borderline · `40-59` moderate ·
`< 40` severe. Actions (exact text):
- typical: `Home program and parent counselling, re-screen in 3 months`
- borderline: `IEP and home program, review in 3 months`
- moderate: `IEP and regular therapy sessions`
- severe: `IEP and referral to specialist (Phase 3)`

**Red flags** (`RedFlag = { type: "lost_speech" | "self_injury", source: "isaa_item" | "extraction" | "intake", item_id?, quote?, segment_id?, turn_id? }`):
- ISAA item 15 value >= 2 -> lost_speech; item 29 value >= 2 -> self_injury (source isaa_item).
- Gemini extraction red flags of type lost_speech/self_injury (source extraction, `segment_id`, `quote`).
- Intake: brief red flags (source intake, `turn_id`, `quote`) first, then case-sheet booleans
  `lost_speech`/`self_injury` = true (source intake, no quote).
- Deduplicate by type (keep the first in the order isaa_item, extraction, intake brief, intake boolean).

**Recommendation** (`recommend({ isaa, facpScore, redFlags })`):
- `isaa_value` = `total` if not null, else `minimum_total`; `provisional` = `total === null`.
- `referral_recommended` = `isaa_value >= 70` or any red flag or FACP band severe.
- `reasons` (exact, in this order, only those that apply): `ISAA total <n> is 70 or more` (use
  `at least <n>` when provisional), `Red flag: lost speech`, `Red flag: self-injury`,
  `FACP score <n> is below 40`.
- `action`: FACP band present -> its action text; if referral recommended and FACP band is not severe,
  append ` + referral to specialist (Phase 3)`. No FACP and referral recommended ->
  `Referral to specialist (Phase 3)`. No FACP and no referral -> `Enter the FACP score to get a suggested action`.
- The UI always labels this `Suggested by DoctorNearMe - the therapist decides`.

**Case sheet** (`schemas/case-sheet.json`): ElevenLabs data-collection fields (Appendix B).

## 8. API contracts

All JSON. Errors: `{ "error": "<message>", "details"?: any }` with 400 validation, 404 unknown id/token,
409 wrong state, 422 precondition, 429 limit, 502 upstream (Scribe/Gemini/ElevenLabs/Resend) failure.
`lib/http.ts` (001) provides `ok(data, status=200)`, `fail(status, error, details?)`, and
`parseJson(req, schema)` returning 400 `{ error: "Invalid request", details: { <field>: "<first message>" } }`
(non-JSON body -> `details: { body: "Body must be JSON" }`).

| Method + path | Ticket | Body | Success |
|---|---|---|---|
| `POST /api/cases` | 004 | `{ child_alias, child_age_months?, parent_alias, parent_email?, parent_phone?, language, therapist_name? }` | 201 `{ case }` |
| `PATCH /api/cases/:id` | 004 | any of `{ facp_score: 0..100 \| null, language, parent_email, parent_phone }` | 200 `{ case }` |
| `POST /api/cases/:id/sessions` | 005 | `{ file_name, mime_type, size_bytes, consent?: boolean }` | 201 `{ recording_id, session_number, bucket, path, token, signed_url }` |
| `POST /api/sessions/:id/transcribe` | 005 | - | 200 `{ recording_id, status, segments_count, duration_sec, speaker_map }` |
| `POST /api/sessions/:id/extract` | 006 | - | 200 `{ recording_id, facts, red_flags, therapist_notes_applied }` |
| `PATCH /api/facts/:id` | 007 | `{ action: "confirm" }` or `{ action: "edit", value: 1..5 }` | 200 `{ fact, score }` |
| `POST /api/sessions/:id/bulk` | 007 | `{ action: "confirm_suggested" }` or `{ action: "rate_unrated", value: 1 }` | 200 `{ updated, score }` |
| `PATCH /api/sessions/:id/speakers` | 008 | `{ swap: true }` | 200 `{ speaker_map, segments_count }` |
| `POST /api/cases/:id/intake-link` | 009 | `{ send_email?: boolean }` | 200 `{ url, whatsapp_url, emailed }` |
| `POST /api/intake/:token/start` | 009 | `{ language }` | 200 `{ conversation_token, agent_id, dynamic_variables }` or `{ demo: true }` |
| `POST /api/intake/:token/complete` | 010 | `{ conversation_id }` | 200 `{ received: true, ... }` or 202 `{ status: "processing" }` (client polls) |
| `POST /api/webhooks/elevenlabs` | 010 | ElevenLabs post-call payload (raw); optional locally | 200 `{ received: true, ... }` |
| `POST /api/dev/simulate-intake/:token` | 010 | - (404 unless `DEMO_MODE=true`) | 200 same as webhook |
| `POST /api/cases/:id/brief/reviewed` | 010 | - | 200 `{ report }` |
| `POST /api/sessions/:id/report` | 011 | - | 200 `{ report }` |
| `PATCH /api/reports/:id` | 011 | `{ content_md?, status?: "final" }` | 200 `{ report }` |
| `POST /api/cases/:id/refer` | 012 | `{ specialist_name, specialist_email, reason, parent_consent: true }` | 201 `{ referral_id, url, emailed }` |
| `POST /api/cases/:id/ask` | 013 | `{ share_token, question }` | 200 `{ found, answer, citations: ResolvedCitation[] }` |
| `POST /api/pilot-signups` | 014 | `{ name, email, role, country, centre?, clinicians?, note?, website? }` (`website` = hidden honeypot) | 201 `{ ok: true }` (200 if email exists or honeypot filled) |
| `/api/providers/**`, `/api/admin/providers/**`, `/api/admin/verifications/**`, `/api/claims/:token`, `PATCH /api/orgs/:id/public` | 028 | see `docs/providers.md` | |
| `POST /api/reports/:id/parent-voice-note` | 015 | - | 200 `{ report, emailed, email_status }` (`email_status`: `sent` \| `demo` \| `no_email` \| `failed`) |

`ResolvedCitation = { kind: "fact" | "segment", id, recording_id, session_number | null, start_sec, label }`
where `label` is e.g. `Session 1 · 01:23` or `Intake call · 02:10`.

Every mutation writes an `audit_events` row via `lib/audit.ts`.

## 9. DEMO_MODE and fixtures

`DEMO_MODE=true` replaces external calls with files in `demo/fixtures/` (written by ticket 002):

| Call | Fixture |
|------|---------|
| Scribe v2 | `demo/fixtures/scribe-response.json` (generated from `roleplay-segments.json` by `scripts/make-scribe-fixture.ts`) |
| Gemini task `<task>` | `demo/fixtures/gemini/<task>.json` for `extract`, `brief`, `report`, `referral`, `ask`, `parent-summary` |
| ElevenLabs conversation token | none: start endpoint returns `{ demo: true }`, intake page shows "Simulate completed call" |
| ElevenLabs finished conversation | `demo/fixtures/elevenlabs-post-call.json` (`data`) returned by `/api/intake/:token/complete` and replayed by `/api/dev/simulate-intake/:token` |
| ElevenLabs TTS | skipped: report saved without audio, page shows "Voice note skipped in demo mode" |
| Resend | not sent: audit `email.demo_skipped`, returns `{ id: "demo", delivered: false }` |

`demo/fixtures/roleplay-segments.json` is the expected `Segment[]` for the role-play session (speaker
roles already mapped). Gaps between segments are >= 2.0 s and speakers alternate, so `lib/transcript.ts`
rebuilds exactly these segments from the Scribe fixture. Supabase (local Docker) is always real, even
in DEMO_MODE.

`lib/demo.ts` (001): `isDemoMode()` and `loadFixture<T>(relativePath, schema?)`. Fixtures are read
from `DEMO_FIXTURES_DIR` (default `demo/fixtures`) **from disk on every call** (no caching), so evals can
make a call fail by renaming one fixture file in a per-worker copy of the folder.

## 10. AI design (Gemini)

`lib/gemini.ts` (001): `generateJson<T>({ task, system, prompt, schema })`:
- DEMO_MODE -> `loadFixture("gemini/<task>.json", schema)`.
- Else `@google/genai` `models.generateContent({ model: GEMINI_MODEL, contents: prompt, config: {
  systemInstruction: system, responseMimeType: "application/json", responseJsonSchema:
  z.toJSONSchema(schema), temperature: 0.2 } })`. If the API rejects the schema, retry without
  `responseJsonSchema` (JSON mime type only).
- Parse + `schema.safeParse`. On failure retry **once**, appending `Your previous output was invalid:
  <first 3 zod issues>. Return only valid JSON.` Second failure -> throw `GeminiError` (routes answer 502).

**Transcript lines in prompts**: `[s12 | 01:23-01:30 | PARENT] text` (speaker upper-case, mm:ss).

**Evidence resolution (server, never trust the model for timestamps)**: for every item with a
`segment_id`, look the segment up; unknown id -> evidence null and confidence capped at 0.3. Quote is
verified if `normalize(quote)` is a substring of `normalize(segment.text)` (normalize = lower-case,
strip punctuation, collapse whitespace). Not verified -> keep evidence with `verified: false`,
confidence capped at 0.5. `start_sec`/`end_sec` come from the segment.

**Prompt rules** (each `prompts/*.md` must contain these):
- Every prompt: "You document; you never diagnose. Use only the transcript/facts given. Never invent
  quotes - copy them word for word from one segment."
- extract: rate an item only with direct evidence; no evidence -> rating null, confidence 0; parent
  statements are "parent-reported"; therapist lines starting "Note" are instructions
  (`rate item N as R`) -> `therapist_notes`; lost speech / self-injury -> `red_flags`.
- brief: summary for the therapist, every answer labelled parent-reported, 3-6 questions to verify,
  red flags cite `turn_id`.
- report: uses confirmed/edited facts only, never computes scores (the server inserts numbers).
- referral: summary of confirmed facts + intake highlights for a specialist.
- ask: answer only from given facts/segments, cite ids; if not documented -> `found: false`,
  answer `Not documented in this case.`
- parent-summary: plain words in the parent's language, no scores, no diagnosis words, next steps.

## 11. ElevenLabs

- **Scribe v2** (005): `POST https://api.elevenlabs.io/v1/speech-to-text` multipart: `model_id=scribe_v2`,
  `diarize=true`, `num_speakers=2`, `timestamps_granularity=word`, `file=<audio>`. Response
  `{ language_code, text, words: [{ text, start, end, type: "word"|"spacing"|"audio_event", speaker_id }] }`.
- **Segmentation** (005): consecutive words with the same `speaker_id` form a segment; start a new
  segment on speaker change, a gap > 1.5 s between words, or segment length > 30 s. Ids `s1, s2, ...`.
  Text = joined word/spacing texts, trimmed. Speaker map: the speaker with a segment whose text starts
  with `note` (case-insensitive, after trimming) is `therapist`; the other is `parent`. If none, the
  first segment's speaker is `therapist`.
- **Browser intake call** (009): server gets a WebRTC conversation token with
  `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<ELEVENLABS_AGENT_ID>`
  (header `xi-api-key`) -> `{ token }`. Browser (`@elevenlabs/react`, `ConversationProvider` +
  `useConversation`) calls `startSession({ conversationToken, dynamicVariables: { intake_token,
  child_alias, parent_alias, therapist_name, language }, overrides: { agent: { language } } })`.
- **Finished call, local (pull)** (010): when the browser session ends, the intake page posts the
  `conversation_id` (returned by `startSession`) to `POST /api/intake/:token/complete`. The server calls
  `GET https://api.elevenlabs.io/v1/convai/conversations/<id>` (header `xi-api-key`); `status` is
  `initiated | in-progress | processing | done | failed`. For the first three it answers 202 and the
  page polls every 3 s (max 120 s); a failed or unexpected status is an error, not another pending
  response. The `done` response has the same shape as the webhook's `data` object and goes through the
  same `processPostCall(data)` after verifying agent ID and intake token.
- **Post-call webhook (push, only when deployed or tunnelled)** (010): header
  `elevenlabs-signature: t=<unix s>,v0=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, max 30 min old
  (same rule as SDK `webhooks.constructEvent`). Handle `type === "post_call_transcription"`; read
  `data.conversation_id`, `data.transcript[]` (`role` `agent|user`, `message` (may be null),
  `time_in_call_secs`), `data.analysis.data_collection_results[<field>].value` and `.rationale`,
  `data.conversation_initiation_client_data.dynamic_variables.intake_token`.
- **TTS** (015): `POST /v1/text-to-speech/<voice_id>` `{ text, model_id: "eleven_v3" }` -> mp3
  (`eleven_v3` supports Telugu and Hindi; `eleven_multilingual_v2` has no Telugu).
- Agent configuration (prompt, first message, data collection, security overrides, webhook) is a
  human task for Role A: see `docs/elevenlabs-agent.md` (written by ticket 009).

## 12. Flows

```mermaid
sequenceDiagram
  autonumber
  participant T as Therapist
  participant App as Next.js API
  participant Pa as Parent (browser)
  participant EL as ElevenLabs
  participant G as Gemini
  T->>App: POST /api/cases/:id/intake-link
  App-->>T: url + WhatsApp link (email optional)
  Pa->>App: POST /api/intake/:token/start
  App->>EL: GET conversation token
  Pa->>EL: WebRTC voice call (consent, AI disclosure)
  Pa->>App: POST /api/intake/:token/complete (conversation_id)
  App->>EL: GET conversation (poll until done)
  App->>G: brief
  App-->>T: Brief tab shows summary, red flags, questions
```

```mermaid
sequenceDiagram
  autonumber
  participant T as Therapist
  participant App as Next.js API
  participant ST as Storage
  participant EL as Scribe v2
  participant G as Gemini
  T->>App: POST /api/cases/:id/sessions
  App-->>T: signed upload url
  T->>ST: upload audio
  T->>App: POST /api/sessions/:id/transcribe
  App->>ST: download
  App->>EL: transcribe (diarize)
  T->>App: POST /api/sessions/:id/extract
  App->>G: ISAA extraction (segment ids)
  App-->>T: 40 suggested facts with evidence
  T->>App: PATCH /api/facts/:id (confirm/edit)
  App-->>T: score + band + recommendation
```

Phase 3: Referral tab -> `POST /api/cases/:id/refer` (packet from confirmed facts + Gemini summary,
Resend email with `/specialist/<token>`) -> specialist opens page -> `POST /api/cases/:id/ask`.

## 13. Security and privacy

- Synthetic data only; banner on every page: `Demo - synthetic data only. AI documents, the clinician decides.`
- Service-role key only in server code (`lib/db.ts` throws when `typeof window !== "undefined"`; the
  `server-only` package is not used because it breaks tsx scripts and Vitest). RLS on, no policies.
- Tokens: `crypto.randomBytes(32).toString("base64url")` (43 chars) for intake and specialist links.
- Intake completion: the server only accepts a conversation whose `agent_id` is `ELEVENLABS_AGENT_ID`
  and whose `intake_token` dynamic variable equals the URL token. Webhook (when used): HMAC verified;
  unknown tokens return 200 `{ received: true, ignored: "unknown token" }` and are audited.
- Audio: private bucket, signed URLs valid 1 hour for playback.
- Consent: intake page requires a consent checkbox before Start; referral requires `parent_consent: true`.
- Audit log of every mutation (`audit_events`).
- Copy rules: never "diagnose/diagnosis" (except "not a diagnosis"), never "HIPAA compliant".

## 14. Human setup checklist (not tickets)

| Who | Task |
|-----|------|
| Everyone | Docker Desktop running; `git config core.hooksPath .githooks`; warm up Supabase images; create `int/<role>` ([team workflow](team-workflow.md)) |
| Everyone (after 001) | `npm install`, `npx supabase start`, `npm run db:env`, own API keys in `.env.local`, `npm run db:migrate` |
| A | ElevenLabs: claim perk, create the intake agent per `docs/elevenlabs-agent.md` (written by 009), enable the language override, put `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` and voice ids in every teammate's `.env.local` (team chat, never in git) |
| B | Gemini API key from AI Studio (credits until 13:00), shared via team chat |
| D | Resend account (free), API key; `DEMO_EMAIL_TO` = the Resend account email |
| D | Record the role-play audio as `demo/audio/session-1.mp3` (commit on `int/d-pitch`); then one live run with `DEMO_MODE=false` and refresh fixtures if needed |
| D (15:30) | Decide the product link: deploy (Vercel + Supabase cloud) or tunnel during judging |
| Merge captain | Verify configured public-repo branch protection remains active; merge reviewed checkpoint PRs, smoke-test `main`, tag `cp<n>`; require `ci` only after 001 creates it and it has run ([workflow](team-workflow.md)) |

## 15. Build plan

See [`specs/tickets/BOARD.md`](../specs/tickets/BOARD.md) (one table per builder) and the checkpoint
schedule in [team workflow](team-workflow.md). Critical path: 001 -> 002 -> 005/006 + 003 + 004 -> 007 ->
008 = Phase 2 end to end on `main` at CP3 (15:00).

## Appendix A: ISAA items (verify wording against the official ISAA manual before the demo)

| # | Domain | Item |
|---|--------|------|
| 1 | social | Has poor eye contact |
| 2 | social | Lacks social smile |
| 3 | social | Remains aloof |
| 4 | social | Does not reach out to others |
| 5 | social | Unable to relate to people |
| 6 | social | Unable to respond to social/environmental cues |
| 7 | social | Engages in solitary and repetitive play activities |
| 8 | social | Unable to take turns in social interaction |
| 9 | social | Does not maintain peer relationships |
| 10 | emotional | Shows inappropriate emotional response |
| 11 | emotional | Shows exaggerated emotions |
| 12 | emotional | Engages in self-stimulating emotions |
| 13 | emotional | Lacks fear of danger |
| 14 | emotional | Gets excited or agitated for no apparent reason |
| 15 | speech | Acquired speech and lost it |
| 16 | speech | Has difficulty in using non-verbal language or gestures to communicate |
| 17 | speech | Engages in stereotyped and repetitive use of language |
| 18 | speech | Engages in echolalic speech |
| 19 | speech | Produces infantile squeals/unusual noises |
| 20 | speech | Unable to initiate or sustain conversation with others |
| 21 | speech | Uses jargon or meaningless words |
| 22 | speech | Uses pronoun reversals |
| 23 | speech | Unable to grasp the pragmatics of communication (real meaning) |
| 24 | behaviour | Engages in stereotyped and repetitive motor mannerisms |
| 25 | behaviour | Shows attachment to inanimate objects |
| 26 | behaviour | Shows hyperactivity/restlessness |
| 27 | behaviour | Exhibits aggressive behaviour |
| 28 | behaviour | Throws temper tantrums |
| 29 | behaviour | Engages in self-injurious behaviour |
| 30 | behaviour | Insists on sameness |
| 31 | sensory | Unusually sensitive to sensory stimuli |
| 32 | sensory | Stares into space for long periods of time |
| 33 | sensory | Has difficulty in tracking objects |
| 34 | sensory | Has unusual vision |
| 35 | sensory | Insensitive to pain |
| 36 | sensory | Responds to objects/people unusually by smelling, touching or tasting |
| 37 | cognitive | Inconsistent attention and concentration |
| 38 | cognitive | Shows delay in responding |
| 39 | cognitive | Has unusual memory of some kind |
| 40 | cognitive | Has 'savant' ability |

## Appendix B: Case-sheet fields (ElevenLabs data collection)

| Field id | Type | Label (UI) | Description given to the agent |
|----------|------|------------|--------------------------------|
| `consent_given` | boolean | Consent given | Parent agreed to talk to an AI assistant and to recording |
| `child_age_months` | integer | Age (months) | Child's age in months |
| `main_concern` | string | Main concern | Parent's main concern in their own words |
| `speech_status` | string | Speech now | Current words/sentences the child uses |
| `lost_speech` | boolean | Lost speech | Child had words or skills and lost them |
| `lost_speech_details` | string | When speech was lost | When and what was lost |
| `eye_contact` | string | Eye contact | How the child looks at people |
| `response_to_name` | string | Response to name | Whether the child turns when called |
| `play_and_peers` | string | Play and other children | How the child plays, alone or with others |
| `repetitive_behaviours` | string | Repetitive behaviours | Lining up, hand flapping, repeated phrases |
| `sensory` | string | Sensory reactions | Reactions to sounds, textures, lights |
| `self_injury` | boolean | Self-injury | Child hurts themself (head hitting, biting) |
| `routines_and_tantrums` | string | Routines and tantrums | Reactions to changes in routine |
| `sleep_and_eating` | string | Sleep and eating | Sleep and eating patterns |
| `family_history` | string | Family history | Relevant family history the parent mentions |

## Appendix C: Canonical JSON shapes for `schemas/`

```json
// schemas/isaa.json (abridged: 40 items from Appendix A)
{ "instrument": "ISAA",
  "scale": [ { "value": 1, "label": "Rarely", "range": "up to 20%" },
             { "value": 2, "label": "Sometimes", "range": "21-40%" },
             { "value": 3, "label": "Frequently", "range": "41-60%" },
             { "value": 4, "label": "Mostly", "range": "61-80%" },
             { "value": 5, "label": "Always", "range": "81-100%" } ],
  "domains": [ { "id": "social", "name": "Social relationship and reciprocity", "items": [1,2,3,4,5,6,7,8,9] }, ... ],
  "items": [ { "id": 1, "domain": "social", "text": "Has poor eye contact" }, ... ],
  "bands": [ { "id": "no_autism", "min": 40, "max": 69, "label": "Below cut-off (under 70)" },
             { "id": "mild", "min": 70, "max": 106, "label": "Mild (70-106)" },
             { "id": "moderate", "min": 107, "max": 153, "label": "Moderate (107-153)" },
             { "id": "severe", "min": 154, "max": 200, "label": "Severe (154-200)" } ],
  "red_flag_items": { "15": "lost_speech", "29": "self_injury" } }

// schemas/facp.json
{ "instrument": "FACP",
  "bands": [ { "id": "typical", "min": 80, "max": 100, "label": "Typical", "action": "Home program and parent counselling, re-screen in 3 months" },
             { "id": "borderline", "min": 60, "max": 79, "label": "Borderline", "action": "IEP and home program, review in 3 months" },
             { "id": "moderate", "min": 40, "max": 59, "label": "Moderate", "action": "IEP and regular therapy sessions" },
             { "id": "severe", "min": 0, "max": 39, "label": "Severe", "action": "IEP and referral to specialist (Phase 3)" } ] }

// schemas/case-sheet.json
{ "fields": [ { "id": "consent_given", "type": "boolean", "label": "Consent given", "description": "..." }, ... ] }
```
