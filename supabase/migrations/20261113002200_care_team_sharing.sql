-- 022: care team (case assignments) and cross-organisation sharing grants (design rules 2 and 3).
-- Expand -> backfill -> enforce. Org owners/admins reach every case of their organisation; members reach only
-- the cases they are assigned to. Records of one organisation reach another only through a guardian's
-- explicit, scoped, read-only, revocable sharing grant. Every multi-step write is a security-definer function
-- (one transaction, strict audit: if the audit insert fails, nothing is written).

-- =====================================================================================================
-- expand
-- =====================================================================================================

create table if not exists public.case_assignments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  care_role text not null default 'member' check (care_role in ('lead', 'member')),
  discipline_label text check (char_length(discipline_label) between 1 and 60),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references auth.users(id) on delete set null
);
create unique index if not exists case_assignments_active_uq
  on public.case_assignments (case_id, user_id) where removed_at is null;
create unique index if not exists case_assignments_one_lead_uq
  on public.case_assignments (case_id) where removed_at is null and care_role = 'lead';
create index if not exists case_assignments_user_idx
  on public.case_assignments (user_id, case_id) where removed_at is null;

create table if not exists public.sharing_grants (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  source_org_id uuid not null references public.organizations(id) on delete cascade,
  grantee_org_id uuid not null references public.organizations(id) on delete cascade,
  scopes text[] not null check (
    cardinality(scopes) >= 1
    and scopes <@ array['reports', 'assessments', 'iep', 'home_program', 'documents', 'health_profile']::text[]
  ),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  constraint sharing_grants_distinct_orgs check (source_org_id <> grantee_org_id),
  constraint sharing_grants_expiry_check check (expires_at is null or expires_at > created_at)
);
create index if not exists sharing_grants_child_idx
  on public.sharing_grants (child_id, grantee_org_id) where revoked_at is null;

-- =====================================================================================================
-- access rules (FR-2). One definition used by the server (lib/authz.ts) and by RLS.
-- =====================================================================================================

-- 'manage' = active owner/admin of the case's org; 'assigned' = active member with an active assignment;
-- null = no access (not a member, revoked membership, unassigned member, removed assignment, platform admin
-- without membership).
create or replace function public.case_access_level(p_user uuid, p_case uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when m.org_role in ('owner', 'admin') then 'manage'
    when exists (
      select 1 from public.case_assignments a
      where a.case_id = c.id and a.user_id = p_user and a.removed_at is null
    ) then 'assigned'
  end
  from public.cases c
  join public.org_members m on m.org_id = c.org_id and m.user_id = p_user and m.status = 'active'
  where c.id = p_case;
$$;

-- Owners/admins and the case lead (while still an active member) manage the care team.
create or replace function public.can_manage_case_team(p_user uuid, p_case uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.case_access_level(p_user, p_case) = 'manage', false)
    or exists (
      select 1 from public.case_assignments a
      join public.cases c on c.id = a.case_id
      join public.org_members m on m.org_id = c.org_id and m.user_id = a.user_id and m.status = 'active'
      where a.case_id = p_case and a.user_id = p_user and a.removed_at is null and a.care_role = 'lead'
    );
$$;

-- NFR-1: the /dashboard case list, filtered in SQL by the same rule.
create or replace function public.accessible_cases(p_user uuid)
returns setof public.cases
language sql
stable
security definer
set search_path = ''
as $$
  select c.*
  from public.cases c
  join public.org_members m on m.org_id = c.org_id and m.user_id = p_user and m.status = 'active'
  where m.org_role in ('owner', 'admin')
     or exists (
       select 1 from public.case_assignments a
       where a.case_id = c.id and a.user_id = p_user and a.removed_at is null
     )
  order by c.created_at desc;
$$;

-- Grants that currently give p_user read access to p_child's records under p_scope: unrevoked, unexpired,
-- the granting guardian still linked to a live child, and p_user can access a case of the child in the
-- grantee org. p_grantee narrows to one grantee org (the case workspace's org).
create or replace function public.active_sharing_grants(p_user uuid, p_child uuid, p_scope text, p_grantee uuid default null)
returns table (grant_id uuid, source_org_id uuid, grantee_org_id uuid, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.source_org_id, g.grantee_org_id, g.expires_at
  from public.sharing_grants g
  join public.children ch on ch.id = g.child_id and ch.deleted_at is null
  where g.child_id = p_child
    and p_scope = any (g.scopes)
    and g.revoked_at is null
    and (g.expires_at is null or g.expires_at > now())
    and (p_grantee is null or g.grantee_org_id = p_grantee)
    and exists (
      select 1 from public.guardian_links gl
      where gl.child_id = g.child_id and gl.user_id = g.granted_by and gl.status = 'active'
    )
    and exists (
      select 1 from public.cases c
      where c.child_id = g.child_id and c.org_id = g.grantee_org_id
        and public.case_access_level(p_user, c.id) is not null
    )
  order by g.created_at;
$$;

-- RLS helper for the signed-in user.
create or replace function public.can_access_case(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.case_access_level((select auth.uid()), target) is not null;
$$;

-- 020's helper now follows the same rule: a provider reads a child through a case they can access.
create or replace function public.can_read_child_via_org(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cases c
    where c.child_id = target and public.case_access_level((select auth.uid()), c.id) is not null
  );
$$;

revoke all on function public.case_access_level(uuid, uuid) from public, anon, authenticated;
revoke all on function public.can_manage_case_team(uuid, uuid) from public, anon, authenticated;
revoke all on function public.accessible_cases(uuid) from public, anon, authenticated;
revoke all on function public.active_sharing_grants(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.can_access_case(uuid) from public;
grant execute on function public.case_access_level(uuid, uuid) to service_role;
grant execute on function public.can_manage_case_team(uuid, uuid) to service_role;
grant execute on function public.accessible_cases(uuid) to service_role;
grant execute on function public.active_sharing_grants(uuid, uuid, text, uuid) to service_role;
grant execute on function public.can_access_case(uuid) to authenticated;

-- =====================================================================================================
-- backfill (idempotent: only cases without an active assignment are touched)
-- =====================================================================================================

-- The case creator (when known and still an active member of the case's org) becomes the lead. Otherwise the
-- org's earliest active owner becomes the lead and the other active owners join as members (one lead per case).
create or replace function public.assign_initial_care_team(p_case uuid, p_action text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
  v_users uuid[] := '{}';
  v_lead uuid;
  r record;
begin
  select * into v_case from public.cases where id = p_case;
  if not found then
    return 0;
  end if;
  if exists (select 1 from public.case_assignments where case_id = p_case and removed_at is null) then
    return 0;
  end if;

  if v_case.created_by is not null and exists (
    select 1 from public.org_members
    where org_id = v_case.org_id and user_id = v_case.created_by and status = 'active'
  ) then
    insert into public.case_assignments (case_id, user_id, care_role, assigned_by)
    values (p_case, v_case.created_by, 'lead', v_case.created_by);
    v_lead := v_case.created_by;
    v_users := array[v_case.created_by];
  else
    for r in
      select user_id from public.org_members
      where org_id = v_case.org_id and org_role = 'owner' and status = 'active'
      order by created_at, user_id
    loop
      insert into public.case_assignments (case_id, user_id, care_role)
      values (p_case, r.user_id, case when v_lead is null then 'lead' else 'member' end);
      v_lead := coalesce(v_lead, r.user_id);
      v_users := v_users || r.user_id;
    end loop;
  end if;

  if cardinality(v_users) = 0 then
    return 0;
  end if;
  insert into public.audit_events (case_id, actor, action, entity, entity_id, details)
  values (p_case, 'system', p_action, 'case', p_case::text,
          jsonb_build_object('lead_user_id', v_lead, 'user_ids', to_jsonb(v_users)));
  return cardinality(v_users);
end;
$$;
revoke all on function public.assign_initial_care_team(uuid, text) from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in
    select c.id from public.cases c
    where not exists (select 1 from public.case_assignments a where a.case_id = c.id and a.removed_at is null)
    order by c.created_at
  loop
    perform public.assign_initial_care_team(r.id, 'case.assignment_backfilled');
  end loop;
end;
$$;

-- =====================================================================================================
-- enforce
-- =====================================================================================================

-- Every new case starts with a care team, so a member who creates a case keeps access to it.
create or replace function public.cases_assign_care_team()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assign_initial_care_team(new.id, 'case.assignment_initial');
  return null;
end;
$$;
revoke all on function public.cases_assign_care_team() from public, anon, authenticated;

drop trigger if exists cases_assign_care_team on public.cases;
create trigger cases_assign_care_team after insert on public.cases
for each row execute function public.cases_assign_care_team();

-- A case can only be without a lead while its org has no active owner (e.g. a fresh local database with the
-- bootstrap org and demo cases but no accounts yet). The first active owner then becomes its lead.
create or replace function public.org_members_adopt_leaderless_cases()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.status <> 'active' or new.org_role <> 'owner' then
    return null;
  end if;
  for r in
    select c.id from public.cases c
    where c.org_id = new.org_id
      and not exists (
        select 1 from public.case_assignments a where a.case_id = c.id and a.care_role = 'lead' and a.removed_at is null
      )
    for update of c
  loop
    update public.case_assignments set care_role = 'lead'
    where case_id = r.id and user_id = new.user_id and removed_at is null;
    if not found then
      insert into public.case_assignments (case_id, user_id, care_role) values (r.id, new.user_id, 'lead');
    end if;
    insert into public.audit_events (case_id, actor, action, entity, entity_id, details)
    values (r.id, 'system', 'case.assignment_backfilled', 'case', r.id::text,
            jsonb_build_object('lead_user_id', new.user_id, 'user_ids', jsonb_build_array(new.user_id), 'reason', 'first_owner'));
  end loop;
  return null;
end;
$$;
revoke all on function public.org_members_adopt_leaderless_cases() from public, anon, authenticated;

drop trigger if exists org_members_adopt_leaderless_cases on public.org_members;
create trigger org_members_adopt_leaderless_cases after insert or update of org_role, status on public.org_members
for each row execute function public.org_members_adopt_leaderless_cases();

-- =====================================================================================================
-- RLS (NFR-2): providers read assignments of cases they can access; guardians read their children's grants.
-- No direct writes from anon/authenticated; the server writes through the functions below.
-- =====================================================================================================

alter table public.case_assignments enable row level security;
alter table public.sharing_grants enable row level security;
revoke all on public.case_assignments, public.sharing_grants from anon, authenticated;
grant select on public.case_assignments, public.sharing_grants to authenticated;

drop policy if exists "Care team reads assignments of accessible cases" on public.case_assignments;
create policy "Care team reads assignments of accessible cases" on public.case_assignments
for select to authenticated using ((select public.can_access_case(case_id)));

drop policy if exists "Guardians read their children's sharing grants" on public.sharing_grants;
create policy "Guardians read their children's sharing grants" on public.sharing_grants
for select to authenticated using ((select public.is_child_guardian(child_id)));

-- Cases follow the refined rule (owners/admins: all org cases; members: assigned cases).
drop policy if exists "Members read their organisation's cases" on public.cases;
drop policy if exists "Care team reads accessible cases" on public.cases;
create policy "Care team reads accessible cases" on public.cases
for select to authenticated using ((select public.can_access_case(id)));

-- =====================================================================================================
-- read models (service role only)
-- =====================================================================================================

-- plpgsql (not sql) because provider_profiles (028) is created by a later-numbered migration.
-- Provider view of a case's care team (active assignments). `member_active` is false once the person left
-- the organisation (they have no access then).
create or replace function public.list_case_team(p_case uuid)
returns table (
  assignment_id uuid, user_id uuid, care_role text, discipline_label text, assigned_at timestamptz,
  display_name text, email text, provider_type text, member_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
    select a.id, a.user_id, a.care_role, a.discipline_label, a.assigned_at,
           coalesce(pp.display_name, up.display_name), u.email::text, pp.provider_type,
           exists (
             select 1 from public.org_members m
             where m.org_id = c.org_id and m.user_id = a.user_id and m.status = 'active'
           )
    from public.case_assignments a
    join public.cases c on c.id = a.case_id
    left join auth.users u on u.id = a.user_id
    left join public.user_profiles up on up.id = a.user_id
    left join public.provider_profiles pp on pp.user_id = a.user_id
    where a.case_id = p_case and a.removed_at is null
    order by (a.care_role = 'lead') desc, a.assigned_at, a.id;
end;
$$;

-- Active members of the case's org who are not on the care team yet (the `Add provider` select).
create or replace function public.list_case_team_candidates(p_case uuid)
returns table (user_id uuid, display_name text, email text, provider_type text, org_role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
    select m.user_id, coalesce(pp.display_name, up.display_name), u.email::text, pp.provider_type, m.org_role
    from public.cases c
    join public.org_members m on m.org_id = c.org_id and m.status = 'active'
    left join auth.users u on u.id = m.user_id
    left join public.user_profiles up on up.id = m.user_id
    left join public.provider_profiles pp on pp.user_id = m.user_id
    where c.id = p_case
      and not exists (
        select 1 from public.case_assignments a
        where a.case_id = c.id and a.user_id = m.user_id and a.removed_at is null
      )
    order by coalesce(pp.display_name, up.display_name, u.email::text);
end;
$$;

-- Guardian view (FR-4): every organisation with a case for the child and its care team. No emails.
create or replace function public.list_child_care_team(p_child uuid)
returns table (
  org_id uuid, org_name text, user_id uuid, display_name text, provider_type text, discipline_label text,
  care_role text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
    with orgs as (
      select distinct o.id, coalesce(o.public_name, o.name) as name
      from public.cases c join public.organizations o on o.id = c.org_id
      where c.child_id = p_child
    ),
    team as (
      select distinct on (c.org_id, a.user_id)
        c.org_id, a.user_id, a.care_role, a.discipline_label,
        coalesce(pp.display_name, up.display_name) as display_name, pp.provider_type
      from public.cases c
      join public.case_assignments a on a.case_id = c.id and a.removed_at is null
      join public.org_members m on m.org_id = c.org_id and m.user_id = a.user_id and m.status = 'active'
      left join public.user_profiles up on up.id = a.user_id
      left join public.provider_profiles pp on pp.user_id = a.user_id
      where c.child_id = p_child
      order by c.org_id, a.user_id, (a.care_role = 'lead') desc, a.assigned_at
    )
    select o.id, o.name, t.user_id, t.display_name, t.provider_type, t.discipline_label, t.care_role
    from orgs o left join team t on t.org_id = o.id
    order by o.name, o.id, (t.care_role = 'lead') desc, t.display_name nulls last;
end;
$$;

revoke all on function public.list_case_team(uuid) from public, anon, authenticated;
revoke all on function public.list_case_team_candidates(uuid) from public, anon, authenticated;
revoke all on function public.list_child_care_team(uuid) from public, anon, authenticated;
grant execute on function public.list_case_team(uuid) to service_role;
grant execute on function public.list_case_team_candidates(uuid) to service_role;
grant execute on function public.list_child_care_team(uuid) to service_role;

-- =====================================================================================================
-- operations (service role only; each call is one transaction with its audit row)
-- =====================================================================================================

-- FR-3. Results: added | not_member | duplicate | case_not_found. Adding a lead hands the lead role over:
-- the current lead stays on the team as a member.
create or replace function public.add_case_assignment(
  p_case uuid, p_user uuid, p_care_role text, p_discipline_label text, p_actor uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
  v_previous_lead uuid;
begin
  select org_id into v_org from public.cases where id = p_case for update;
  if not found then
    return jsonb_build_object('result', 'case_not_found');
  end if;
  if not exists (
    select 1 from public.org_members where org_id = v_org and user_id = p_user and status = 'active'
  ) then
    return jsonb_build_object('result', 'not_member');
  end if;
  if exists (select 1 from public.case_assignments where case_id = p_case and user_id = p_user and removed_at is null) then
    return jsonb_build_object('result', 'duplicate');
  end if;
  if p_care_role = 'lead' then
    update public.case_assignments set care_role = 'member'
    where case_id = p_case and care_role = 'lead' and removed_at is null
    returning id into v_previous_lead;
  end if;
  insert into public.case_assignments (case_id, user_id, care_role, discipline_label, assigned_by)
  values (p_case, p_user, p_care_role, p_discipline_label, p_actor)
  returning id into v_id;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (p_case, 'therapist', p_actor, 'case.assigned', 'case_assignment', v_id::text,
          jsonb_build_object('user_id', p_user, 'care_role', p_care_role, 'discipline_label', p_discipline_label,
                             'previous_lead_assignment_id', v_previous_lead));
  return jsonb_build_object('result', 'added', 'id', v_id);
end;
$$;

-- FR-3. Results: updated | not_found | last_lead. Making someone lead demotes the current lead.
create or replace function public.update_case_assignment(
  p_case uuid, p_assignment uuid, p_care_role text, p_discipline_label text, p_set_label boolean, p_actor uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.case_assignments%rowtype;
  v_role text;
begin
  perform 1 from public.cases where id = p_case for update;
  select * into v_row from public.case_assignments
  where id = p_assignment and case_id = p_case and removed_at is null;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  v_role := coalesce(p_care_role, v_row.care_role);
  if v_row.care_role = 'lead' and v_role <> 'lead' then
    return jsonb_build_object('result', 'last_lead');
  end if;
  if v_role = 'lead' and v_row.care_role <> 'lead' then
    update public.case_assignments set care_role = 'member'
    where case_id = p_case and care_role = 'lead' and removed_at is null;
  end if;
  update public.case_assignments
  set care_role = v_role,
      discipline_label = case when p_set_label then p_discipline_label else discipline_label end
  where id = p_assignment;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (p_case, 'therapist', p_actor, 'case.assignment_updated', 'case_assignment', p_assignment::text,
          jsonb_build_object('user_id', v_row.user_id, 'care_role', v_role,
                             'discipline_label', case when p_set_label then p_discipline_label else v_row.discipline_label end));
  return jsonb_build_object('result', 'updated', 'id', p_assignment);
end;
$$;

-- FR-3. Results: removed | not_found | last_lead. The case row lock serialises concurrent team changes.
create or replace function public.remove_case_assignment(p_case uuid, p_assignment uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.case_assignments%rowtype;
begin
  perform 1 from public.cases where id = p_case for update;
  select * into v_row from public.case_assignments
  where id = p_assignment and case_id = p_case and removed_at is null;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_row.care_role = 'lead' and not exists (
    select 1 from public.case_assignments
    where case_id = p_case and care_role = 'lead' and removed_at is null and id <> p_assignment
  ) then
    return jsonb_build_object('result', 'last_lead');
  end if;
  update public.case_assignments set removed_at = now(), removed_by = p_actor where id = p_assignment;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (p_case, 'therapist', p_actor, 'case.unassigned', 'case_assignment', p_assignment::text,
          jsonb_build_object('user_id', v_row.user_id, 'care_role', v_row.care_role));
  return jsonb_build_object('result', 'removed', 'id', p_assignment, 'user_id', v_row.user_id);
end;
$$;

-- FR-5. Errors are raised as 'sharing:<code>' and mapped to HTTP statuses by lib/sharing/grants.ts.
-- An active grant for the same (child, source, grantee) is replaced (revoked + audited) by the new one.
create or replace function public.create_sharing_grant(
  p_child uuid, p_source uuid, p_grantee uuid, p_scopes text[], p_expires_in_days int, p_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.sharing_grants%rowtype;
  v_old uuid;
begin
  perform pg_advisory_xact_lock(hashtext('sharing_grant:' || p_child::text));
  if not exists (
    select 1 from public.guardian_links gl join public.children ch on ch.id = gl.child_id
    where gl.child_id = p_child and gl.user_id = p_user and gl.status = 'active' and ch.deleted_at is null
  ) then
    raise exception 'sharing:child_not_found';
  end if;
  if p_source = p_grantee then
    raise exception 'sharing:same_org';
  end if;
  if p_expires_in_days is not null and p_expires_in_days not in (90, 365) then
    raise exception 'sharing:invalid';
  end if;
  if not exists (select 1 from public.cases where child_id = p_child and org_id = p_source)
     or not exists (select 1 from public.cases where child_id = p_child and org_id = p_grantee) then
    raise exception 'sharing:no_case';
  end if;

  for v_old in
    update public.sharing_grants set revoked_at = now(), revoked_by = p_user
    where child_id = p_child and source_org_id = p_source and grantee_org_id = p_grantee and revoked_at is null
      and (expires_at is null or expires_at > now())
    returning id
  loop
    insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
    values ('parent', p_user, 'sharing.revoked', 'sharing_grant', v_old::text,
            jsonb_build_object('child_id', p_child, 'reason', 'replaced'));
  end loop;

  insert into public.sharing_grants (child_id, source_org_id, grantee_org_id, scopes, granted_by, expires_at)
  values (
    p_child, p_source, p_grantee,
    array(select distinct s from unnest(p_scopes) s order by s),
    p_user,
    case when p_expires_in_days is null then null else now() + make_interval(days => p_expires_in_days) end
  )
  returning * into v_grant;

  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('parent', p_user, 'sharing.granted', 'sharing_grant', v_grant.id::text,
          jsonb_build_object('child_id', p_child, 'source_org_id', p_source, 'grantee_org_id', p_grantee,
                             'scopes', to_jsonb(v_grant.scopes), 'expires_at', v_grant.expires_at));
  return to_jsonb(v_grant);
end;
$$;

-- FR-5. Any active guardian of the child may stop a grant. Results: revoked | not_found.
create or replace function public.revoke_sharing_grant(p_child uuid, p_grant uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.sharing_grants%rowtype;
begin
  if not exists (
    select 1 from public.guardian_links
    where child_id = p_child and user_id = p_user and status = 'active'
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;
  update public.sharing_grants set revoked_at = now(), revoked_by = p_user
  where id = p_grant and child_id = p_child and revoked_at is null
  returning * into v_grant;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('parent', p_user, 'sharing.revoked', 'sharing_grant', p_grant::text,
          jsonb_build_object('child_id', p_child, 'source_org_id', v_grant.source_org_id,
                             'grantee_org_id', v_grant.grantee_org_id, 'reason', 'guardian'));
  return jsonb_build_object('result', 'revoked', 'grant', to_jsonb(v_grant));
end;
$$;

revoke all on function public.add_case_assignment(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.update_case_assignment(uuid, uuid, text, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.remove_case_assignment(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_sharing_grant(uuid, uuid, uuid, text[], int, uuid) from public, anon, authenticated;
revoke all on function public.revoke_sharing_grant(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_case_assignment(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.update_case_assignment(uuid, uuid, text, text, boolean, uuid) to service_role;
grant execute on function public.remove_case_assignment(uuid, uuid, uuid) to service_role;
grant execute on function public.create_sharing_grant(uuid, uuid, uuid, text[], int, uuid) to service_role;
grant execute on function public.revoke_sharing_grant(uuid, uuid, uuid) to service_role;
