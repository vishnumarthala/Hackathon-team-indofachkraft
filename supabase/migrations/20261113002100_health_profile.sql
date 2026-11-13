-- Ticket 021: child health profile (one per child, guardian-edited, provider-read), versioned with optimistic
-- concurrency and an append-only history written by a trigger. New tables only: no backfill needed (a child
-- without a row has the empty profile, version 0).

-- =====================================================================================================
-- tables (FR-1)
-- =====================================================================================================

create table if not exists public.child_health_profiles (
  child_id uuid primary key references public.children(id) on delete cascade,
  blood_group text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown')),
  allergies jsonb not null default '[]'::jsonb
    check (jsonb_typeof(allergies) = 'array' and jsonb_array_length(allergies) <= 30),
  medications jsonb not null default '[]'::jsonb
    check (jsonb_typeof(medications) = 'array' and jsonb_array_length(medications) <= 30),
  conditions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(conditions) = 'array' and jsonb_array_length(conditions) <= 30),
  birth_history text check (char_length(birth_history) <= 2000),
  developmental_history text check (char_length(developmental_history) <= 4000),
  emergency_contact_name text check (char_length(emergency_contact_name) between 1 and 80),
  emergency_contact_phone text check (emergency_contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  version int not null default 1 check (version >= 1),
  -- Plain uuids (no FK): deleting an account must not rewrite health rows or their history.
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.child_health_profile_history (
  id bigint generated always as identity primary key,
  child_id uuid not null references public.children(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  -- Top-level field names that differ from the previous version (names only, never values).
  changed_fields text[] not null default '{}',
  changed_by uuid,
  changed_at timestamptz not null default now(),
  unique (child_id, version)
);

create index if not exists child_health_profile_history_child_idx
  on public.child_health_profile_history (child_id, version desc);

-- =====================================================================================================
-- versioning + history (FR-1, D-4)
-- =====================================================================================================

-- Names of the top-level fields that differ between two rows (old null = new profile: fields that are not empty).
create or replace function public.health_profile_changed_fields(old_row jsonb, new_row jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(f order by ord), '{}')
  from unnest(array['blood_group', 'allergies', 'medications', 'conditions', 'birth_history',
                    'developmental_history', 'emergency_contact_name', 'emergency_contact_phone'])
       with ordinality as t(f, ord)
  where case
    when old_row is null then
      coalesce(new_row -> f, 'null'::jsonb) not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb)
    else
      coalesce(old_row -> f, 'null'::jsonb) is distinct from coalesce(new_row -> f, 'null'::jsonb)
  end;
$$;

-- Every update is a new version: the trigger owns `version` and `updated_at`, whoever writes the row.
create or replace function public.child_health_profiles_bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.child_id is distinct from old.child_id then
    raise exception 'child_id cannot change' using errcode = '42501';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists child_health_profiles_bump_version on public.child_health_profiles;
create trigger child_health_profiles_bump_version before update on public.child_health_profiles
for each row execute function public.child_health_profiles_bump_version();

create or replace function public.child_health_profiles_new_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists child_health_profiles_new_insert on public.child_health_profiles;
create trigger child_health_profiles_new_insert before insert on public.child_health_profiles
for each row execute function public.child_health_profiles_new_insert();

-- Security definer: history is insert-only through this trigger (no role has direct write privileges).
create or replace function public.child_health_profiles_write_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new) - 'child_id';
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) - 'child_id' else null end;
begin
  insert into public.child_health_profile_history (child_id, version, snapshot, changed_fields, changed_by, changed_at)
  values (new.child_id, new.version, v_new, public.health_profile_changed_fields(v_old, v_new), new.updated_by, new.updated_at);
  return null;
end;
$$;
revoke all on function public.child_health_profiles_write_history() from public, anon, authenticated;

drop trigger if exists child_health_profiles_write_history on public.child_health_profiles;
create trigger child_health_profiles_write_history after insert or update on public.child_health_profiles
for each row execute function public.child_health_profiles_write_history();

-- History is append-only: no updates or truncation for any role (deletes only cascade from `children`,
-- e.g. account deletion in ticket 041; direct deletes are revoked below).
create or replace function public.child_health_profile_history_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'child_health_profile_history is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists child_health_profile_history_no_update on public.child_health_profile_history;
create trigger child_health_profile_history_no_update before update on public.child_health_profile_history
for each row execute function public.child_health_profile_history_append_only();
drop trigger if exists child_health_profile_history_no_truncate on public.child_health_profile_history;
create trigger child_health_profile_history_no_truncate before truncate on public.child_health_profile_history
for each statement execute function public.child_health_profile_history_append_only();

-- =====================================================================================================
-- save with optimistic concurrency + audit in one transaction (FR-3)
-- =====================================================================================================

-- p_expected_version 0 = "there is no profile yet". Returns
--   { result: 'saved', profile, fields }  |  { result: 'conflict' }  |  { result: 'not_found' }.
-- The audit row (`health_profile.updated`, field names only) is written in the same transaction: if it
-- fails, nothing is saved (strict).
create or replace function public.save_child_health_profile(
  p_child uuid,
  p_user uuid,
  p_expected_version int,
  p_profile jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.child_health_profiles;
  v_new public.child_health_profiles;
  v_fields text[];
begin
  -- Defence in depth: the server already checked requireChildGuardian().
  if not exists (
    select 1 from public.guardian_links gl
    join public.children c on c.id = gl.child_id
    where gl.child_id = p_child and gl.user_id = p_user and gl.status = 'active' and c.deleted_at is null
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_expected_version = 0 then
    insert into public.child_health_profiles as p (
      child_id, blood_group, allergies, medications, conditions, birth_history, developmental_history,
      emergency_contact_name, emergency_contact_phone, updated_by
    ) values (
      p_child,
      p_profile ->> 'blood_group',
      coalesce(p_profile -> 'allergies', '[]'::jsonb),
      coalesce(p_profile -> 'medications', '[]'::jsonb),
      coalesce(p_profile -> 'conditions', '[]'::jsonb),
      p_profile ->> 'birth_history',
      p_profile ->> 'developmental_history',
      p_profile ->> 'emergency_contact_name',
      p_profile ->> 'emergency_contact_phone',
      p_user
    )
    on conflict (child_id) do nothing
    returning p.* into v_new;
    if not found then
      return jsonb_build_object('result', 'conflict');
    end if;
    v_fields := public.health_profile_changed_fields(null, to_jsonb(v_new));
  else
    select * into v_old from public.child_health_profiles where child_id = p_child for update;
    if not found or v_old.version <> p_expected_version then
      return jsonb_build_object('result', 'conflict');
    end if;
    update public.child_health_profiles set
      blood_group = p_profile ->> 'blood_group',
      allergies = coalesce(p_profile -> 'allergies', '[]'::jsonb),
      medications = coalesce(p_profile -> 'medications', '[]'::jsonb),
      conditions = coalesce(p_profile -> 'conditions', '[]'::jsonb),
      birth_history = p_profile ->> 'birth_history',
      developmental_history = p_profile ->> 'developmental_history',
      emergency_contact_name = p_profile ->> 'emergency_contact_name',
      emergency_contact_phone = p_profile ->> 'emergency_contact_phone',
      updated_by = p_user
    where child_id = p_child
    returning * into v_new;
    v_fields := public.health_profile_changed_fields(to_jsonb(v_old), to_jsonb(v_new));
  end if;

  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (null, 'parent', p_user, 'health_profile.updated', 'child', p_child::text,
          jsonb_build_object('fields', to_jsonb(v_fields), 'version', v_new.version));

  return jsonb_build_object('result', 'saved', 'profile', to_jsonb(v_new), 'fields', to_jsonb(v_fields));
end;
$$;

revoke all on function public.health_profile_changed_fields(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.save_child_health_profile(uuid, uuid, int, jsonb) from public, anon, authenticated;
grant execute on function public.health_profile_changed_fields(jsonb, jsonb) to service_role;
grant execute on function public.save_child_health_profile(uuid, uuid, int, jsonb) to service_role;

-- =====================================================================================================
-- RLS (NFR-1): guardians read their children's profile and history; providers read the current profile of a
-- child they can reach through an accessible case (022 `can_read_child_via_org`). No client writes.
-- =====================================================================================================

alter table public.child_health_profiles enable row level security;
alter table public.child_health_profile_history enable row level security;

revoke all on public.child_health_profiles, public.child_health_profile_history from anon, authenticated;
revoke insert, update, delete, truncate on public.child_health_profile_history from service_role;
grant select on public.child_health_profiles, public.child_health_profile_history to authenticated;
grant select on public.child_health_profile_history to service_role;

drop policy if exists "Guardians and treating providers read health profiles" on public.child_health_profiles;
create policy "Guardians and treating providers read health profiles" on public.child_health_profiles
for select to authenticated
using ((select public.is_child_guardian(child_id)) or (select public.can_read_child_via_org(child_id)));

drop policy if exists "Guardians read health profile history" on public.child_health_profile_history;
create policy "Guardians read health profile history" on public.child_health_profile_history
for select to authenticated
using ((select public.is_child_guardian(child_id)));
