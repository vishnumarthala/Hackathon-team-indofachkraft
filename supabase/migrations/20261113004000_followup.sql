-- Ticket 040: follow-up agent ("ask about my child's plan").
-- New tables only (nothing to backfill):
--   * followup_questions: a guardian's questions about one child and the grounded answers (FR-6, kept 90 days by the
--     041 retention job; history shown to the asking guardian only). A row with an empty answer is a reservation of
--     the 30-questions-per-day limit (same pattern as 013's case_questions); real answers are never empty.
--   * followup_agent_sessions: 15-minute voice sessions bound to (guardian, child) (FR-5). Only the SHA-256 of the
--     random session token is stored; the ElevenLabs agent sends the token with every `answer_question` tool call.
-- The server uses the service role and gates every route in code (lib/authz.ts + lib/followup); RLS is on with no
-- browser grants.

create table public.followup_questions (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  guardian_user_id uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(question) between 3 and 500),
  answer text not null default '',
  found boolean not null default false,
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  safety text check (safety in ('red_flag', 'medical_advice')),
  channel text not null default 'text' check (channel in ('text', 'voice')),
  created_at timestamptz not null default now()
);

create index followup_questions_guardian_created_idx on public.followup_questions (guardian_user_id, created_at desc);
create index followup_questions_child_guardian_idx on public.followup_questions (child_id, guardian_user_id, created_at desc);

alter table public.followup_questions enable row level security;
revoke all on public.followup_questions from anon, authenticated;

create table public.followup_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (char_length(token_hash) = 64),
  guardian_user_id uuid not null references auth.users(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  demo boolean not null default false,
  tool_calls integer not null default 0 check (tool_calls >= 0),
  -- Opaque ElevenLabs conversation id (set once by the browser) so erasure can delete the processor's copy (041).
  conversation_id text check (conversation_id is null or char_length(conversation_id) between 1 and 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > created_at)
);

create index followup_agent_sessions_child_idx on public.followup_agent_sessions (child_id);
create index followup_agent_sessions_guardian_idx on public.followup_agent_sessions (guardian_user_id, created_at desc);

alter table public.followup_agent_sessions enable row level security;
revoke all on public.followup_agent_sessions from anon, authenticated;
