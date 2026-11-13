-- Ticket 025: IEP plans, SMART goals and progress tracking.
-- Providers write a plan per case (care episode) with SMART goals by developmental domain and record progress
-- data points per goal. Publishing renders the plan to markdown and stores it with publish_version()
-- (published_versions, entity_type 'iep_plan', visible to the guardian); guardians and other organisations
-- (share scope `iep`) only ever see published snapshots, plus live progress values (decision D-3).
-- Writes go through lib/iep (one transaction each, audit in the same transaction); the browser roles only read
-- through RLS (care team). New tables only, so there is nothing to backfill.

create table if not exists public.iep_plans (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  child_id uuid not null references public.children(id),
  org_id uuid not null references public.organizations(id),
  title text not null check (char_length(title) between 1 and 120),
  start_date date not null,
  review_date date not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'completed', 'archived')),
  version int not null default 1 check (version >= 1), -- optimistic concurrency (D-4); bumped by every plan/goal edit
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint iep_plans_dates_check check (review_date >= start_date and review_date <= start_date + interval '12 months')
);
create index if not exists iep_plans_case_idx on public.iep_plans (case_id, created_at desc);
create index if not exists iep_plans_child_idx on public.iep_plans (child_id, org_id);
-- At most one active plan per case.
create unique index if not exists iep_plans_one_active_per_case on public.iep_plans (case_id) where status = 'active';

-- child_id and org_id always equal the case's (denormalised for guardian and sharing reads).
create or replace function public.iep_plans_match_case()
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
  new.org_id := v_org;
  new.child_id := v_child;
  return new;
end;
$$;
drop trigger if exists iep_plans_match_case on public.iep_plans;
create trigger iep_plans_match_case before insert or update of case_id on public.iep_plans
for each row execute function public.iep_plans_match_case();

-- A case re-pointed to another child (020 claim_child merge) takes its plans along (like 024's cases_child_follow).
create or replace function public.iep_plans_child_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.iep_plans set child_id = new.child_id
  where case_id = new.id and child_id is distinct from new.child_id;
  return null;
end;
$$;
revoke all on function public.iep_plans_child_follow() from public, anon, authenticated;
drop trigger if exists cases_iep_child_follow on public.cases;
create trigger cases_iep_child_follow after update of child_id on public.cases
for each row when (new.child_id is not null and new.child_id is distinct from old.child_id)
execute function public.iep_plans_child_follow();

-- Value range by measure type (FR-2), shared by goals and progress.
create or replace function public.iep_value_in_range(p_measure text, p_value numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_measure
    when 'percent' then p_value between 0 and 100
    when 'rating_1_5' then p_value between 1 and 5
    when 'yes_no' then p_value in (0, 1)
    when 'count' then p_value >= 0
    else false
  end
$$;

create table if not exists public.iep_goals (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.iep_plans(id) on delete cascade,
  domain text not null check (domain in ('communication', 'social', 'behaviour', 'fine_motor', 'gross_motor',
    'self_care', 'cognitive', 'sensory', 'academic')),
  statement text not null check (char_length(statement) between 10 and 500),
  specific text not null check (char_length(specific) between 3 and 300),
  measurable text not null check (char_length(measurable) between 3 and 300),
  achievable text not null check (char_length(achievable) between 3 and 300),
  relevant text not null check (char_length(relevant) between 3 and 300),
  time_bound text not null check (char_length(time_bound) between 3 and 300),
  measure_type text not null check (measure_type in ('percent', 'count', 'rating_1_5', 'yes_no')),
  baseline_value numeric not null,
  target_value numeric not null,
  target_date date not null,
  status text not null default 'active' check (status in ('active', 'achieved', 'discontinued')),
  sort int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint iep_goals_baseline_range check (public.iep_value_in_range(measure_type, baseline_value)),
  constraint iep_goals_target_range check (public.iep_value_in_range(measure_type, target_value))
);
create index if not exists iep_goals_plan_idx on public.iep_goals (plan_id, sort);

create table if not exists public.goal_progress (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.iep_goals(id) on delete cascade,
  recorded_by uuid references auth.users(id) on delete set null,
  observed_on date not null,
  value numeric not null,
  note text check (char_length(note) <= 500),
  source text not null default 'manual' check (source in ('manual', 'ai_suggested_confirmed')),
  recording_id uuid references public.recordings(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists goal_progress_goal_idx on public.goal_progress (goal_id, observed_on, created_at);

-- Progress values must fit the goal's measure type (also checked by lib/iep/schema.ts).
create or replace function public.goal_progress_check_value()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_measure text;
begin
  select g.measure_type into v_measure from public.iep_goals g where g.id = new.goal_id;
  if not found then
    raise exception 'goal not found' using errcode = '23503';
  end if;
  if not public.iep_value_in_range(v_measure, new.value) then
    raise exception 'value out of range for %', v_measure using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists goal_progress_check_value on public.goal_progress;
create trigger goal_progress_check_value before insert or update of value, goal_id on public.goal_progress
for each row execute function public.goal_progress_check_value();

-- What each published version of a plan contained, in structured form: the goals (with their published wording)
-- the guardian's progress charts are drawn for. Written in the publishing transaction next to publish_version().
-- Live goal rows may hold unpublished edits, so guardian/sharing reads take goal text from here, never from iep_goals.
create table if not exists public.iep_publications (
  -- No FK to published_versions: that table stays append-only with its own truncate/delete guard (024); both rows
  -- are written in the same transaction and both go only with their case.
  published_version_id uuid primary key,
  plan_id uuid not null references public.iep_plans(id) on delete cascade,
  plan_version int not null,
  title text not null check (char_length(title) between 1 and 120), -- the published title (live title may be edited)
  goals jsonb not null check (jsonb_typeof(goals) = 'array'),
  created_at timestamptz not null default now()
);
create index if not exists iep_publications_plan_idx on public.iep_publications (plan_id);

-- RLS (browser reads only; the server uses the service role and the gates in lib/authz.ts).
-- Care team of the case only: guardians never read drafts (NFR-1); they get published snapshots through the server.
alter table public.iep_plans enable row level security;
alter table public.iep_goals enable row level security;
alter table public.goal_progress enable row level security;
alter table public.iep_publications enable row level security;
revoke all on public.iep_plans, public.iep_goals, public.goal_progress, public.iep_publications from anon, authenticated;
grant select on public.iep_plans, public.iep_goals, public.goal_progress, public.iep_publications to authenticated;

drop policy if exists "Care team reads plans" on public.iep_plans;
create policy "Care team reads plans" on public.iep_plans
  for select to authenticated using ((select public.can_access_case(case_id)));

drop policy if exists "Care team reads goals" on public.iep_goals;
create policy "Care team reads goals" on public.iep_goals
  for select to authenticated using (
    exists (select 1 from public.iep_plans p where p.id = iep_goals.plan_id and public.can_access_case(p.case_id))
  );

drop policy if exists "Care team reads progress" on public.goal_progress;
create policy "Care team reads progress" on public.goal_progress
  for select to authenticated using (
    exists (
      select 1 from public.iep_goals g join public.iep_plans p on p.id = g.plan_id
      where g.id = goal_progress.goal_id and public.can_access_case(p.case_id)
    )
  );

drop policy if exists "Care team reads publications" on public.iep_publications;
create policy "Care team reads publications" on public.iep_publications
  for select to authenticated using (
    exists (select 1 from public.iep_plans p where p.id = iep_publications.plan_id and public.can_access_case(p.case_id))
  );
