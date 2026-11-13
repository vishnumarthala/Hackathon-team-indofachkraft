-- Ticket 033: public developmental check-in (/screen). One row per check-in session.
--
-- Rule 6 (no identifiable child data before sign-in + consent): the table has no names, no date of birth, no IP
-- address, no free text. `answers` only holds `{ "<item id>": "<scale value>" }` pairs from the
-- ISAA_PARENT_CHECKIN instrument (024), enforced by `screen_answers_valid()`. The per-IP rate limit lives in
-- server memory as a salted hash and is never stored.
--
-- Lifecycle: a session accepts answers for 2 hours (`expires_at`). Rows that were never saved to a child are
-- deleted 30 days after `created_at` by the retention job (041 registry `screen_results`). Saving to a child
-- (020 consent `screen_result_save`) sets `saved_child_id` + `saved_by`, which removes the row from that rule.
-- Server-only: RLS on, no policies, no grants for anon/authenticated (the app uses the service role).

create or replace function public.screen_answers_valid(a jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(a) = 'object'
    and not exists (
      select 1 from jsonb_each(a) e
      where e.key !~ '^(q[0-9]{1,3}|rf_[a-z_]{1,40})$'
         or jsonb_typeof(e.value) <> 'string'
         or (e.value #>> '{}') not in ('never', 'sometimes', 'often', 'always', 'no', 'yes')
    );
$$;

create table public.screen_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  age_band text not null check (age_band in ('18-36m', '3-5y', '6-9y', '10y+')),
  mode text not null check (mode in ('voice', 'form')),
  answers jsonb not null default '{}'::jsonb check (public.screen_answers_valid(answers)),
  result_band text check (result_band in ('no_strong_signs', 'discuss_with_professional', 'see_professional_soon')),
  red_flag_codes text[] not null default '{}' check (
    red_flag_codes <@ array['skill_regression', 'self_injury', 'seizure', 'breathing', 'not_eating_drinking', 'safety_concern']::text[]
  ),
  -- ElevenLabs conversation id of a voice check-in (an opaque id, used to delete the processor copy on erasure).
  conversation_id text check (conversation_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  saved_child_id uuid references public.children(id) on delete cascade,
  saved_by uuid references auth.users(id) on delete set null,
  -- FR-7: a red flag stops the check-in; it never gets a result band.
  constraint screen_sessions_red_flag_no_band check (result_band is null or cardinality(red_flag_codes) = 0),
  -- FR-8: only a finished check-in (with a band) can be saved to a child.
  constraint screen_sessions_saved_has_band check (saved_child_id is null or result_band is not null),
  constraint screen_sessions_saved_by_child check (saved_by is null or saved_child_id is not null)
);

comment on table public.screen_sessions is
  '033: public developmental check-in sessions. No identifiable data; unsaved rows are deleted after 30 days.';

create index screen_sessions_saved_child_idx on public.screen_sessions (saved_child_id, created_at desc)
  where saved_child_id is not null;
create index screen_sessions_unsaved_created_idx on public.screen_sessions (created_at)
  where saved_child_id is null;

alter table public.screen_sessions enable row level security;
revoke all on public.screen_sessions from anon, authenticated;
revoke all on function public.screen_answers_valid(jsonb) from public, anon, authenticated;
grant execute on function public.screen_answers_valid(jsonb) to service_role;
