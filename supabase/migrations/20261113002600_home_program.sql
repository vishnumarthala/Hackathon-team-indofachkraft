-- Ticket 026: home program. Providers prescribe a short list of activities (linked to IEP goals of the case's active
-- plan, 025) and publish it to the guardian; guardians log `Done today` with a difficulty rating; providers see
-- adherence. Publishing renders the program to markdown and stores it with publish_version() (published_versions,
-- entity_type 'home_program', visible to the guardian) plus a structured activity snapshot (home_program_publications).
-- Guardians only ever see the latest published snapshot of the case's current published program (NFR-2).
-- Writes go through lib/home-program (one transaction each, audit in the same transaction); the browser roles only
-- read through RLS (care team). New tables only, so there is nothing to backfill.

create table if not exists public.home_programs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  child_id uuid not null references public.children(id),
  org_id uuid not null references public.organizations(id),
  plan_id uuid references public.iep_plans(id) on delete set null,
  title text not null check (char_length(title) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  version int not null default 1 check (version >= 1), -- optimistic concurrency; bumped by every program/activity edit
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists home_programs_case_idx on public.home_programs (case_id, created_at desc);
create index if not exists home_programs_child_idx on public.home_programs (child_id, org_id);
-- One published program per case (publishing another archives it).
create unique index if not exists home_programs_one_published_per_case on public.home_programs (case_id) where status = 'published';

-- child_id and org_id always equal the case's; a linked IEP plan must belong to the same case.
create or replace function public.home_programs_match_case()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
  v_child uuid;
begin
  select c.org_id, c.child_id into v_org, v_child from public.cases c where c.id = new.case_id;
  if not found then
    raise exception 'case not found' using errcode = '23503';
  end if;
  if v_child is null then
    raise exception 'case has no child' using errcode = '23502';
  end if;
  if new.plan_id is not null
     and not exists (select 1 from public.iep_plans p where p.id = new.plan_id and p.case_id = new.case_id) then
    raise exception 'plan belongs to another case' using errcode = '23514';
  end if;
  new.org_id := v_org;
  new.child_id := v_child;
  return new;
end;
$$;
drop trigger if exists home_programs_match_case on public.home_programs;
create trigger home_programs_match_case before insert or update of case_id, plan_id on public.home_programs
for each row execute function public.home_programs_match_case();

create table if not exists public.home_activities (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.home_programs(id) on delete cascade,
  goal_id uuid references public.iep_goals(id) on delete set null,
  title text not null check (char_length(title) between 1 and 120),
  instructions_md text not null check (char_length(instructions_md) between 1 and 4000),
  frequency_per_week int not null check (frequency_per_week between 1 and 14),
  duration_min int not null check (duration_min between 1 and 120),
  materials text check (char_length(materials) <= 500),
  document_id uuid references public.documents(id) on delete set null, -- picture/PDF guide from the vault (023)
  sort int not null default 0,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists home_activities_program_idx on public.home_activities (program_id, sort, created_at);

-- At most 15 active activities per program (lib/home-program also checks this under the program row lock).
create or replace function public.home_activities_check_active_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.active and (
    select count(*) from public.home_activities a
    where a.program_id = new.program_id and a.active and a.id <> new.id
  ) >= 15 then
    raise exception 'a home program can have at most 15 active activities' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists home_activities_check_active_limit on public.home_activities;
create trigger home_activities_check_active_limit before insert or update of active, program_id on public.home_activities
for each row execute function public.home_activities_check_active_limit();

create table if not exists public.home_activity_logs (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.home_activities(id) on delete cascade,
  child_id uuid not null references public.children(id),
  logged_by uuid references auth.users(id) on delete set null, -- the guardian
  done_on date not null,
  duration_min int check (duration_min between 1 and 240),
  difficulty text not null check (difficulty in ('hard', 'okay', 'easy')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- D-3: one log per activity, day and guardian; the API upserts on it (offline-safe retries).
  constraint home_activity_logs_one_per_day unique (activity_id, done_on, logged_by)
);
create index if not exists home_activity_logs_activity_idx on public.home_activity_logs (activity_id, done_on);
create index if not exists home_activity_logs_child_idx on public.home_activity_logs (child_id, done_on);

-- child_id always equals the program's child.
create or replace function public.home_activity_logs_match_child()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_child uuid;
begin
  select p.child_id into v_child
  from public.home_activities a join public.home_programs p on p.id = a.program_id
  where a.id = new.activity_id;
  if not found then
    raise exception 'activity not found' using errcode = '23503';
  end if;
  new.child_id := v_child;
  return new;
end;
$$;
drop trigger if exists home_activity_logs_match_child on public.home_activity_logs;
create trigger home_activity_logs_match_child before insert or update of activity_id, child_id on public.home_activity_logs
for each row execute function public.home_activity_logs_match_child();

-- A case re-pointed to another child (020 claim_child merge) takes its programs and their logs along
-- (like 025's iep_plans_child_follow).
create or replace function public.home_programs_child_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.home_programs set child_id = new.child_id
  where case_id = new.id and child_id is distinct from new.child_id;
  update public.home_activity_logs l set child_id = new.child_id
  from public.home_activities a join public.home_programs p on p.id = a.program_id
  where l.activity_id = a.id and p.case_id = new.id and l.child_id is distinct from new.child_id;
  return null;
end;
$$;
revoke all on function public.home_programs_child_follow() from public, anon, authenticated;
drop trigger if exists cases_home_program_child_follow on public.cases;
create trigger cases_home_program_child_follow after update of child_id on public.cases
for each row when (new.child_id is not null and new.child_id is distinct from old.child_id)
execute function public.home_programs_child_follow();

-- What each published version of a program contained, in structured form: the activities (with their published
-- wording and the published wording of their linked goal). Guardian views and logging checks use only this.
create table if not exists public.home_program_publications (
  -- No FK to published_versions: that table keeps its own append-only/truncate guard (024); both rows are written in
  -- the same transaction and both go only with their case (same choice as 025's iep_publications).
  published_version_id uuid primary key,
  program_id uuid not null references public.home_programs(id) on delete cascade,
  program_version int not null,
  title text not null check (char_length(title) between 1 and 120),
  activities jsonb not null check (jsonb_typeof(activities) = 'array'),
  created_at timestamptz not null default now()
);
create index if not exists home_program_publications_program_idx on public.home_program_publications (program_id, created_at desc);

-- RLS (browser reads only; the server uses the service role and the gates in lib/home-program/authz.ts).
-- Care team of the case only: guardians never read drafts directly (NFR-2); they get published snapshots through
-- the server.
alter table public.home_programs enable row level security;
alter table public.home_activities enable row level security;
alter table public.home_activity_logs enable row level security;
alter table public.home_program_publications enable row level security;
revoke all on public.home_programs, public.home_activities, public.home_activity_logs, public.home_program_publications
  from anon, authenticated;
grant select on public.home_programs, public.home_activities, public.home_activity_logs, public.home_program_publications
  to authenticated;

drop policy if exists "Care team reads home programs" on public.home_programs;
create policy "Care team reads home programs" on public.home_programs
  for select to authenticated using ((select public.can_access_case(case_id)));

drop policy if exists "Care team reads home activities" on public.home_activities;
create policy "Care team reads home activities" on public.home_activities
  for select to authenticated using (
    exists (select 1 from public.home_programs p where p.id = home_activities.program_id and public.can_access_case(p.case_id))
  );

drop policy if exists "Care team reads home activity logs" on public.home_activity_logs;
create policy "Care team reads home activity logs" on public.home_activity_logs
  for select to authenticated using (
    exists (
      select 1 from public.home_activities a join public.home_programs p on p.id = a.program_id
      where a.id = home_activity_logs.activity_id and public.can_access_case(p.case_id)
    )
  );

drop policy if exists "Care team reads home program publications" on public.home_program_publications;
create policy "Care team reads home program publications" on public.home_program_publications
  for select to authenticated using (
    exists (select 1 from public.home_programs p where p.id = home_program_publications.program_id and public.can_access_case(p.case_id))
  );
