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
- **Children and consent (ticket 020).** A child (`children`) is separate from the org-specific case
  (`cases.child_id`, not null; legacy cases got unclaimed `legacy_case` children, never a guessed guardian
  or consent). Guardians link to children by adding them or with a one-time parent code from the centre.
  Versioned per-child, per-feature consent (`consent_records`, append-only; `child_consent_state`) gates
  every AI/recording/sharing step at collection time **and** again right before queued work sends data to
  an external processor (`requireConsent` / `assertConsentOrAbort` in `lib/consent`); both fail closed.
  Centres record paper consent (printed form, signed scan in the private `consent-forms` bucket, provider
  attestation). Intake links expire after 7 days, referral links after 30; both are revocable. Details and
  how to gate a new feature: `docs/consent.md`.
- **Care team and cross-org sharing (ticket 022).** Org owners/admins open every case of their org;
  plain members only cases they are assigned to (`case_assignments`, one lead per case; new cases get the
  creator as lead). The rule lives in SQL (`case_access_level`) and drives `requireCaseAccess`, the
  `/dashboard` list and RLS. A child's records reach another organisation only through a guardian's
  scoped, read-only, revocable `sharing_grants` row (`requireSharedAccess(childId, scope)`); features
  register what each scope shows in `lib/sharing/registry.ts`. See `docs/sharing.md`.
- **Document vault (ticket 023).** Per-child files in the private `documents` bucket (20 MB; PDF, JPEG,
  PNG, HEIC checked by magic bytes). Two-step signed upload + `complete`; every read goes through the SQL
  rule `document_access` (linked guardian, case providers, orgs a guardian shared the file with, `documents`
  sharing grants) and downloads are a 302 to a 300 s signed URL minted only after a strict
  `document.downloaded` audit row. See `docs/documents.md`.
- **Child health profile (ticket 021).** One profile per child (`child_health_profiles`: allergies,
  medicines, conditions, birth/developmental history, emergency contact, blood group), edited only by a
  linked guardian with optimistic concurrency (`version`, 409 on a stale save) and an append-only
  `child_health_profile_history` written by a trigger. Providers read it through an accessible case
  (`GET /api/cases/:id/health`, `Health` tab, `Severe allergy` banner). Later tickets use
  `getPrescribingHealthFacts` / `healthSummary`. See `docs/health-profile.md`.
- **IEP plans, SMART goals and progress (ticket 025).** Case-scoped plans (`iep_plans`, one `active` per case)
  with SMART goals by domain (`iep_goals`) and progress points (`goal_progress`), plan-level optimistic
  concurrency (`version`, 409). Publishing renders markdown and stores it with `publishVersion` (`iep_plan`,
  visible to guardians) plus a goal snapshot (`iep_publications`); guardians (`/family/children/[id]/plan`) and the
  `iep` share scope see only published text with live progress values. See `docs/iep.md`.
- **Home program (ticket 026).** Case-scoped programs (`home_programs`, one `published` per case) of up to 15
  active activities (`home_activities`, optionally linked to a goal of the case's active IEP plan and to a guide
  document from the vault) and guardian practice logs (`home_activity_logs`, one per activity/day/guardian,
  upserted). Publishing stores `publishVersion` (`home_program`) plus an activity snapshot
  (`home_program_publications`); guardians (`/family/children/[id]/home-program`, `Done today`), the
  `home_program` share scope and 040 (`getGuardianHomePrograms`) see only the published snapshot. Adherence weeks
  start Monday in the guardian's time zone. See `docs/home-program.md`.
- **Real patient data** still waits for the privacy/audit baseline (041) and legal review of the consent
  texts.
- Parent intake and specialist pages remain accessible only with an unguessable token. The matching
  token-based API endpoints and signed webhook are public by design.
- **Provider profiles and verification (ticket 028).** Stable `provider_profiles.id` per provider,
  public at `/p/<slug>` (and centres at `/c/<slug>`) only when a platform admin verified the registration
  (`/admin/verifications`) and the provider listed it. Self-registration at `/join`, admin seeding at
  `/admin/providers/new`, single-use claim links at `/claim/<token>`. `can_prescribe` is the SQL function
  `provider_can_prescribe(profile_id)` (type + verified + NMC/state council), never stored. See
  `docs/providers.md`.
- **"Near me" directory (ticket 029).** PostGIS (`extensions` schema): `practice_locations.geog` is
  maintained from `lat/lng` by a trigger (GiST index); `search_providers(...)` (service role only) returns
  verified + listed profiles, one row per profile at its nearest location. Public `/find` (server-rendered
  from the URL, list works without a map), `GET /api/public/providers` (60/min per IP), SEO pages
  `/find/hyderabad/<type>`, `Get directions` on `/p/<slug>`. Addresses are geocoded server-side when a
  location is created (Google with `GOOGLE_MAPS_SERVER_KEY`, else the bundled Hyderabad PIN code table).
  The searcher's location is never stored. See `docs/maps.md`.
- **Notifications (ticket 032).** Every user-facing notification goes through the transactional outbox:
  the domain write and `outbox_events` row commit together (`enqueue(tx, ...)` from `lib/notify/outbox.ts`
  inside `sql.begin`, or `public.outbox_enqueue(...)` from SQL; `enqueueEvent(...)` for supabase-js code).
  A worker fans due events out into per-recipient, per-channel `notifications` (in-app / Resend email with
  `.ics` / Meta WhatsApp templates), re-checking access at fan-out, then delivers under `skip locked` leases
  with retries (1 min .. 12 h, then `dead`). Scheduler: Vercel cron every minute (`vercel.json`,
  `/api/cron/outbox`, `CRON_SECRET`) plus an immediate `after()` drain (`drainSoon`); locally
  `npm run outbox:run`. Bell + `/notifications`, preferences in settings, `/admin/notifications`.
  See `docs/notifications.md`.
- **Secure messaging (ticket 027).** Case-scoped threads between a child's guardians and the care team of
  one organisation (`message_threads`, `messages`, `thread_reads`). Access is one SQL rule
  (`thread_access_level`: linked guardian, or 022 case access) used by the routes and by RLS
  (`can_access_thread`), which is the browser's only path: `messages` is in the `supabase_realtime`
  publication and pages fall back to polling every 15 s without Realtime. Writes are security-definer
  functions (message + `message.created` outbox event 2 min later + strict audit, ids only); notifications
  never carry message text. Attachments must be readable by every participant under 023's rule. See
  `docs/messaging.md`.
- **Privacy, audit and operations (ticket 041).** `audit_events` is append-only for every role, survives case
  deletion (`case_ref`, no FK) and is attributed (`actor_user_id` + `actor_role` from the session, `org_id`,
  `child_id`, `request_id`, `ip_hash`; a trigger fills them for every writer). `audit()` is best effort; security-critical
  actions (`lib/audit/strict-actions.ts`) use `auditStrict(event, tx)` in the same transaction (or a SQL function that
  writes its own audit row) and answer 503 when the audit row cannot be written. `lib/privacy/registry.ts` lists every
  personal-data category with its retention, exporter, deleter and processors; daily `/api/cron/retention`, privacy
  jobs `/api/cron/privacy` (guardian ZIP exports, deletion requests incl. ElevenLabs conversation deletion), public
  `/privacy` notice, `/admin/audit`, `/admin/privacy/requests`, `/admin/ops`, public `GET /api/health`. No third-party
  scripts on `/family/**` except the per-route allowlist (`lib/privacy/third-party-allowlist.ts`). Logs go through
  `lib/log.ts` (redacts emails, phones, tokens). See `docs/privacy/retention.md`, `docs/privacy/processors.md`,
  `docs/privacy/incident-response.md`.

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
docs/     system-design.md  elevenlabs-agent.md  i18n.md  guardian-auth.md  consent.md  sharing.md  health-profile.md
          documents.md  assessments.md  notifications.md  iep.md  home-program.md  messaging.md
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
| `GOOGLE_MAPS_SERVER_KEY` | server geocoding (029) | optional; Geocoding API only, IP/API restricted, never sent to the browser; unset or `DEMO_MODE=true` -> bundled Hyderabad table (`docs/maps.md`) |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` / `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | `/find` map + Places, `/p` static map (029) | optional; referrer restricted; passed to client components at request time; unset -> list only |
| `NEXT_PUBLIC_SUPABASE_URL` | server + browser upload | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser upload only | cannot read tables (RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | never sent to the browser |
| `DATABASE_URL` | `npm run db:sql`, `db:check`, seed | local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `_SECRET` | Supabase CLI only (local Google sign-in) | not read by the app; see `docs/guardian-auth.md`. Hosted projects set Google in the Supabase dashboard |
| `ELEVENLABS_API_KEY` | Scribe, conversation token, TTS | |
| `ELEVENLABS_AGENT_ID` | intake page | agent configured per `docs/elevenlabs-agent.md` |
| `ELEVENLABS_SCREEN_AGENT_ID` | `/screen` voice check-in (033) | optional; English-only public agent per `docs/elevenlabs-screen-agent.md`; unset (and not `DEMO_MODE`) -> the page offers only the tap-through form |
| `ELEVENLABS_WEBHOOK_SECRET` | webhook HMAC | only needed when the webhook is used (deployed or tunnel) |
| `ELEVENLABS_VOICE_ID_EN` / `_HI` / `_TE` | parent voice note | |
| `GEMINI_API_KEY` | Gemini | |
| `GEMINI_MODEL` | Gemini | default `gemini-3.8-flash` |
| `RESEND_API_KEY` | email | |
| `EMAIL_FROM` | email | default `DoctorNearMe <onboarding@resend.dev>` |
| `DEMO_EMAIL_TO` | email | if set, **every** email goes here (Resend test sender only delivers to the account owner); body starts with `Originally to: <address>` |
| `CONSENT_IP_SALT` | consent records | optional salt for the sha256 IP hash stored with each consent record; falls back to the service role key (020) |
| `CRON_SECRET` | `/api/cron/*` (032) | `Authorization: Bearer <CRON_SECRET>`; Vercel cron sends it automatically when set in the project; unset = cron refused |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp notifications (032) | optional; unset or `DEMO_MODE=true` -> WhatsApp deliveries `skipped` (`whatsapp_not_configured`) |
| `WHATSAPP_API_VERSION` | WhatsApp notifications (032) | Graph API version, default `v21.0` |
| `GRIEVANCE_OFFICER_EMAIL` | `/privacy` (041) | grievance officer contact on the privacy notice; required before the pilot |
| `PRIVACY_NOTICE_REVIEWED` | `/privacy` (041) | `true` only after legal review; otherwise the notice shows `Draft - pending legal review` |
| `SUPABASE_REGION_LABEL` | `/privacy` (041) | where Supabase stores data, as shown to families (e.g. `India (Mumbai)`) |
| `RETENTION_AUDIO_DAYS` | retention job (041) | raw audio kept after transcription, default 90; other `RETENTION_*` overrides in `.env.example` and `docs/privacy/retention.md` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | payments (031) | **test mode only**: a key id not starting with `rzp_test_` stops the server (`instrumentation.ts`); optional with `DEMO_MODE=true` (demo gateway); see `docs/payments.md` |
| `AUDIT_FAIL_ACTIONS` | dev/test only (041) | comma-separated audit actions whose audit write fails (checks fail-closed behaviour); ignored in production builds |

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

### Booking (ticket 030, design rules 10-12)

`services`, `availability_rules`, `availability_overrides`, `appointments` (half-open `tstzrange` slot,
`exclude using gist (provider_profile_id with =, slot with &&)` over `held`/`pending_payment`/`confirmed`,
`btree_gist`) and the append-only `appointment_events`; every transition is one security-definer SQL function
(`booking_hold`, `booking_attach`, `booking_confirm`, `booking_cancel`, `booking_reschedule`, `booking_complete`,
`booking_expire_stale`). Migration `20261113003000_booking.sql`; details, API and extension points for 031/034/035/037/042
in `docs/booking.md`.

### Payments (ticket 031, design rule 12)

`payments` (one Razorpay order per appointment, status `created`/`authorized`/`captured`/`failed`/`refund_pending`/
`refunded`, separate from the appointment's status) and `payment_events` (webhook deliveries, unique Razorpay event id,
allowlisted payload without card/UPI details). `payment_apply_captured` is the single capture path (checkout handler and
webhook): confirms through 030's helpers, re-books a late payment's slot if still free, else refunds. Triggers on
`appointments` apply the cancellation refund policy and move a payment with a reschedule. Migration
`20261113003100_payments.sql`; details in `docs/payments.md`.

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

### Clinical contracts (ticket 024, design rules 8 and 9)

Shared contracts that later tickets (025 IEP, 026 home program, 033 voice screen, 035 intake, 038 scribe,
039 e-Rx, 040 follow-up) build on. The ISAA behaviour above is unchanged; `tests/regression-child-dev.test.ts`
runs the whole Child Development pipeline on the demo fixtures and compares every output with a baseline
captured before 024 (`tests/fixtures/regression-child-dev/baseline.json`).

| Contract | Module | Rule |
|---|---|---|
| Instrument registry | `lib/clinical/instruments.ts` (`getInstrument`, `InstrumentDefinition`, `score`), table `clinical_instruments` | Keys `ISAA`, `CASE_SHEET`, `ISAA_PARENT_CHECKIN`; `definition` = the `schemas/*.json` file (a test fails on drift). `facts.instrument` is a foreign key to it. `score("ISAA", facts)` delegates to `scoreIsaa` unchanged. New standardised instruments need a licensing review. |
| Parent check-in | `schemas/isaa-parent-checkin.json`, `lib/clinical/checkin.ts` (`scoreCheckin`, `checkinRedFlags`, `URGENT_COPY`) | 15 ISAA-derived parent questions (never/sometimes/often/always, some reverse-worded) + 6 yes/no red-flag questions (`skill_regression`, `self_injury`, `seizure`, `breathing`, `not_eating_drinking`, `safety_concern`). Bands `no_strong_signs` (0-9) / `discuss_with_professional` (10-19) / `see_professional_soon` (20-45, or any red flag). Copy always says `This is a developmental check-in, not a diagnosis.`; any red flag shows `Please contact your child's doctor now. In an emergency call 108 (ambulance) or 112.` English only; thresholds and wording await clinical review. |
| Report kinds | `lib/clinical/reports.ts` (`REPORT_KINDS`) | In use: `pre_session_brief`, `assessment`, `parent_summary`, `session_note` and `rx_draft` (038, `docs/scribe.md`); reserved: `generic_intake_brief` (035). Each has `audience`, `publishable`, `producer`. The ticket that starts writing a reserved kind extends the `reports.kind` check in its migration. |
| Published versions | `lib/clinical/publish.ts` (`publishVersion(tx, input)`, `getLatestPublished`, `listGuardianVisible`, `contentHash`, `setActor`), table `published_versions`, SQL `publish_version(jsonb)` | **`content_md` is authoritative**; `reports.content` (jsonb) is only the AI draft input. One append-only row per (entity_type, entity_id, version): `report`, `iep_plan`, `home_program`, `prescription`, `assessment`; `content_hash` = sha256(content_md); update/delete raise (rows go only with their case; `child_id` follows its case when 020's claim merges a placeholder child, trigger `cases_child_follow`). `publish_version` is the only writer (service role cannot insert); call `publishVersion(tx, ...)` inside the transaction that changes the entity. A report becoming `final` publishes itself in the same transaction (trigger `reports_publish_final`; `assessment` -> provider only, `parent_summary` -> visible to the guardian; a changed final `content_md` -> next version). The latest version decides guardian visibility. Guardians read only `visible_to_guardian` versions; other orgs only through a sharing grant. Existing final reports were backfilled (`backfill_published_reports()`); `npm run db:check` reports final reports without a version. |
| Speaker roles | `lib/clinical/speakers.ts`, `SpeakerRoleSchema` | Stored values unchanged: `therapist` = the clinician of any provider type, `parent` = guardian/caregiver, `agent` = AI assistant, `unknown`; new `child`, `other_adult`. UI labels via i18n `speakers.*` (`Clinician`, `Parent or caregiver`, `Child`, `Other adult`, `AI assistant`, `Unknown`); prompts keep the stored value. The 008 swap only exchanges therapist <-> parent. |

The assessment portal (questionnaires sent to guardians, review, publishing, `assessments` share scope) is
described in `docs/assessments.md`.
IEP plans publish with `entity_type = 'iep_plan'` (ticket 025, `docs/iep.md`).
The AI scribe (ticket 038, `docs/scribe.md`) generalises the session pipeline to every provider type: recordings carry a
`template` (`child_dev_isaa` = the unchanged ISAA path, `therapy_session_note`, `medical_consult_note` with `kind =
'consult'`), and produce `session_note` / `rx_draft` reports and `goal_progress_suggestions`. Session notes are
published by `finalizeSessionNote` (not by the `reports_publish_final` trigger, which skips both kinds) with the
clinician's `visible_to_guardian` choice.
Home programs publish with `entity_type = 'home_program'` (ticket 026, `docs/home-program.md`).

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
| `POST /api/cases/:id/sessions` | 005, 038 | `{ file_name, mime_type, size_bytes, consent?: boolean, template?, appointment_id? }` | 201 `{ recording_id, session_number, template, bucket, path, token, signed_url }`; 422 video appointment (`The AI scribe is available for in-clinic sessions only`) |
| `POST /api/sessions/:id/transcribe` | 005 | - | 200 `{ recording_id, status, segments_count, duration_sec, speaker_map }` |
| `POST /api/sessions/:id/extract` | 006 | - | 200 `{ recording_id, facts, red_flags, therapist_notes_applied }` (409 for AI scribe templates) |
| `POST\|GET\|PATCH /api/sessions/:id/scribe` | 038 | PATCH `{ content_md?, status?: "final", visible_to_guardian? }` | POST 200 `{ session_note_id, session_note_status, goal_suggestions, rx_draft_id? }`; 409 ISAA session / running / not transcribed; 422 consent or video appointment (`docs/scribe.md`) |
| `PATCH /api/goal-suggestions/:id` | 038 | `{ status: "accepted" \| "rejected", value? }` | 200 `{ suggestion, entry?, trend? }` (goal_progress `ai_suggested_confirmed`); 409 already decided; 404 other org |
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
| `GET\|POST /api/cases/:id/assignments`, `PATCH\|DELETE /api/cases/:id/assignments/:assignmentId` | 022 | `{ user_id, care_role?, discipline_label? }` | 201 `{ assignment }`; 422 not in org; 409 duplicate / last lead (`docs/sharing.md`) |
| `GET\|POST /api/family/children/:id/sharing-grants`, `POST .../sharing-grants/:grantId/revoke` | 022 | `{ source_org_id, grantee_org_id, scopes, expires_in_days?: 90 \| 365 \| null }` | 201 `{ grant }`; 422 org not treating the child (`docs/sharing.md`) |
| `GET\|PUT /api/family/children/:id/health`, `GET /api/cases/:id/health` | 021 | PUT: full profile + `version` | 200 `{ profile }`; 409 stale version; 400 `details` by field path; case route 404 without profile (`docs/health-profile.md`) |
| `GET\|POST /api/family/children/:id/documents`, `GET\|POST /api/cases/:id/documents`, `POST /api/documents/:docId/complete`, `GET\|PATCH\|DELETE /api/documents/:docId`, `GET /api/documents/:docId/download`, `POST\|DELETE .../documents/:docId/shares[/:orgId]` | 023 | see `docs/documents.md` | 201 `{ document_id, signed_upload_url, token, path }`; 413 / 415 / 422; download 302 |
| `GET\|POST /api/cases/:id/iep-plans`, `GET\|PATCH /api/iep-plans/:planId`, `POST /api/iep-plans/:planId/publish`, `GET\|POST /api/iep-plans/:planId/goals`, `PATCH\|DELETE /api/iep-goals/:goalId`, `GET\|POST /api/iep-goals/:goalId/progress`, `GET /api/family/children/:id/plan` | 025 | plan/goal writes carry the plan `version` | 201/200; 409 stale `This plan was changed by someone else. Reload to see the latest version.`; 400 field errors; 422 no goals / > 20 goals (`docs/iep.md`) |
| `GET\|POST /api/cases/:id/home-programs`, `GET\|PATCH /api/home-programs/:pid`, `POST /api/home-programs/:pid/activities`, `POST /api/home-programs/:pid/publish`, `PATCH\|DELETE /api/home-activities/:aid`, `GET /api/family/children/:id/home-program`, `POST /api/family/home-activities/:aid/logs`, `DELETE /api/family/home-activity-logs/:id` | 026 | program PATCH / publish carry the program `version` | 201/200; 409 stale; 422 `Choose a goal from this child's plan` / > 15 active activities; guardian logs 201 new / 200 same day again, 400 future or > 14 days ago (`docs/home-program.md`) |
| `/api/providers/**`, `/api/admin/providers/**`, `/api/admin/verifications/**`, `/api/claims/:token`, `PATCH /api/orgs/:id/public` | 028 | see `docs/providers.md` | |
| `GET /api/public/providers?lat=&lng=&radius_km=&type=&language=&mode=&page=` | 029 | public, 60/min per IP | 200 `{ results, page, has_more }`; 400; 422 outside India; 429 (`docs/maps.md`) |
| `GET /api/public/providers/:profileId/slots`, `POST /api/appointments/hold`, `POST /api/appointments/:id/{confirm,cancel,reschedule,complete}`, `GET /api/appointments/:id/ics`, `/api/provider/{services,availability}/**`, `GET\|POST /api/cron/booking` | 030 | see `docs/booking.md` | 201 hold / 200; 409 `This slot was just taken. Please pick another time.`; 410 `Your hold expired. Please pick the time again.`; 404 other owners |
| `POST /api/appointments/:id/payment-order`, `POST /api/payments/verify`, `POST /api/payments/demo` (DEMO_MODE), `POST /api/webhooks/razorpay` (public, signed), `GET\|POST /api/cron/payments` | 031 | see `docs/payments.md` | 200 `{ key_id, order_id, amount_paise, currency, prefill }`; verify 400 signature mismatch; webhook 401 bad signature, 200 `{ received: true, duplicate: true }` on replay; 404 other owners; 409 nothing to pay / already paid; 410 hold expired |
| `GET\|POST /api/threads`, `GET\|POST /api/threads/:id/messages`, `POST /api/threads/:id/read`, `POST /api/threads/:id/archive`, `DELETE /api/messages/:id` | 027 | see `docs/messaging.md` | 201 `{ thread, message }` / `{ message }` (200 on a repeated `client_id`); 422 no parent / attachment; 409 archived / delete window; 429 |
| `GET\|POST /api/cron/outbox`, `GET /api/notifications?cursor=`, `POST /api/notifications/read`, `GET\|PUT /api/notification-preferences`, `POST /api/admin/notifications/:id/retry` | 032 | see `docs/notifications.md` | |
| `GET\|POST /api/family/children/:id/exports`, `GET /api/family/exports/:id/download` | 041 | - | 202 `{ export_id }`; 429 one running / 3 per day; download 302 (requester only, else 404) (`docs/privacy/retention.md`) |
| `GET\|POST /api/family/children/:id/deletion-requests`, `POST /api/admin/privacy/requests/:id` | 041 | `{ scope: "all_ai_processing" \| "everything", reason? }`; admin `{ decision: "approve" \| "reject", note? }` | 201 `{ request }`; 409 open request; admin 200 `{ id, status }`, 403 non-admin, 400 rejection without a cited note |
| `GET\|POST /api/cron/retention` (daily), `GET\|POST /api/cron/privacy` (every 5 min) | 041 | `Authorization: Bearer <CRON_SECRET>` | 200 `{ counts }` / `{ exports, deletions }`; 401 |
| `GET /api/health` | 041 | public | 200 `{ ok: true, db: "ok", version }`; 503 `{ ok: false, db: "unreachable" }` |
| `POST /api/screen/sessions`, `GET /api/screen/sessions/:id`, `POST /api/screen/sessions/:id/answers\|red-flag\|finish` | 033 | public; `{ age_band, mode }`, `{ answers: [{ item_id, answer }] }`, `{ code }`, finish `{ conversation_id? }` | 201 `{ session_id, questions, conversation_token?, dynamic_variables? }` or `{ demo: true }`; answers 200 `{ missing, stop }`; red-flag 200 `{ stop: true }`; finish 200 `{ result_band, domains, red_flag, message }`; 404 / 409 stopped or finished / 410 expired (2 h) / 422 incomplete / 429 5 per IP per hour (section 13a) |
| `POST /api/family/screen-results` | 033 | `{ session_id, child_id }` | 201 (200 again) `{ saved: true }`; 401; 404 not your child; 422 `screen_result_save` consent; 409 unfinished / red flag / other child; 410 expired |
| `POST /api/reports/:id/parent-voice-note` | 015 | - | 200 `{ report, emailed, email_status }` (`email_status`: `sent` \| `demo` \| `no_email` \| `failed`) |

`ResolvedCitation = { kind: "fact" | "segment", id, recording_id, session_number | null, start_sec, label }`
where `label` is e.g. `Session 1 · 01:23` or `Intake call · 02:10`.

Every mutation writes an `audit_events` row via `lib/audit.ts` (041: security-critical ones with `auditStrict`, see
`lib/audit/strict-actions.ts`).

## 9. DEMO_MODE and fixtures

`DEMO_MODE=true` replaces external calls with files in `demo/fixtures/` (written by ticket 002):

| Call | Fixture |
|------|---------|
| Scribe v2 | `demo/fixtures/scribe-response.json` (generated from `roleplay-segments.json` by `scripts/make-scribe-fixture.ts`) |
| Gemini task `<task>` | `demo/fixtures/gemini/<task>.json` for `extract`, `brief`, `report`, `referral`, `ask`, `parent-summary`, `scribe-therapy`, `scribe-medical`, `scribe-rx` (038) |
| Scribe v2 for AI scribe templates (038) | `scribe-response-therapy.json` / `scribe-response-consult.json` (from `roleplay-{therapy,consult}-segments.json`, `npm run fixtures:scribe`) |
| ElevenLabs conversation token | none: start endpoint returns `{ demo: true }`, intake page shows "Simulate completed call" |
| ElevenLabs finished conversation | `demo/fixtures/elevenlabs-post-call.json` (`data`) returned by `/api/intake/:token/complete` and replayed by `/api/dev/simulate-intake/:token` |
| ElevenLabs TTS | skipped: report saved without audio, page shows "Voice note skipped in demo mode" |
| Resend | not sent: audit `email.demo_skipped`, returns `{ id: "demo", delivered: false }` |
| WhatsApp Cloud API (032) | not called: notification `skipped` with `whatsapp_not_configured` |
| Razorpay (031) | demo gateway (`lib/payments/razorpay.ts`): deterministic `order_DEMO…` / `pay_DEMO…` / `rfnd_DEMO…` ids, refunds processed at once; the payment page shows `Simulate successful payment` / `Simulate failed payment` (signed and verified through `/api/payments/verify`) and never loads Razorpay's script |

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
- **Public check-in agent** (033): a second, English-only private agent (`ELEVENLABS_SCREEN_AGENT_ID`,
  `docs/elevenlabs-screen-agent.md`). `startAgentSession(agentId)` / `getConversationToken(agentId)` take the agent
  id (default: the intake agent). Dynamic variables `{ screen_session_id, age_band, questions }` only; answers come
  back through the client tools `record_answer({ item_id, answer })` / `record_red_flag({ code })`
  (`lib/screen/client.ts`); no webhook, no data collection.

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
- Documents (023): private bucket, signed URLs valid 300 s, minted only after the access check and the
  strict `document.downloaded` audit row; never logged (`docs/documents.md`).
- Messaging (027): RLS select policies are the browser's path to `message_threads` / `messages` /
  `thread_reads` (also for Realtime); message text is never logged, audited or put in notifications
  (`docs/messaging.md`).
- Consent: intake page requires a consent checkbox before Start. Since 020 every gated step also needs the
  guardian's recorded consent for that feature (server-side; a client `parent_consent` flag is ignored);
  see `docs/consent.md`.
- Audit log of every mutation (`audit_events`).
- 041: the audit log is append-only for every role (trigger + revoked grants), attributed from the session, kept 7
  years and survives case deletion; strict audit for security-critical writes (503 on failure); retention, guardian
  export and deletion (incl. ElevenLabs conversations) per `docs/privacy/retention.md`; incident procedure in
  `docs/privacy/incident-response.md`; no third-party scripts on `/family/**` outside the per-route allowlist; server
  logs redact emails, phones and tokens (`lib/log.ts`), and the dev request log skips token URLs.
- Copy rules: never "diagnose/diagnosis" (except "not a diagnosis"), never "HIPAA compliant".

## 13a. Public developmental check-in (ticket 033)

- `/screen` (public, linked from the landing page and the nav): age band (`18-36m`, `3-5y`, `6-9y`, `10y+`, mapped to
  024's instrument bands), the "not a diagnosis" agreement, then voice (`components/screen/VoiceCheckin.tsx`) or the
  tap-through form (`QuestionForm.tsx`) over the **same** 024 `ISAA_PARENT_CHECKIN` questions, red-flag questions
  first (`lib/screen/questions.ts` `screenQuestions`). Question text stays English; the chrome is translated
  (`screen.*` messages).
- Rule 6: before sign-in nothing identifies the child. `screen_sessions` (migration `20261113003300_screen.sql`) holds
  `id, created_at, expires_at (+2 h), age_band, mode, answers, result_band, red_flag_codes, conversation_id,
  saved_child_id, saved_by` - no IP, no names; `screen_answers_valid()` lets `answers` hold only item ids -> scale
  values. The rate limit (5 sessions per IP per hour, `lib/screen/rate-limit.ts`) keys on a salted in-memory hash.
  Anonymous actions write no audit rows (they would attach a hashed IP). The browser keeps only the session id in
  `sessionStorage` (resume after reload / sign-in).
- Server-side scoring: `finish` calls 024 `score("ISAA_PARENT_CHECKIN", answers)`; domain levels are draft
  thresholds (`domainLevel`). A red flag (any time, `answers` with `yes` or `red-flag`) stops the session: no band,
  the page shows only the 108/112 message (`UrgentNotice`), no providers, no booking.
- Result page: band headline, per-domain text, "not a diagnosis", `Find a specialist near you` (029
  `GET /api/public/providers` per suggested type after a locality / "Use my location" prompt; links to `/p/<slug>`
  and `/find`, no booking), and `Save this result to <child>` for a signed-in guardian
  (`POST /api/family/screen-results`: guardian link -> 020 `requireConsent(childId, "screen_result_save")` (422 ->
  inline Allow dialog posting to 020's consent API) -> strict audit `screen.result_saved`). Saved check-ins appear
  under `Check-ins` on the child page and leave the anonymous endpoints (404).
- Privacy: 041 registry `screen_results` (export = the Check-ins list; erasure deletes the rows and the ElevenLabs
  conversation); retention step `unsaved_screen_sessions` deletes unsaved rows after 30 days. `/screen` gets the
  strict family CSP (nonce, no analytics) plus the ElevenLabs API/LiveKit `connect-src` (`lib/csp.ts`,
  `lib/privacy/third-party-allowlist.ts`).

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
