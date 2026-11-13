-- 032: notifications - transactional outbox, scheduler leases, per-recipient deliveries, preferences.
-- Additive only: new tables and functions, plus triggers that turn 028's provider decisions into outbox events
-- in the same transaction as the decision. Every function is callable only by the service role (or by other
-- security-definer functions, which run as their owner). See docs/notifications.md.

-- ---------- tables ----------
create table public.outbox_events (
  id bigint generated always as identity primary key,
  topic text not null check (topic ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and char_length(topic) <= 80),
  aggregate_type text not null check (char_length(aggregate_type) between 1 and 60),
  aggregate_id uuid not null,
  -- Ids and small non-clinical values only (enforced per topic in lib/notify/topics.ts).
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192),
  dedup_key text not null unique check (char_length(dedup_key) between 1 and 300),
  deliver_after timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'fanned_out', 'cancelled')),
  created_at timestamptz not null default now(),
  fanned_out_at timestamptz
);
create index outbox_events_due_idx on public.outbox_events (deliver_after, id) where status = 'pending';
create index outbox_events_aggregate_idx on public.outbox_events (aggregate_type, aggregate_id, id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  event_id bigint not null references public.outbox_events(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email', 'whatsapp')),
  template text not null check (char_length(template) between 1 and 80),
  locale text not null default 'en' check (locale in ('en', 'hi', 'te')),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'dead', 'skipped', 'cancelled')),
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (char_length(last_error) <= 500),
  provider_message_id text check (char_length(provider_message_id) <= 200),
  title text check (char_length(title) <= 200),
  body text check (char_length(body) <= 1000),
  link text check (link ~ '^/[^/\\]' and char_length(link) <= 300),
  read_at timestamptz,
  sent_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, recipient_user_id, channel)
);
create index notifications_due_idx on public.notifications (next_attempt_at) where status in ('pending', 'failed');
create index notifications_lease_idx on public.notifications (locked_until) where status = 'sending';
create index notifications_inbox_idx on public.notifications (recipient_user_id, created_at desc, id desc)
  where channel = 'in_app';
create index notifications_unread_idx on public.notifications (recipient_user_id)
  where channel = 'in_app' and read_at is null;
create index notifications_problems_idx on public.notifications (last_attempt_at desc) where status in ('failed', 'dead');

create table public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- In-app cannot be disabled, so it has no row.
  channel text not null check (channel in ('email', 'whatsapp')),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, channel)
);

-- ---------- RLS: the server uses the service role; browsers (later Realtime) read only their own in-app rows ----------
alter table public.outbox_events enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;

revoke all on public.outbox_events, public.notifications, public.notification_preferences from anon, authenticated;
grant select on public.notifications, public.notification_preferences to authenticated;

create policy "Recipients read their in-app notifications" on public.notifications
for select to authenticated
using (recipient_user_id = (select auth.uid()) and channel = 'in_app');

create policy "Users read their notification preferences" on public.notification_preferences
for select to authenticated
using (user_id = (select auth.uid()));

-- ---------- producer ----------
-- FR-1: returns the new event id, or the existing id when the dedup key is already taken (exactly-once enqueue).
-- Call it inside the producing transaction (SQL function or `sql.begin`), so the event commits with the write.
create or replace function public.outbox_enqueue(
  p_topic text,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_payload jsonb,
  p_dedup_key text,
  p_deliver_after timestamptz default now()
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.outbox_events (topic, aggregate_type, aggregate_id, payload, dedup_key, deliver_after)
  values (p_topic, p_aggregate_type, p_aggregate_id, coalesce(p_payload, '{}'::jsonb), p_dedup_key,
          coalesce(p_deliver_after, now()))
  on conflict (dedup_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.outbox_events where dedup_key = p_dedup_key;
  end if;
  return v_id;
end;
$$;

-- FR-1 (030 reminders): cancels pending events whose dedup key starts with the prefix and every not-yet-sent
-- notification of matching events. Returns the number of events cancelled.
create or replace function public.outbox_cancel(p_dedup_key_prefix text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pattern text;
  v_count integer;
begin
  if coalesce(p_dedup_key_prefix, '') = '' then
    raise exception 'outbox_cancel: prefix required';
  end if;
  v_pattern := replace(replace(replace(p_dedup_key_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  update public.outbox_events set status = 'cancelled'
  where dedup_key like v_pattern and status = 'pending';
  get diagnostics v_count = row_count;
  update public.notifications n set status = 'cancelled', locked_until = null
  from public.outbox_events e
  where n.event_id = e.id and e.dedup_key like v_pattern and n.status in ('pending', 'failed');
  return v_count;
end;
$$;

-- ---------- scheduler ----------
-- FR-4 cost control: one cheap indexed check before doing anything.
create or replace function public.outbox_has_due_work()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.outbox_events where status = 'pending' and deliver_after <= now())
      or exists (select 1 from public.notifications where status in ('pending', 'failed') and next_attempt_at <= now())
      or exists (select 1 from public.notifications where status = 'sending' and locked_until < now());
$$;

-- Due events, row-locked until the caller's transaction ends; concurrent workers skip them (never fan out twice).
create or replace function public.outbox_claim_events(p_batch integer, p_event_ids bigint[] default null)
returns setof public.outbox_events
language sql
security definer
set search_path = ''
as $$
  select * from public.outbox_events
  where status = 'pending' and deliver_after <= now() and (p_event_ids is null or id = any(p_event_ids))
  order by deliver_after, id
  limit greatest(1, least(p_batch, 500))
  for update skip locked;
$$;

-- Leases due email/WhatsApp deliveries (status `sending`, `locked_until` = now + lease, attempts + 1). Rows whose
-- lease expired (crashed worker) are claimable again; rows that used every attempt are moved to `dead` instead.
create or replace function public.notifications_claim(
  p_batch integer,
  p_lease_seconds integer,
  p_event_ids bigint[] default null,
  p_max_attempts integer default 6
) returns setof public.notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  with exhausted as (
    update public.notifications
    set status = 'dead', locked_until = null, last_error = 'lease_expired', last_attempt_at = now()
    where status = 'sending' and locked_until < now() and attempts >= p_max_attempts
    returning id, channel, template, recipient_user_id
  )
  insert into public.audit_events (actor, action, entity, entity_id, details)
  select 'system', 'notification.dead', 'notification', x.id::text,
         jsonb_build_object('channel', x.channel, 'template', x.template, 'error', 'lease_expired')
  from exhausted x;

  return query
  with due as (
    select id from public.notifications
    where channel <> 'in_app'
      and (p_event_ids is null or event_id = any(p_event_ids))
      and (
        (status in ('pending', 'failed') and next_attempt_at <= now())
        or (status = 'sending' and locked_until < now())
      )
    order by next_attempt_at, id
    limit greatest(1, least(p_batch, 500))
    for update skip locked
  )
  update public.notifications n
  set status = 'sending',
      attempts = n.attempts + 1,
      -- Millisecond precision so the lease round-trips through JavaScript Dates (notification_complete compares it).
      locked_until = date_trunc('milliseconds', now() + make_interval(secs => greatest(10, least(p_lease_seconds, 3600)))),
      last_attempt_at = now()
  from due
  where n.id = due.id
  returning n.*;
end;
$$;

-- Records a delivery outcome, only while the caller still holds the lease it claimed (a worker whose lease
-- expired and was reclaimed cannot overwrite the newer attempt). `dead` writes its audit row in the same
-- transaction. Returns false when the lease was lost.
create or replace function public.notification_complete(
  p_id uuid,
  p_lease timestamptz,
  p_status text,
  p_provider_message_id text default null,
  p_error text default null,
  p_next_attempt_at timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notifications%rowtype;
begin
  if p_status not in ('sent', 'failed', 'dead', 'skipped') then
    raise exception 'notification_complete: invalid status %', p_status;
  end if;
  update public.notifications
  set status = p_status,
      locked_until = null,
      provider_message_id = coalesce(left(p_provider_message_id, 200), provider_message_id),
      last_error = left(p_error, 500),
      sent_at = case when p_status = 'sent' then now() else sent_at end,
      next_attempt_at = case when p_status = 'failed' then coalesce(p_next_attempt_at, now()) else next_attempt_at end
  where id = p_id and status = 'sending' and locked_until = p_lease
  returning * into v_row;
  if not found then
    return false;
  end if;
  if p_status = 'dead' then
    insert into public.audit_events (actor, action, entity, entity_id, details)
    values ('system', 'notification.dead', 'notification', p_id::text,
      jsonb_build_object('channel', v_row.channel, 'template', v_row.template, 'attempts', v_row.attempts,
        'error', left(p_error, 120)));
  end if;
  return true;
end;
$$;

-- FR-9: platform admin `Retry` (dead -> pending), audited in the same transaction.
create or replace function public.notification_retry(p_id uuid, p_admin uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notifications
  set status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = null, last_error = null
  where id = p_id and status = 'dead';
  if not found then
    return false;
  end if;
  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('system', p_admin, 'notification.retried', 'notification', p_id::text, '{}'::jsonb);
  return true;
end;
$$;

-- ---------- 028 producers: provider decisions emit their outbox event in the deciding transaction ----------
create or replace function public.provider_submission_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'submitted' and new.status in ('approved', 'rejected') then
    perform public.outbox_enqueue(
      case new.status when 'approved' then 'provider.verified' else 'provider.rejected' end,
      'provider_profile', new.provider_profile_id,
      jsonb_build_object('provider_profile_id', new.provider_profile_id, 'submission_id', new.id),
      case new.status when 'approved' then 'provider.verified:' else 'provider.rejected:' end || new.id::text,
      now());
  end if;
  return null;
end;
$$;

create trigger credential_submissions_outbox
after update of status on public.credential_submissions
for each row execute function public.provider_submission_outbox();

create or replace function public.provider_profile_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status = 'suspended' and old.verification_status is distinct from 'suspended' then
    perform public.outbox_enqueue('provider.suspended', 'provider_profile', new.id,
      jsonb_build_object('provider_profile_id', new.id),
      'provider.suspended:' || new.id::text || ':' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24MISSUS'), now());
  end if;
  if old.user_id is null and new.user_id is not null and new.claimed and not old.claimed then
    perform public.outbox_enqueue('provider.claimed', 'provider_profile', new.id,
      jsonb_build_object('provider_profile_id', new.id), 'provider.claimed:' || new.id::text, now());
  end if;
  return null;
end;
$$;

create trigger provider_profiles_outbox
after update of verification_status, user_id, claimed on public.provider_profiles
for each row execute function public.provider_profile_outbox();

-- ---------- privileges ----------
revoke all on function public.outbox_enqueue(text, text, uuid, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.outbox_cancel(text) from public, anon, authenticated;
revoke all on function public.outbox_has_due_work() from public, anon, authenticated;
revoke all on function public.outbox_claim_events(integer, bigint[]) from public, anon, authenticated;
revoke all on function public.notifications_claim(integer, integer, bigint[], integer) from public, anon, authenticated;
revoke all on function public.notification_complete(uuid, timestamptz, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.notification_retry(uuid, uuid) from public, anon, authenticated;
revoke all on function public.provider_submission_outbox() from public, anon, authenticated;
revoke all on function public.provider_profile_outbox() from public, anon, authenticated;
grant execute on function public.outbox_enqueue(text, text, uuid, jsonb, text, timestamptz) to service_role;
grant execute on function public.outbox_cancel(text) to service_role;
grant execute on function public.outbox_has_due_work() to service_role;
grant execute on function public.outbox_claim_events(integer, bigint[]) to service_role;
grant execute on function public.notifications_claim(integer, integer, bigint[], integer) to service_role;
grant execute on function public.notification_complete(uuid, timestamptz, text, text, text, timestamptz) to service_role;
grant execute on function public.notification_retry(uuid, uuid) to service_role;
grant select, insert, update, delete on public.outbox_events, public.notifications, public.notification_preferences
  to service_role;
