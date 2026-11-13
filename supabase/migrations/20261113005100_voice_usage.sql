-- Ticket 051: voice cost guard. Every voice minute costs ElevenLabs credits, so voice starts need a signed-in user, a
-- per-user quota and room in the platform budget. This migration adds the voice usage ledger, the admin cap override
-- and the one atomic start check.
--
--   * `voice_usage`    - one row per voice start attempt: who (account id only), which agent, when, the seconds reserved
--                        (the agent's maximum call length) and, after the call, the seconds actually used. Blocked
--                        attempts are kept as `status = 'blocked'` with the reason (admin visibility). No child data,
--                        no transcript, no IP: the only link is "this account had a voice call of N seconds".
--   * `voice_settings` - a single row; non-null caps override VOICE_DAILY_MINUTES_CAP / VOICE_MONTHLY_MINUTES_CAP
--                        (changed in /admin/ops with an audit event).
--   * `voice_session_start(...)` - FR-4 / FR-5: quota, concurrency and budget checks plus the reservation in one call.
--                        A transaction-scoped advisory lock serialises starts, so parallel starts can never overshoot a
--                        quota or the budget.
-- Days and months are calendar days/months in India (Asia/Kolkata); the per-user "30 days" window is rolling.
-- Server-only: RLS on, no policies, no grants for anon/authenticated (the app uses the service role).

create table public.voice_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent text not null check (agent in ('screen', 'booking', 'followup', 'intake_demo')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  reserved_seconds integer not null check (reserved_seconds between 1 and 3600),
  actual_seconds integer check (actual_seconds between 0 and 86400),
  conversation_id text check (conversation_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  status text not null default 'started' check (status in ('started', 'ended', 'expired', 'blocked')),
  blocked_reason text check (blocked_reason in ('quota_day', 'quota_month', 'budget', 'concurrent')),
  -- FR-7: when the real duration was fetched from ElevenLabs (null in DEMO_MODE or without a conversation id).
  reconciled_at timestamptz,
  constraint voice_usage_blocked_reason check ((status = 'blocked') = (blocked_reason is not null)),
  constraint voice_usage_ended check ((status = 'started') = (ended_at is null))
);

comment on table public.voice_usage is
  '051: voice usage ledger (account id, agent, seconds). No child data, no transcripts. Deleted after 180 days.';

create index voice_usage_user_agent_started_idx on public.voice_usage (user_id, agent, started_at);
create index voice_usage_started_idx on public.voice_usage (started_at);
create index voice_usage_open_idx on public.voice_usage (user_id) where status = 'started';

alter table public.voice_usage enable row level security;
revoke all on public.voice_usage from anon, authenticated;

create table public.voice_settings (
  id boolean primary key default true check (id),
  daily_minutes_cap integer check (daily_minutes_cap between 0 and 10000000),
  monthly_minutes_cap integer check (monthly_minutes_cap between 0 and 100000000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

comment on table public.voice_settings is '051: runtime override of the platform voice budget (null = env value).';

insert into public.voice_settings (id) values (true) on conflict (id) do nothing;

alter table public.voice_settings enable row level security;
revoke all on public.voice_settings from anon, authenticated;

-- Seconds a row counts against the budget: the reservation while the call runs, then the actual seconds.
create or replace function public.voice_usage_seconds(p_status text, p_reserved integer, p_actual integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'blocked' then 0
    when p_status = 'started' then p_reserved
    else coalesce(p_actual, p_reserved)
  end;
$$;

-- FR-7: calls still `started` 2 minutes after their maximum length are expired with actual = reserved.
create or replace function public.voice_usage_expire_stale(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.voice_usage
  set status = 'expired',
      ended_at = started_at + make_interval(secs => reserved_seconds),
      actual_seconds = reserved_seconds
  where status = 'started'
    and started_at + make_interval(secs => reserved_seconds + 120) < p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- FR-4 / FR-5: returns `ok` (with the new row id) or the reason the start is refused. Limits come from the app (env);
-- caps are seconds, overridden by `voice_settings` when set. Order: budget, concurrent, daily quota, 30-day quota.
create or replace function public.voice_session_start(
  p_user uuid,
  p_agent text,
  p_reserved integer,
  p_day_limit integer,
  p_month_limit integer,
  p_daily_cap_seconds bigint,
  p_monthly_cap_seconds bigint
)
returns table (
  status text,
  usage_id uuid,
  day_used_seconds bigint,
  day_cap_seconds bigint,
  month_used_seconds bigint,
  month_cap_seconds bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_day_start timestamptz := date_trunc('day', v_now at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_month_start timestamptz := date_trunc('month', v_now at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_daily_override integer;
  v_monthly_override integer;
  v_day_cap bigint;
  v_month_cap bigint;
  v_day_used bigint;
  v_month_used bigint;
  v_status text := 'ok';
  v_id uuid;
begin
  if p_user is null then raise exception 'voice_session_start: user required'; end if;
  if p_agent not in ('screen', 'booking', 'followup', 'intake_demo') then
    raise exception 'voice_session_start: unknown agent %', p_agent;
  end if;
  if p_reserved is null or p_reserved < 1 or p_reserved > 3600 then
    raise exception 'voice_session_start: reserved seconds out of range';
  end if;

  -- One start at a time, platform-wide: the budget is global, so per-user locks would not be enough.
  perform pg_advisory_xact_lock(hashtext('public.voice_session_start'));

  perform public.voice_usage_expire_stale(v_now);

  select s.daily_minutes_cap, s.monthly_minutes_cap into v_daily_override, v_monthly_override
  from public.voice_settings s where s.id;
  v_day_cap := coalesce(v_daily_override::bigint * 60, p_daily_cap_seconds);
  v_month_cap := coalesce(v_monthly_override::bigint * 60, p_monthly_cap_seconds);

  select
    coalesce(sum(public.voice_usage_seconds(u.status, u.reserved_seconds, u.actual_seconds)) filter (where u.started_at >= v_day_start), 0),
    coalesce(sum(public.voice_usage_seconds(u.status, u.reserved_seconds, u.actual_seconds)), 0)
  into v_day_used, v_month_used
  from public.voice_usage u
  where u.started_at >= least(v_day_start, v_month_start) and u.status <> 'blocked';

  if v_day_used + p_reserved > v_day_cap or v_month_used + p_reserved > v_month_cap then
    v_status := 'budget';
  elsif exists (select 1 from public.voice_usage u where u.user_id = p_user and u.status = 'started') then
    v_status := 'concurrent';
  elsif p_day_limit is not null and (
    select count(*) from public.voice_usage u
    where u.user_id = p_user and u.agent = p_agent and u.status <> 'blocked' and u.started_at >= v_day_start
  ) >= p_day_limit then
    v_status := 'quota_day';
  elsif p_month_limit is not null and (
    select count(*) from public.voice_usage u
    where u.user_id = p_user and u.agent = p_agent and u.status <> 'blocked' and u.started_at > v_now - interval '30 days'
  ) >= p_month_limit then
    v_status := 'quota_month';
  end if;

  if v_status = 'ok' then
    insert into public.voice_usage (user_id, agent, started_at, reserved_seconds)
    values (p_user, p_agent, v_now, p_reserved)
    returning id into v_id;
    v_day_used := v_day_used + p_reserved;
    v_month_used := v_month_used + p_reserved;
  else
    insert into public.voice_usage (user_id, agent, started_at, ended_at, reserved_seconds, actual_seconds, status, blocked_reason)
    values (p_user, p_agent, v_now, v_now, p_reserved, 0, 'blocked', v_status)
    returning id into v_id;
  end if;

  return query select v_status, v_id, v_day_used, v_day_cap, v_month_used, v_month_cap;
end;
$$;

revoke all on function public.voice_usage_seconds(text, integer, integer) from public, anon, authenticated;
revoke all on function public.voice_usage_expire_stale(timestamptz) from public, anon, authenticated;
revoke all on function public.voice_session_start(uuid, text, integer, integer, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.voice_usage_seconds(text, integer, integer) to service_role;
grant execute on function public.voice_usage_expire_stale(timestamptz) to service_role;
grant execute on function public.voice_session_start(uuid, text, integer, integer, integer, bigint, bigint) to service_role;
