-- 017: organisations, roles, legacy-case backfill and tenant-scoped RLS.
-- Expand -> backfill -> enforce. Legacy cases move to an explicit bootstrap organisation; no guardian
-- ownership or consent is inferred from contact details.

-- ---------- expand ----------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  kind text not null check (kind in ('centre', 'solo')),
  city text check (char_length(city) <= 80),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_role text not null check (org_role in ('owner', 'admin', 'member')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id) where status = 'active';

create table public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (char_length(email) between 3 and 254),
  org_role text not null check (org_role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index org_invitations_org_idx on public.org_invitations (org_id);

alter table public.cases add column org_id uuid references public.organizations(id) on delete restrict;
alter table public.cases add column created_by uuid references auth.users(id) on delete set null;
alter table public.audit_events add column actor_user_id uuid;

-- Roles: admin -> platform_admin, therapist -> provider, new guardian role.
alter table public.user_profiles drop constraint if exists user_profiles_role_check;
alter table public.user_profiles alter column role set default 'provider';

-- ---------- backfill ----------
insert into public.organizations (id, name, slug, kind)
values ('00000000-0000-4000-8000-00000000a001', 'Pilot centre (migrated)', 'pilot-centre', 'centre')
on conflict (id) do nothing;

-- Every pre-existing account keeps access to the legacy cases it could already see.
insert into public.org_members (org_id, user_id, org_role)
select '00000000-0000-4000-8000-00000000a001', id, case when role = 'admin' then 'owner' else 'member' end
from public.user_profiles
on conflict (org_id, user_id) do nothing;

update public.user_profiles set role = 'platform_admin' where role = 'admin';
update public.user_profiles set role = 'provider' where role = 'therapist';

update public.cases set org_id = '00000000-0000-4000-8000-00000000a001' where org_id is null;

-- ---------- enforce ----------
alter table public.user_profiles
  add constraint user_profiles_role_check check (role in ('platform_admin', 'provider', 'guardian'));
alter table public.cases alter column org_id set not null;
create index cases_org_idx on public.cases (org_id, created_at desc);

create or replace function public.is_carethread_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles where id = (select auth.uid()) and role = 'platform_admin'
  );
$$;

-- Account creation is admin-only until ticket 019; the role comes from server-set app metadata.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested text := new.raw_app_meta_data ->> 'role';
begin
  insert into public.user_profiles (id, role)
  values (new.id, case when requested in ('provider', 'platform_admin') then requested else 'provider' end)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members
    where org_id = target_org and user_id = (select auth.uid()) and status = 'active'
  );
$$;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

-- RLS for future browser/Realtime reads. The server's service-role client still enforces access in
-- lib/authz.ts; there are no client write policies.
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.org_invitations enable row level security;

grant select on public.organizations, public.org_members, public.cases to authenticated;

create policy "Members read their organisations" on public.organizations
for select to authenticated using ((select public.is_org_member(id)));

create policy "Members read their organisation's memberships" on public.org_members
for select to authenticated using (user_id = (select auth.uid()) or (select public.is_org_member(org_id)));

create policy "Members read their organisation's cases" on public.cases
for select to authenticated using ((select public.is_org_member(org_id)));

-- ---------- onboarding operations (service role only; each is one transaction) ----------

create or replace function public.create_organization(
  org_name text, org_slug text, org_kind text, org_city text, creator uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  insert into public.organizations (name, slug, kind, city, created_by)
  values (org_name, org_slug, org_kind, org_city, creator)
  returning id into new_id;
  insert into public.org_members (org_id, user_id, org_role) values (new_id, creator, 'owner');
  return new_id;
end;
$$;

-- Single-use: the invitation row is locked, so two concurrent accepts cannot both succeed.
create or replace function public.accept_org_invitation(invite_hash text, accepting_user uuid, accepting_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.org_invitations%rowtype;
begin
  select * into inv from public.org_invitations where token_hash = invite_hash for update;
  if not found or inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= now() then
    return jsonb_build_object('result', 'invalid');
  end if;
  if lower(inv.email) <> lower(coalesce(accepting_email, '')) then
    return jsonb_build_object('result', 'wrong_email');
  end if;

  insert into public.org_members (org_id, user_id, org_role, status)
  values (inv.org_id, accepting_user, inv.org_role, 'active')
  on conflict (org_id, user_id) do update
    set status = 'active',
        revoked_at = null,
        -- A re-invited active owner/admin keeps the higher role.
        org_role = case
          when public.org_members.status = 'active' and public.org_members.org_role = 'owner' then 'owner'
          when public.org_members.status = 'active' and public.org_members.org_role = 'admin' then 'admin'
          else excluded.org_role
        end;

  update public.user_profiles set role = 'provider' where id = accepting_user and role = 'guardian';
  update public.org_invitations set accepted_at = now(), accepted_by = accepting_user where id = inv.id;
  return jsonb_build_object('result', 'accepted', 'org_id', inv.org_id);
end;
$$;

-- The organisation row is locked so two concurrent revocations cannot remove the last owner.
create or replace function public.revoke_org_member(target_org uuid, target_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_role text;
begin
  perform 1 from public.organizations where id = target_org for update;
  select org_role into member_role from public.org_members
  where org_id = target_org and user_id = target_user and status = 'active';
  if member_role is null then
    return 'not_found';
  end if;
  if member_role = 'owner' and (
    select count(*) from public.org_members
    where org_id = target_org and org_role = 'owner' and status = 'active'
  ) <= 1 then
    return 'last_owner';
  end if;
  update public.org_members set status = 'revoked', revoked_at = now()
  where org_id = target_org and user_id = target_user;
  return 'revoked';
end;
$$;

revoke all on function public.create_organization(text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.accept_org_invitation(text, uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_org_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_organization(text, text, text, text, uuid) to service_role;
grant execute on function public.accept_org_invitation(text, uuid, text) to service_role;
grant execute on function public.revoke_org_member(uuid, uuid) to service_role;
