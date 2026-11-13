-- Ticket 039: e-prescriptions for verified prescribers (design rule 9).
-- A prescription belongs to a case (and so to an organisation and a child). Its content lives in
-- prescription_versions: the draft is the current version row while `signed_at` is null; signing fills in the
-- snapshots (child, allergies, prescriber), the authoritative `content_md` + sha256 and the PDF path, after which the
-- row is immutable (trigger). Voiding a signed prescription needs a reason and creates no new version.
-- Writes go through lib/rx (one transaction each; signing re-checks provider_can_prescribe (028) in TypeScript AND in
-- the trigger below, publishes through 024 publish_version and writes the strict audit row `rx.signed` (041)).
-- New tables only: nothing to backfill.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prescriptions', 'prescriptions', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  child_id uuid not null references public.children(id),
  org_id uuid not null references public.organizations(id),
  -- 030 owns appointments; no FK here (like 038's recordings.appointment_id).
  appointment_id uuid,
  -- The prescriber responsible: the creator, replaced by the signer at signing.
  prescriber_profile_id uuid not null references public.provider_profiles(id),
  -- The 038 AI draft (reports.kind = 'rx_draft') this prescription started from, if any.
  source_report_id uuid references public.reports(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'signed', 'void')),
  -- prescription_versions.version currently in effect (the draft while `draft`, the signed one afterwards).
  current_version int not null default 1 check (current_version >= 1),
  -- Optimistic concurrency for edits (PATCH sends it back; stale -> 409). Bumped by every write.
  version int not null default 1 check (version >= 1),
  void_reason text check (char_length(void_reason) between 1 and 500),
  voided_by uuid references auth.users(id) on delete set null,
  voided_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prescriptions_void_needs_reason check (status <> 'void' or (void_reason is not null and voided_at is not null))
);
create index if not exists prescriptions_case_idx on public.prescriptions (case_id, created_at desc);
create index if not exists prescriptions_child_idx on public.prescriptions (child_id, status);
create index if not exists prescriptions_source_idx on public.prescriptions (source_report_id) where source_report_id is not null;

create table if not exists public.prescription_versions (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references public.prescriptions(id) on delete cascade,
  version int not null check (version >= 1),
  -- FR-2 items: [{ drug, strength, form, dose, frequency, duration_days, route, instructions }], at most 15.
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 15),
  advice text check (char_length(advice) <= 2000),
  follow_up text check (char_length(follow_up) <= 300),
  -- Filled in at signing (all null while the version is a draft).
  allergies_snapshot jsonb,
  child_snapshot jsonb,
  prescriber_snapshot jsonb,
  content_md text,
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  pdf_path text check (char_length(pdf_path) <= 300),
  -- Rule 9: the signer is kept (no `set null`): an account that signed prescriptions cannot be deleted silently.
  signed_by uuid references auth.users(id),
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prescription_id, version),
  constraint prescription_versions_signed_complete check (
    signed_at is null or (
      signed_by is not null and content_md is not null and content_hash is not null and pdf_path is not null
      and allergies_snapshot is not null and child_snapshot is not null and prescriber_snapshot is not null
      and jsonb_array_length(items) >= 1
    )
  )
);

-- child_id and org_id always equal the case's; case and prescriber never move; status only goes forward
-- (draft -> signed -> void); a voided prescription is frozen (child_id may still follow a 020 claim merge).
create or replace function public.prescriptions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
  v_child uuid;
begin
  if tg_op = 'DELETE' then
    -- Signed/void prescriptions go only with their case (cascade: the case row is already gone).
    if old.status <> 'draft' and exists (select 1 from public.cases where id = old.case_id)
       and coalesce(current_setting('dnm.privacy_maintenance', true), '') <> 'on' then
      raise exception 'signed prescriptions cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  select c.org_id, c.child_id into v_org, v_child from public.cases c where c.id = new.case_id;
  if not found then
    -- The case is being deleted (cascades may set source_report_id null first): the row goes with it.
    if tg_op = 'UPDATE' then
      return new;
    end if;
    raise exception 'case not found' using errcode = '23503';
  end if;
  if v_child is null then
    raise exception 'case has no child' using errcode = '23502';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a prescription starts as a draft' using errcode = '23514';
    end if;
    new.org_id := v_org;
    new.child_id := v_child;
    return new;
  end if;
  -- created_by / voided_by / source_report_id may only become null (account or AI draft deleted).
  if new.case_id <> old.case_id
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or (new.source_report_id is distinct from old.source_report_id and new.source_report_id is not null) then
    raise exception 'prescription case and origin cannot change' using errcode = '42501';
  end if;
  if old.status = 'void' then
    if (to_jsonb(new) - 'child_id' - 'updated_at' - 'source_report_id' - 'created_by' - 'voided_by')
       <> (to_jsonb(old) - 'child_id' - 'updated_at' - 'source_report_id' - 'created_by' - 'voided_by')
       or (new.voided_by is distinct from old.voided_by and new.voided_by is not null) then
      raise exception 'a void prescription cannot change' using errcode = '42501';
    end if;
  elsif old.status = 'signed' then
    if new.status not in ('signed', 'void')
       or new.prescriber_profile_id <> old.prescriber_profile_id
       or new.current_version <> old.current_version
       or new.appointment_id is distinct from old.appointment_id then
      raise exception 'a signed prescription cannot change' using errcode = '42501';
    end if;
  elsif new.status = 'void' then
    raise exception 'only a signed prescription can be voided' using errcode = '23514';
  end if;
  new.org_id := v_org;
  new.child_id := v_child;
  return new;
end;
$$;
drop trigger if exists prescriptions_guard on public.prescriptions;
create trigger prescriptions_guard before insert or update or delete on public.prescriptions
for each row execute function public.prescriptions_guard();

-- FR-1: a signed version is immutable (update/delete raise; it goes only with its prescription/case). Signing a draft
-- is the one update that sets signed_at, and it re-checks the prescriber rule (028) in the database too (NFR-1): the
-- signer must own a provider profile that can prescribe.
create or replace function public.prescription_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.signed_at is not null and exists (select 1 from public.prescriptions where id = old.prescription_id) then
      raise exception 'signed prescription versions are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.signed_at is not null then
      raise exception 'signed prescription versions are immutable' using errcode = '42501';
    end if;
    if new.prescription_id <> old.prescription_id or new.version <> old.version then
      raise exception 'prescription version identity cannot change' using errcode = '42501';
    end if;
  end if;
  if new.signed_at is not null then
    if not exists (
      select 1 from public.provider_profiles pp
      where pp.user_id = new.signed_by and public.provider_can_prescribe(pp.id)
    ) then
      raise exception 'only verified prescribers can sign prescriptions' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists prescription_versions_guard on public.prescription_versions;
create trigger prescription_versions_guard before insert or update or delete on public.prescription_versions
for each row execute function public.prescription_versions_guard();

create or replace function public.prescription_versions_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'prescription_versions cannot be truncated' using errcode = '42501';
end;
$$;
drop trigger if exists prescription_versions_no_truncate on public.prescription_versions;
create trigger prescription_versions_no_truncate before truncate on public.prescription_versions
for each statement execute function public.prescription_versions_no_truncate();

-- A case re-pointed to another child (020 claim_child merge) takes its prescriptions along (like 026).
create or replace function public.prescriptions_child_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.prescriptions set child_id = new.child_id
  where case_id = new.id and child_id is distinct from new.child_id;
  return null;
end;
$$;
revoke all on function public.prescriptions_child_follow() from public, anon, authenticated;
drop trigger if exists cases_prescriptions_child_follow on public.cases;
create trigger cases_prescriptions_child_follow after update of child_id on public.cases
for each row when (new.child_id is not null and new.child_id is distinct from old.child_id)
execute function public.prescriptions_child_follow();

-- RLS (browser reads only; the server uses the service role and the gates in lib/rx/authz.ts). Care team of the case
-- only; guardians read signed prescriptions through the server (published versions + PDF route).
alter table public.prescriptions enable row level security;
alter table public.prescription_versions enable row level security;
revoke all on public.prescriptions, public.prescription_versions from anon, authenticated;
grant select on public.prescriptions, public.prescription_versions to authenticated;

drop policy if exists "Care team reads prescriptions" on public.prescriptions;
create policy "Care team reads prescriptions" on public.prescriptions
  for select to authenticated using ((select public.can_access_case(case_id)));

drop policy if exists "Care team reads prescription versions" on public.prescription_versions;
create policy "Care team reads prescription versions" on public.prescription_versions
  for select to authenticated using (
    exists (select 1 from public.prescriptions p where p.id = prescription_versions.prescription_id and public.can_access_case(p.case_id))
  );
