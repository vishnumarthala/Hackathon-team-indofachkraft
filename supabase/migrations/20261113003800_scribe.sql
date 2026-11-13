-- Ticket 038: AI scribe for any provider type.
-- Generalises the session pipeline (upload -> ElevenLabs Scribe v2 -> Gemini) from ISAA-only to a scribe that drafts a
-- session note, suggests progress on the case's active IEP goals and, for verified prescribers, an Rx draft (signed by
-- 039). Additive only: legacy recordings keep `kind = 'session'` and get `template = 'child_dev_isaa'` (the unchanged
-- ISAA path); nothing is final until a clinician accepts or finalizes it.

-- ---------------------------------------------------------------------------------------------------------
-- 1. recordings: `consult` kind, template, uploader, appointment

alter table public.recordings drop constraint if exists recordings_kind_check;
alter table public.recordings
  add constraint recordings_kind_check check (kind in ('intake_call', 'session', 'consult'));

-- Expand -> backfill (column default) -> enforce: every existing row is an ISAA (Child Development) recording.
alter table public.recordings add column if not exists template text not null default 'child_dev_isaa';
alter table public.recordings drop constraint if exists recordings_template_check;
alter table public.recordings
  add constraint recordings_template_check
  check (template in ('child_dev_isaa', 'therapy_session_note', 'medical_consult_note'));
-- A medical consult is recorded as `consult`; every other template is a `session` (or a legacy intake call).
alter table public.recordings drop constraint if exists recordings_template_kind_check;
alter table public.recordings
  add constraint recordings_template_kind_check
  check ((kind = 'consult') = (template = 'medical_consult_note'));

-- Who uploaded the recording: the Rx draft is only produced when this provider can prescribe (028).
alter table public.recordings add column if not exists uploaded_by uuid references auth.users(id) on delete set null;
-- 035 owns appointment-scoped recordings; 030 (appointments) is not merged yet, so no FK here. The scribe checks the
-- appointment (same org/child, not a video consult) in lib/scribe/appointments.ts; 035 adds the FK.
alter table public.recordings add column if not exists appointment_id uuid;
create index if not exists recordings_appointment_idx on public.recordings (appointment_id) where appointment_id is not null;

comment on column public.recordings.template is
  '038: scribe template (lib/scribe/templates.ts). child_dev_isaa = the unchanged ISAA extraction (006).';

-- ---------------------------------------------------------------------------------------------------------
-- 2. reports: session_note and rx_draft (024 reserved kinds, lib/clinical/reports.ts)

alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports
  add constraint reports_kind_check
  check (kind in ('pre_session_brief', 'assessment', 'parent_summary', 'session_note', 'rx_draft'));

-- Session notes are published by the scribe finalize step itself (lib/scribe/notes.ts finalizeSessionNote calls
-- publishVersion with the clinician's `visible_to_guardian` choice, in the same transaction). Rx drafts are never
-- published (039 signs prescriptions). The 024 trigger keeps publishing every other kind exactly as before.
create or replace function public.reports_publish_final()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('session_note', 'rx_draft') then
    return null;
  end if;
  if new.status = 'final'
     and (tg_op = 'INSERT' or old.status is distinct from 'final' or old.content_md is distinct from new.content_md) then
    perform public.publish_version(jsonb_build_object(
      'entity_type', 'report',
      'entity_id', new.id,
      'case_id', new.case_id,
      'content_md', new.content_md,
      'visible_to_guardian', new.kind = 'parent_summary'
    ));
  end if;
  return null;
end;
$$;
revoke all on function public.reports_publish_final() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Goal progress suggestions (025 goals): AI suggestions that become goal_progress only when a clinician accepts

create table if not exists public.goal_progress_suggestions (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.recordings(id) on delete cascade,
  -- Copied from the recording by the trigger below (authz and erasure look it up without joins).
  case_id uuid not null references public.cases(id) on delete cascade,
  goal_id uuid not null references public.iep_goals(id) on delete cascade,
  suggested_value numeric not null,
  -- [{ segment_id, quote, start_sec, end_sec, verified }]
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  rationale text not null default '' check (char_length(rationale) <= 1000),
  status text not null default 'suggested' check (status in ('suggested', 'accepted', 'rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  -- The value actually recorded on accept (`Edit value` may change the suggestion).
  decided_value numeric,
  progress_id uuid references public.goal_progress(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (recording_id, goal_id),
  constraint goal_progress_suggestions_decision check ((status = 'suggested') = (decided_at is null))
);
create index if not exists goal_progress_suggestions_case_idx on public.goal_progress_suggestions (case_id);
create index if not exists goal_progress_suggestions_goal_idx on public.goal_progress_suggestions (goal_id);

comment on table public.goal_progress_suggestions is
  '038: AI-suggested progress on IEP goals from a session recording. Accepting one creates goal_progress (source ai_suggested_confirmed).';

-- case_id always comes from the recording, and the goal must belong to a plan of that same case.
create or replace function public.goal_progress_suggestions_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select r.case_id into new.case_id from public.recordings r where r.id = new.recording_id;
  if new.case_id is null then
    raise exception 'recording not found' using errcode = '23503';
  end if;
  if not exists (
    select 1 from public.iep_goals g join public.iep_plans p on p.id = g.plan_id
    where g.id = new.goal_id and p.case_id = new.case_id
  ) then
    raise exception 'goal does not belong to the case of the recording' using errcode = '23514';
  end if;
  if not public.iep_value_in_range((select g.measure_type from public.iep_goals g where g.id = new.goal_id), new.suggested_value) then
    raise exception 'suggested value out of range' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.goal_progress_suggestions_check() from public, anon, authenticated;

drop trigger if exists goal_progress_suggestions_check on public.goal_progress_suggestions;
create trigger goal_progress_suggestions_check
before insert or update of recording_id, goal_id, suggested_value on public.goal_progress_suggestions
for each row execute function public.goal_progress_suggestions_check();

-- RLS: browser reads for the care team only; the server uses the service role and lib/authz.ts gates.
alter table public.goal_progress_suggestions enable row level security;
revoke all on public.goal_progress_suggestions from anon, authenticated;
grant select on public.goal_progress_suggestions to authenticated;
drop policy if exists "Care team reads goal suggestions" on public.goal_progress_suggestions;
create policy "Care team reads goal suggestions" on public.goal_progress_suggestions
  for select to authenticated using (public.can_access_case(case_id));
