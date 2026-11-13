-- Ticket 024 Part 2: assessment portal. Providers assign questionnaires (templates over a registered instrument)
-- to a guardian of the case's child; the guardian answers them in the family portal; the provider reviews,
-- scores and optionally shares a published summary (published_versions, entity_type 'assessment').
-- Writes go through lib/assessments (one transaction each, audit in the same transaction); the browser roles
-- only read through RLS.

create table if not exists public.assessment_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade, -- null = global template
  instrument_key text not null references public.clinical_instruments(key),
  title text not null check (char_length(title) between 1 and 120),
  audience text not null check (audience in ('guardian', 'provider')),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- The global parent check-in (fixed id so code, tests and docs can refer to it).
insert into public.assessment_templates (id, org_id, instrument_key, title, audience)
values ('00000000-0000-4000-8024-000000000001', null, 'ISAA_PARENT_CHECKIN', 'Parent developmental check-in', 'guardian')
on conflict (id) do nothing;

create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  child_id uuid not null references public.children(id),
  org_id uuid not null references public.organizations(id),
  template_id uuid not null references public.assessment_templates(id),
  assigned_to uuid not null references auth.users(id) on delete cascade, -- the guardian who answers
  assigned_by uuid references auth.users(id) on delete set null,
  status text not null default 'assigned'
    check (status in ('assigned', 'in_progress', 'submitted', 'reviewed', 'cancelled')),
  due_on date,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  score jsonb,
  reviewer_note text check (char_length(reviewer_note) <= 2000),
  version int not null default 1 check (version >= 1), -- optimistic concurrency for guardian saves
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assessments_submitted_check check (status not in ('submitted', 'reviewed') or submitted_at is not null),
  constraint assessments_reviewed_check check (status <> 'reviewed' or reviewed_at is not null),
  constraint assessments_cancelled_check check (status <> 'cancelled' or cancelled_at is not null)
);
create index if not exists assessments_case_idx on public.assessments (case_id, created_at desc);
create index if not exists assessments_assignee_idx on public.assessments (assigned_to, status);
create index if not exists assessments_child_idx on public.assessments (child_id, org_id);

-- child_id and org_id always equal the case's (they are denormalised for guardian and sharing reads).
create or replace function public.assessments_match_case()
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
  new.org_id := v_org;
  new.child_id := v_child;
  return new;
end;
$$;
drop trigger if exists assessments_match_case on public.assessments;
create trigger assessments_match_case before insert or update of case_id on public.assessments
for each row execute function public.assessments_match_case();

create table if not exists public.assessment_responses (
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  item_id text not null check (char_length(item_id) between 1 and 40),
  value jsonb not null,
  answered_by uuid references auth.users(id) on delete set null,
  answered_at timestamptz not null default now(),
  primary key (assessment_id, item_id)
);

-- RLS (browser reads only; the server uses the service role and the gates in lib/authz.ts).
alter table public.assessment_templates enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_responses enable row level security;
revoke all on public.assessment_templates, public.assessments, public.assessment_responses from anon, authenticated;
grant select on public.assessment_templates, public.assessments, public.assessment_responses to authenticated;

drop policy if exists "Templates: global or own organisation" on public.assessment_templates;
create policy "Templates: global or own organisation" on public.assessment_templates
  for select to authenticated using (
    org_id is null or exists (
      select 1 from public.org_members m
      where m.org_id = assessment_templates.org_id and m.user_id = (select auth.uid()) and m.status = 'active'
    )
  );

drop policy if exists "Assigned guardian and care team read assessments" on public.assessments;
create policy "Assigned guardian and care team read assessments" on public.assessments
  for select to authenticated using (
    (assigned_to = (select auth.uid()) and public.is_child_guardian(child_id)) or public.can_access_case(case_id)
  );

drop policy if exists "Assigned guardian and care team read responses" on public.assessment_responses;
create policy "Assigned guardian and care team read responses" on public.assessment_responses
  for select to authenticated using (
    exists (
      select 1 from public.assessments a
      where a.id = assessment_responses.assessment_id
        and ((a.assigned_to = (select auth.uid()) and public.is_child_guardian(a.child_id)) or public.can_access_case(a.case_id))
    )
  );
