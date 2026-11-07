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
