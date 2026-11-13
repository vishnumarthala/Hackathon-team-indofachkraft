-- 041 FR-1: a trustworthy audit log (design rule 7). Expand -> backfill -> enforce.
--   * attributable: actor_role / org / child / case_ref / request id / hashed IP; a before-insert trigger fills
--     actor_role (from user_profiles when actor_user_id is set), case_ref, child_id and org_id for every writer,
--     including the security-definer functions of 017-032 that insert audit rows themselves;
--   * survives case deletion: the `case_id -> cases` FK with `on delete cascade` is dropped (column kept, indexed);
--   * append-only: update / delete / truncate revoked from anon, authenticated and service_role, and a trigger raises
--     for every role (also the table owner). The only exceptions are the two maintenance functions below
--     (`audit_purge_expired` for the 7-year retention, `audit_redact_child` for erasure requests), which switch a
--     transaction-local flag that the trigger honours. See docs/privacy/retention.md.

-- =====================================================================================================
-- expand
-- =====================================================================================================

alter table public.audit_events add column if not exists actor_role text;
alter table public.audit_events add column if not exists org_id uuid;
alter table public.audit_events add column if not exists child_id uuid;
alter table public.audit_events add column if not exists case_ref uuid;
alter table public.audit_events add column if not exists request_id text;
alter table public.audit_events add column if not exists ip_hash text;

-- Audit rows must outlive the case they describe (D-2).
alter table public.audit_events drop constraint if exists audit_events_case_id_fkey;

alter table public.audit_events drop constraint if exists audit_events_actor_check;
alter table public.audit_events add constraint audit_events_actor_check check (actor in (
  'therapist', 'parent', 'specialist', 'ai', 'system',            -- legacy kinds, kept for history
  'provider', 'guardian', 'platform_admin', 'anonymous'));

alter table public.audit_events drop constraint if exists audit_events_actor_role_check;
alter table public.audit_events add constraint audit_events_actor_role_check check (actor_role in (
  'platform_admin', 'provider', 'guardian', 'system', 'ai', 'anonymous'));
alter table public.audit_events drop constraint if exists audit_events_request_id_check;
alter table public.audit_events add constraint audit_events_request_id_check check (char_length(request_id) <= 200);
alter table public.audit_events drop constraint if exists audit_events_ip_hash_check;
alter table public.audit_events add constraint audit_events_ip_hash_check check (char_length(ip_hash) <= 128);

-- Role of a user-less legacy actor kind.
create or replace function public.audit_role_for_actor(p_actor text, p_has_user boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_actor
    when 'ai' then 'ai'
    when 'system' then 'system'
    when 'therapist' then 'provider'
    when 'provider' then 'provider'
    when 'guardian' then 'guardian'
    when 'platform_admin' then 'platform_admin'
    when 'parent' then case when p_has_user then 'guardian' else 'anonymous' end
    else 'anonymous'                                           -- specialist (share link), anonymous
  end;
$$;

-- =====================================================================================================
-- backfill (idempotent)
-- =====================================================================================================

update public.audit_events a
set case_ref = coalesce(a.case_ref, a.case_id),
    actor_role = coalesce(
      a.actor_role,
      case when a.actor in ('ai', 'system') and a.actor_user_id is null then a.actor end,
      (select p.role from public.user_profiles p where p.id = a.actor_user_id and a.actor <> 'ai'),
      public.audit_role_for_actor(a.actor, a.actor_user_id is not null)),
    child_id = coalesce(a.child_id, (select c.child_id from public.cases c where c.id = a.case_id)),
    org_id = coalesce(a.org_id, (select c.org_id from public.cases c where c.id = a.case_id))
where a.actor_role is null or (a.case_id is not null and a.case_ref is null);

-- =====================================================================================================
-- enforce
-- =====================================================================================================

-- Every writer gets attribution and the case's child/org, whatever columns it names.
-- `dnm.actor_user_id` (transaction-local, set by lib/audit `setTxAuditActor`) attributes rows written by SQL that
-- predates this ticket and names a human actor kind without an id.
create or replace function public.audit_events_fill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx_user text := nullif(current_setting('dnm.actor_user_id', true), '');
  v_role text;
  v_case record;
begin
  if new.actor_user_id is null and v_tx_user is not null
     and new.actor in ('therapist', 'provider', 'parent', 'guardian', 'platform_admin') then
    new.actor_user_id := v_tx_user::uuid;
  end if;

  if new.actor_role is null then
    if new.actor = 'ai' or (new.actor = 'system' and new.actor_user_id is null) then
      new.actor_role := new.actor;
    else
      if new.actor_user_id is not null then
        select p.role into v_role from public.user_profiles p where p.id = new.actor_user_id;
      end if;
      new.actor_role := coalesce(v_role, public.audit_role_for_actor(new.actor, new.actor_user_id is not null));
    end if;
  end if;
  -- Writers may leave the legacy `actor` column empty and name only the user (lib/audit): use the role.
  if new.actor is null then
    new.actor := new.actor_role;
  end if;

  new.case_ref := coalesce(new.case_ref, new.case_id);
  if new.case_ref is not null and (new.child_id is null or new.org_id is null) then
    select c.child_id, c.org_id into v_case from public.cases c where c.id = new.case_ref;
    if found then
      new.child_id := coalesce(new.child_id, v_case.child_id);
      new.org_id := coalesce(new.org_id, v_case.org_id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.audit_events_fill() from public, anon, authenticated;

drop trigger if exists audit_events_fill on public.audit_events;
create trigger audit_events_fill before insert on public.audit_events
for each row execute function public.audit_events_fill();

alter table public.audit_events alter column actor_role set not null;

create or replace function public.audit_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_level = 'ROW' and current_setting('dnm.audit_maintenance', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception 'audit_events is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists audit_events_no_update on public.audit_events;
create trigger audit_events_no_update before update or delete on public.audit_events
for each row execute function public.audit_events_append_only();
drop trigger if exists audit_events_no_truncate on public.audit_events;
create trigger audit_events_no_truncate before truncate on public.audit_events
for each statement execute function public.audit_events_append_only();

revoke all on public.audit_events from anon, authenticated;
revoke update, delete, truncate on public.audit_events from service_role;
grant select, insert on public.audit_events to service_role;

create index if not exists audit_events_case_idx on public.audit_events (case_id);
create index if not exists audit_events_case_ref_idx on public.audit_events (case_ref, id desc);
create index if not exists audit_events_child_idx on public.audit_events (child_id, id desc);
create index if not exists audit_events_org_idx on public.audit_events (org_id, id desc);
create index if not exists audit_events_actor_idx on public.audit_events (actor_user_id, id desc);
create index if not exists audit_events_action_idx on public.audit_events (action, id desc);
create index if not exists audit_events_created_idx on public.audit_events (created_at);

-- =====================================================================================================
-- maintenance (service role only; the only paths that may change audit rows)
-- =====================================================================================================

-- Keeps ids, numbers, booleans and short lowercase enum-like tokens; drops free text (names, notes, questions,
-- addresses, errors) and every key that names personal text.
create or replace function public.audit_strip_free_text(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) || jsonb_build_object('redacted', true)
  from (
    select k.key,
           case jsonb_typeof(k.value)
             when 'array' then (
               select coalesce(jsonb_agg(x.value), '[]'::jsonb) from jsonb_array_elements(k.value) x
               where jsonb_typeof(x.value) in ('number', 'boolean', 'null')
                  or (jsonb_typeof(x.value) = 'string' and (x.value #>> '{}') ~ '^[a-z0-9_.:-]{1,64}$'))
             else k.value
           end as value
    from jsonb_each(coalesce(p, '{}'::jsonb)) k
    where k.key !~* '(name|title|reason|note|question|answer|subject|email|phone|address|error|text|^to$|message)'
      and (jsonb_typeof(k.value) in ('number', 'boolean', 'null', 'array')
           or (jsonb_typeof(k.value) = 'string' and (k.value #>> '{}') ~ '^[a-z0-9_.:-]{1,64}$'))
  ) e;
$$;

-- FR-6: audit events older than the retention period (default 7 years) are deleted. Returns the count.
create or replace function public.audit_purge_expired(p_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_before > now() - interval '1 year' then
    raise exception 'audit: refusing to purge events younger than one year';
  end if;
  perform set_config('dnm.audit_maintenance', 'on', true);
  delete from public.audit_events where created_at < p_before;
  get diagnostics n = row_count;
  perform set_config('dnm.audit_maintenance', 'off', true);
  return n;
end;
$$;

-- FR-8: an erasure keeps the audit trail (legal obligation) but strips free text from the child's rows.
create or replace function public.audit_redact_child(p_child uuid, p_cases uuid[] default '{}')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform set_config('dnm.audit_maintenance', 'on', true);
  update public.audit_events
  set details = public.audit_strip_free_text(details)
  where (child_id = p_child or case_ref = any(coalesce(p_cases, '{}')) or entity_id = p_child::text
         or details ->> 'child_id' = p_child::text)
    and not coalesce((details ->> 'redacted')::boolean, false);
  get diagnostics n = row_count;
  perform set_config('dnm.audit_maintenance', 'off', true);
  return n;
end;
$$;

revoke all on function public.audit_role_for_actor(text, boolean) from public, anon, authenticated;
revoke all on function public.audit_strip_free_text(jsonb) from public, anon, authenticated;
revoke all on function public.audit_purge_expired(timestamptz) from public, anon, authenticated;
revoke all on function public.audit_redact_child(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.audit_purge_expired(timestamptz) to service_role;
grant execute on function public.audit_redact_child(uuid, uuid[]) to service_role;
