-- 043: recurring therapy sessions (weekly series).
-- A series (centre staff only) generates real `confirmed` appointments on a rolling 8-week horizon, so 030's exclusion
-- constraint, reminders, the family Visits tab and the provider agenda keep working unchanged. Occurrences that cannot
-- be booked (slot taken, blocked date, outside the weekly hours) are never double-booked: they are recorded in
-- `series_conflicts` for staff to resolve (`Pick another time` / `Skip this date`).
-- Additive only. 030's state machine is unchanged: series code inserts `confirmed` rows inside the same exclusion
-- constraint (under 030's per-provider lock) and cancels through `booking_cancel`. Every function is security definer
-- and callable only by the service role; the server gates each route first (lib/booking/series.ts).
-- Times: `start_time` is a wall-clock time in `time_zone` (the clinic's, else the provider's): occurrences keep their
-- local time across DST changes (`(date + time) at time zone tz`).

-- ---------- tables ----------
create or replace function public.series_weekdays_valid(p_weekdays smallint[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- 0 = Monday ... 6 = Sunday (030's availability_rules convention); 1-4 distinct days a week.
  select p_weekdays is not null
     and cardinality(p_weekdays) between 1 and 4
     and array_position(p_weekdays, null) is null
     and p_weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
     and (select count(distinct d) from unnest(p_weekdays) d) = cardinality(p_weekdays);
$$;

create table public.appointment_series (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  -- Rule 11: what the series books, frozen when the series is created (later service edits never change it).
  service_snapshot jsonb not null,
  child_id uuid not null references public.children(id) on delete cascade,
  case_id uuid references public.cases(id) on delete set null,
  -- Optional (D-4): paper-consent families without an app account still get a timetable (and no messages).
  guardian_user_id uuid references auth.users(id) on delete set null,
  weekdays smallint[] not null check (public.series_weekdays_valid(weekdays)),
  start_time time not null,
  time_zone text not null check (char_length(time_zone) between 1 and 64),
  starts_on date not null,
  ends_on date,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  billing_mode text not null check (billing_mode in ('package', 'per_session', 'free')),
  -- FR-5 pause window (inclusive). Occurrences inside it are cancelled / never created.
  paused_from date,
  paused_until date,
  -- Last date the rolling horizon has been generated for (dates after it are still to come).
  materialized_until date,
  -- "This and future sessions": the series this one continues.
  replaces_series_id uuid references public.appointment_series(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A series changed before its first day ends the day before it starts (empty).
  constraint appointment_series_dates check (ends_on is null or ends_on >= starts_on - 1),
  constraint appointment_series_pause check (
    (paused_from is null) = (paused_until is null) and (paused_until is null or paused_until >= paused_from)
  )
);
create index appointment_series_child_idx on public.appointment_series (child_id, created_at desc);
create index appointment_series_case_idx on public.appointment_series (case_id) where case_id is not null;
create index appointment_series_profile_idx on public.appointment_series (provider_profile_id, status);
create index appointment_series_guardian_idx on public.appointment_series (guardian_user_id) where guardian_user_id is not null;
create index appointment_series_live_idx on public.appointment_series (status) where status in ('active', 'paused');

create table public.series_conflicts (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.appointment_series(id) on delete cascade,
  occurrence_date date not null,
  reason text not null check (reason in ('slot_taken', 'blocked_date', 'outside_hours')),
  resolved_at timestamptz,
  resolution text check (resolution in ('rescheduled', 'skipped', 'series_changed', 'series_paused', 'series_ended')),
  resolved_by uuid references auth.users(id) on delete set null,
  -- `Pick another time`: the appointment created for this occurrence.
  appointment_id uuid references public.appointments(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (series_id, occurrence_date),
  constraint series_conflicts_resolution check ((resolved_at is null) = (resolution is null))
);
create index series_conflicts_open_idx on public.series_conflicts (series_id, occurrence_date) where resolved_at is null;

-- ---------- appointments: series link ----------
alter table public.appointments
  add column series_id uuid references public.appointment_series(id) on delete set null,
  add column series_occurrence_date date;
-- One appointment per occurrence, whatever its status: a cancelled occurrence is never re-created by the horizon.
alter table public.appointments
  add constraint appointments_series_occurrence_unique unique (series_id, series_occurrence_date);
create index appointments_series_idx on public.appointments (series_id, lower(slot)) where series_id is not null;

-- A single occurrence moved through 030's booking_reschedule stays part of its series (the "repeats" marker, the family
-- timetable). It has no occurrence date: the cancelled original keeps the date, so the horizon never re-creates it.
create or replace function public.appointments_series_follow_reschedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.rescheduled_from is not null and new.series_id is null then
    select a.series_id into new.series_id from public.appointments a where a.id = new.rescheduled_from;
  end if;
  return new;
end;
$$;

create trigger appointments_series_follow_reschedule before insert on public.appointments
for each row when (new.rescheduled_from is not null)
execute function public.appointments_series_follow_reschedule();

-- FR-8 (no per-session messages): 036 queues `How was your visit?` 2 h after every completed appointment. For a weekly
-- series that would be a prompt after every session, so it is withdrawn in the same transaction (this trigger fires
-- after 036's `appointments_rate_prompt`: same event, name order). Series sessions stay rateable on /family/appointments.
create or replace function public.appointments_series_rate_prompt_off()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.outbox_cancel('appt:' || new.id || ':rate_prompt');
  return null;
end;
$$;

create trigger appointments_series_rate_prompt_off after update of status on public.appointments
for each row when (new.status = 'completed' and old.status is distinct from new.status and new.series_id is not null)
execute function public.appointments_series_rate_prompt_off();

-- ---------- RLS (browser/Realtime reads only; the server gates every route in lib/booking/series.ts) ----------
alter table public.appointment_series enable row level security;
alter table public.series_conflicts enable row level security;
revoke all on public.appointment_series, public.series_conflicts from public, anon, authenticated;
grant select on public.appointment_series, public.series_conflicts to authenticated;

create policy "Guardians and providers read their series" on public.appointment_series
for select to authenticated using (
  guardian_user_id = (select auth.uid())
  or exists (select 1 from public.provider_profiles p where p.id = provider_profile_id and p.user_id = (select auth.uid()))
  or exists (select 1 from public.org_members m
             where m.org_id = appointment_series.org_id and m.user_id = (select auth.uid()) and m.status = 'active'
               and m.org_role in ('owner', 'admin'))
);
create policy "Providers read their series conflicts" on public.series_conflicts
for select to authenticated using (
  exists (
    select 1 from public.appointment_series s
    where s.id = series_id and (
      exists (select 1 from public.provider_profiles p where p.id = s.provider_profile_id and p.user_id = (select auth.uid()))
      or exists (select 1 from public.org_members m
                 where m.org_id = s.org_id and m.user_id = (select auth.uid()) and m.status = 'active'
                   and m.org_role in ('owner', 'admin'))
    )
  )
);

grant select, insert, update, delete on public.appointment_series, public.series_conflicts to service_role;

-- =====================================================================================================
-- Functions. Errors use 030's booking_raise (message = code; lib/booking/series.ts maps them):
--   not_found, invalid_input, case_required, service_invalid, guardian_not_linked, starts_in_past, pause_exists,
--   already_resolved, slot_taken, blocked_date, outside_hours, too_soon.
-- =====================================================================================================

-- FR-2: owner/admin of the org, or the provider bound to the profile - always an active member of the org.
create or replace function public.series_can_manage(p_org uuid, p_profile uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.user_id = p_user and m.status = 'active'
      and (m.org_role in ('owner', 'admin')
           or exists (select 1 from public.provider_profiles p where p.id = p_profile and p.user_id = p_user))
  );
$$;

-- FR-9: the instant of an occurrence = local wall clock on that date in the series' zone (DST-safe).
create or replace function public.series_occurrence_start(p_date date, p_time time, p_tz text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (p_date + p_time) at time zone p_tz;
$$;

create or replace function public.series_lock(p_series uuid)
returns void
language sql
set search_path = ''
as $$
  -- NFR-1: one writer per series (materialize, change, pause, end). Taken before 030's provider lock, never after.
  select pg_advisory_xact_lock(hashtextextended('series:' || p_series::text, 0));
$$;

-- Inside the provider's weekly hours (or extra hours) for the mode/location? Like 030's booking_slot_valid, but a
-- series time need not sit on the duration grid (e.g. 10:00 with a 45-minute service and hours from 09:00).
create or replace function public.series_within_hours(p_profile uuid, p_mode text, p_location uuid, p_duration int, p_start timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end timestamptz := p_start + make_interval(mins => p_duration);
  v_profile_tz text;
  r record;
  v_ls timestamp;
  v_le timestamp;
  v_day date;
begin
  select time_zone into v_profile_tz from public.provider_profiles where id = p_profile;
  if v_profile_tz is null then
    return false;
  end if;
  for r in
    select ar.weekday, ar.start_time, ar.end_time, ar.valid_from, ar.valid_to, coalesce(pl.time_zone, v_profile_tz) as tz
    from public.availability_rules ar
    left join public.practice_locations pl on pl.id = ar.location_id
    where ar.provider_profile_id = p_profile
      and case when p_mode = 'in_clinic' then ar.mode in ('in_clinic', 'both') and ar.location_id = p_location
               else ar.mode in ('video', 'both') end
  loop
    v_ls := p_start at time zone r.tz;
    v_le := v_end at time zone r.tz;
    v_day := v_ls::date;
    if (extract(isodow from v_day)::int - 1) = r.weekday
       and v_day >= r.valid_from and (r.valid_to is null or v_day <= r.valid_to)
       and v_ls >= v_day + r.start_time and v_le <= v_day + r.end_time then
      return true;
    end if;
  end loop;
  for r in
    select o.date, o.start_time, o.end_time, coalesce(pl.time_zone, v_profile_tz) as tz
    from public.availability_overrides o
    left join public.practice_locations pl on pl.id = o.location_id
    where o.provider_profile_id = p_profile and o.kind = 'extra'
      and case when p_mode = 'in_clinic' then coalesce(o.mode, 'both') in ('in_clinic', 'both') and o.location_id = p_location
               else coalesce(o.mode, 'both') in ('video', 'both') end
  loop
    v_ls := p_start at time zone r.tz;
    v_le := v_end at time zone r.tz;
    if v_ls::date = r.date and v_ls >= r.date + r.start_time and v_le <= r.date + r.end_time then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- FR-3: why an occurrence cannot be booked (null = it can): blocked_date (an `unavailable` override touches it),
-- outside_hours, slot_taken (a blocking appointment, buffers included - 030's booking_conflicts).
create or replace function public.series_slot_problem(
  p_profile uuid, p_mode text, p_location uuid, p_duration int, p_buffer int, p_start timestamptz, p_except uuid default null
) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end timestamptz := p_start + make_interval(mins => p_duration);
  v_profile_tz text;
begin
  select time_zone into v_profile_tz from public.provider_profiles where id = p_profile;
  if exists (
    select 1
    from public.availability_overrides o
    left join public.practice_locations pl on pl.id = o.location_id
    where o.provider_profile_id = p_profile and o.kind = 'unavailable'
      and (o.location_id is null or o.location_id is not distinct from p_location)
      and (o.mode is null or o.mode = 'both' or o.mode = p_mode)
      and tsrange(o.date + coalesce(o.start_time, time '00:00'),
                  case when o.end_time is null then (o.date + 1)::timestamp else o.date + o.end_time end, '[)')
          && tsrange(p_start at time zone coalesce(pl.time_zone, v_profile_tz), v_end at time zone coalesce(pl.time_zone, v_profile_tz), '[)')
  ) then
    return 'blocked_date';
  end if;
  if not public.series_within_hours(p_profile, p_mode, p_location, p_duration, p_start) then
    return 'outside_hours';
  end if;
  if public.booking_conflicts(p_profile, p_start, v_end, p_buffer, p_except) then
    return 'slot_taken';
  end if;
  return null;
end;
$$;

-- Notification payload (FR-8): display values only - never the child.
create or replace function public.series_notify_payload(p_series uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'series_id', s.id,
    'provider_name', left(coalesce(s.service_snapshot ->> 'provider_name', p.display_name), 120),
    'mode', s.service_snapshot ->> 'mode',
    'time_zone', s.time_zone,
    'weekdays', to_jsonb(s.weekdays),
    'start_time', to_char(s.start_time, 'HH24:MI'),
    'starts_on', s.starts_on::text,
    'ends_on', s.ends_on::text,
    'location', left(nullif(concat_ws(', ', s.service_snapshot -> 'location' ->> 'name', s.service_snapshot -> 'location' ->> 'address'), ''), 300)
  )
  from public.appointment_series s join public.provider_profiles p on p.id = s.provider_profile_id
  where s.id = p_series;
$$;

-- One message per series change, only when the family has an app account (FR-8, D-4).
create or replace function public.series_enqueue(p_series uuid, p_topic text, p_extra jsonb, p_dedup text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_guardian uuid;
begin
  select guardian_user_id into v_guardian from public.appointment_series where id = p_series;
  if v_guardian is null then
    return null;
  end if;
  return public.outbox_enqueue(p_topic, 'appointment_series', p_series,
    public.series_notify_payload(p_series) || coalesce(p_extra, '{}'::jsonb), p_dedup, now());
end;
$$;

-- FR-8: reminders only for the next occurrence (24 h before, 030's topic and dedup key, so cancelling an occurrence
-- cancels its reminder). Video series: the Meet link (037 job) is created for the next occurrence only.
create or replace function public.series_schedule_next(p_series uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.appointment_series;
  v_id uuid;
  v_start timestamptz;
  v_meet text;
begin
  select * into s from public.appointment_series where id = p_series;
  if not found then
    return;
  end if;
  if s.guardian_user_id is not null then
    select a.id, lower(a.slot) into v_id, v_start from public.appointments a
    where a.series_id = p_series and a.status = 'confirmed' and lower(a.slot) - interval '24 hours' > now()
    order by lower(a.slot) limit 1;
    if v_id is not null then
      perform public.outbox_enqueue('appointment.reminder_day_before', 'appointment', v_id,
        public.booking_notify_payload(v_id), 'appt:' || v_id || ':r24', v_start - interval '24 hours');
    end if;
  end if;
  if s.service_snapshot ->> 'mode' = 'video' then
    v_id := null;
    select a.id, a.meet_status into v_id, v_meet from public.appointments a
    where a.series_id = p_series and a.status = 'confirmed' and lower(a.slot) > now()
    order by lower(a.slot) limit 1;
    if v_id is not null and coalesce(v_meet, 'pending') = 'pending' then
      perform public.outbox_enqueue('meet.create', 'meet', v_id, jsonb_build_object('appointment_id', v_id),
        'meet:' || v_id || ':create', now());
    end if;
  end if;
end;
$$;

-- FR-3: creates `confirmed` appointments for each occurrence up to p_until (default: 8 weeks ahead in the series'
-- zone), using the series' service snapshot. Idempotent: dates with an appointment (any status) or a conflict row are
-- skipped, and `materialized_until` makes repeated runs cheap. Clashes are recorded in series_conflicts, never booked.
-- Returns { created, conflicts: [{ date, reason }] } (new conflicts only).
create or replace function public.series_materialize(p_series uuid, p_until date default null, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.appointment_series;
  v_today date;
  v_until date;
  d date;
  v_start timestamptz;
  v_duration int;
  v_buffer int;
  v_mode text;
  v_location uuid;
  v_problem text;
  v_id uuid;
  v_created int := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_locked boolean := false;
begin
  perform public.series_lock(p_series);
  select * into s from public.appointment_series where id = p_series;
  if not found then
    perform public.booking_raise('not_found');
  end if;
  if s.status = 'ended' then
    return jsonb_build_object('created', 0, 'conflicts', v_conflicts);
  end if;

  v_today := (now() at time zone s.time_zone)::date;
  v_until := coalesce(p_until, v_today + 56);
  if s.ends_on is not null then
    v_until := least(v_until, s.ends_on);
  end if;
  d := greatest(s.starts_on, v_today, coalesce(s.materialized_until + 1, s.starts_on));
  v_duration := (s.service_snapshot ->> 'duration_min')::int;
  v_buffer := coalesce((s.service_snapshot ->> 'buffer_min')::int, 0);
  v_mode := s.service_snapshot ->> 'mode';
  v_location := nullif(s.service_snapshot -> 'location' ->> 'id', '')::uuid;

  while d <= v_until loop
    if (extract(isodow from d)::int - 1) = any (s.weekdays)
       and not (s.paused_from is not null and d between s.paused_from and s.paused_until) then
      v_start := public.series_occurrence_start(d, s.start_time, s.time_zone);
      if v_start > now()
         and not exists (select 1 from public.appointments a where a.series_id = s.id and a.series_occurrence_date = d)
         and not exists (select 1 from public.series_conflicts c where c.series_id = s.id and c.occurrence_date = d) then
        if not v_locked then
          -- 030: serialise with holds/reschedules of this provider so the buffer check sees them.
          perform public.booking_lock_provider(s.provider_profile_id);
          perform public.booking_expire_stale(s.provider_profile_id);
          v_locked := true;
        end if;
        v_problem := public.series_slot_problem(s.provider_profile_id, v_mode, v_location, v_duration, v_buffer, v_start, null);
        if v_problem is null then
          begin
            insert into public.appointments (
              provider_profile_id, org_id, service_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status,
              series_id, series_occurrence_date, meet_status
            ) values (
              s.provider_profile_id, s.org_id, s.service_id, s.service_snapshot, s.child_id, s.guardian_user_id, s.case_id,
              tstzrange(v_start, v_start + make_interval(mins => v_duration), '[)'), 'confirmed',
              s.id, d, case when v_mode = 'video' then 'pending' else 'not_needed' end
            ) returning id into v_id;
            perform public.booking_log(v_id, null, 'confirmed', p_actor, case when p_actor is null then 'system' else 'provider' end,
              'series:' || s.id);
            v_created := v_created + 1;
          exception when exclusion_violation then
            v_problem := 'slot_taken';
          end;
        end if;
        if v_problem is not null then
          insert into public.series_conflicts (series_id, occurrence_date, reason) values (s.id, d, v_problem)
          on conflict (series_id, occurrence_date) do nothing;
          v_conflicts := v_conflicts || jsonb_build_object('date', d::text, 'reason', v_problem);
        end if;
      end if;
    end if;
    d := d + 1;
  end loop;

  if s.materialized_until is null or s.materialized_until < v_until then
    update public.appointment_series set materialized_until = v_until where id = s.id;
  end if;
  perform public.series_schedule_next(s.id);
  return jsonb_build_object('created', v_created, 'conflicts', v_conflicts);
end;
$$;

-- Cancels future occurrences of a series through 030's booking_cancel (state history, reminders, payments, Meet
-- clean-up all as usual) but suppresses the per-occurrence `appointment.cancelled` message: the family gets one
-- message for the whole change (FR-8). p_mode: 'untouched' (still at the series time, "this and future"),
-- 'all'. Dates are the occurrence date (moved occurrences: their local start date). Past rows are never touched.
create or replace function public.series_cancel_range(
  p_series uuid, p_from date, p_to date, p_mode text, p_actor uuid, p_reason text
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.appointment_series;
  r record;
  v_count int := 0;
begin
  select * into s from public.appointment_series where id = p_series;
  for r in
    select a.id from public.appointments a
    where a.series_id = p_series and a.status = 'confirmed' and lower(a.slot) > now()
      and coalesce(a.series_occurrence_date, (lower(a.slot) at time zone s.time_zone)::date) >= p_from
      and (p_to is null or coalesce(a.series_occurrence_date, (lower(a.slot) at time zone s.time_zone)::date) <= p_to)
      and (p_mode = 'all' or (
        a.series_occurrence_date is not null
        and lower(a.slot) = public.series_occurrence_start(a.series_occurrence_date, s.start_time, s.time_zone)))
    order by lower(a.slot)
  loop
    perform public.booking_cancel(r.id, p_actor, 'provider', p_reason);
    perform public.outbox_cancel('appt:' || r.id || ':cancelled');
    v_count := v_count + 1;
  end loop;
  update public.series_conflicts
  set resolved_at = now(), resolution = p_reason, resolved_by = p_actor
  where series_id = p_series and resolved_at is null and occurrence_date >= p_from and (p_to is null or occurrence_date <= p_to);
  return v_count;
end;
$$;

-- FR-2 + FR-3: create a series (validated), materialize it at once and send one summary message (FR-8).
-- p_guardian: an actively linked guardian of the child, or null (paper-consent family: no messages).
-- p_notify false = no summary (used by "this and future", which sends one change message instead).
create or replace function public.series_create(
  p_actor uuid, p_org uuid, p_profile uuid, p_service uuid, p_child uuid, p_case uuid, p_guardian uuid,
  p_weekdays smallint[], p_start_time time, p_starts_on date, p_ends_on date, p_billing text,
  p_notify boolean default true, p_replaces uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sv public.services;
  p public.provider_profiles;
  loc public.practice_locations;
  v_case uuid;
  v_tz text;
  v_id uuid;
  v_result jsonb;
begin
  if not public.series_can_manage(p_org, p_profile, p_actor) then
    perform public.booking_raise('not_found');
  end if;
  if not public.series_weekdays_valid(p_weekdays) or p_start_time is null or p_starts_on is null
     or (p_ends_on is not null and p_ends_on < p_starts_on)
     or p_billing is null or p_billing not in ('package', 'per_session', 'free') then
    perform public.booking_raise('invalid_input');
  end if;
  select * into p from public.provider_profiles where id = p_profile and not is_synthetic;
  select * into sv from public.services
  where id = p_service and org_id = p_org and provider_profile_id = p_profile and active and mode in ('in_clinic', 'video');
  if p.id is null or sv.id is null then
    perform public.booking_raise('service_invalid');
  end if;
  -- Rule 2: the child must have a case in this org (the episode of care the timetable belongs to).
  select c.id into v_case from public.cases c join public.children ch on ch.id = c.child_id and ch.deleted_at is null
  where c.child_id = p_child and c.org_id = p_org and (p_case is null or c.id = p_case)
  order by (c.id = p_case) desc nulls last, c.created_at desc limit 1;
  if v_case is null then
    perform public.booking_raise('case_required');
  end if;
  if p_guardian is not null and not exists (
    select 1 from public.guardian_links gl join public.user_profiles u on u.id = gl.user_id and u.role = 'guardian'
    where gl.child_id = p_child and gl.user_id = p_guardian and gl.status = 'active'
  ) then
    perform public.booking_raise('guardian_not_linked');
  end if;
  if sv.location_id is not null then
    select * into loc from public.practice_locations where id = sv.location_id;
  end if;
  v_tz := coalesce(loc.time_zone, p.time_zone);
  if p_starts_on < (now() at time zone v_tz)::date then
    perform public.booking_raise('starts_in_past');
  end if;

  insert into public.appointment_series (
    org_id, provider_profile_id, service_id, service_snapshot, child_id, case_id, guardian_user_id, weekdays, start_time,
    time_zone, starts_on, ends_on, billing_mode, replaces_series_id, created_by
  ) values (
    p_org, p_profile, sv.id,
    jsonb_build_object(
      'name', sv.name, 'duration_min', sv.duration_min, 'mode', sv.mode,
      'fee_inr', case when p_billing = 'free' then 0 else sv.fee_inr end,
      'payment_mode', case when p_billing = 'free' then 'free' else sv.payment_mode end,
      'buffer_min', sv.buffer_min, 'intake_kind', 'none', 'billing_mode', p_billing,
      'provider_name', p.display_name, 'time_zone', v_tz,
      'location', case when loc.id is null then null else jsonb_build_object(
        'id', loc.id, 'name', loc.name,
        'address', concat_ws(', ', loc.address_line1, loc.address_line2, loc.locality, loc.city || ' ' || loc.pincode),
        'lat', loc.lat, 'lng', loc.lng, 'time_zone', loc.time_zone) end
    ),
    p_child, v_case, p_guardian, p_weekdays, p_start_time, v_tz, p_starts_on, p_ends_on, p_billing, p_replaces, p_actor
  ) returning id into v_id;

  v_result := public.series_materialize(v_id, null, p_actor);
  if p_notify then
    perform public.series_enqueue(v_id, 'series.created', null, 'series:' || v_id || ':created');
  end if;
  return v_result || jsonb_build_object('series_id', v_id);
end;
$$;

-- FR-5 "This and future sessions": the current series ends the day before p_from, its future untouched occurrences
-- are cancelled (reason series_changed), and a new series continues from p_from with the changed fields (null =
-- unchanged; p_ends_on null keeps the old end). One change message to the family.
create or replace function public.series_change_from(
  p_series uuid, p_actor uuid, p_from date, p_profile uuid, p_service uuid, p_weekdays smallint[], p_start_time time,
  p_ends_on date, p_clear_end boolean, p_billing text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.appointment_series;
  v_cancelled int;
  v_new jsonb;
  v_new_id uuid;
  v_today date;
begin
  perform public.series_lock(p_series);
  select * into s from public.appointment_series where id = p_series;
  if not found or not public.series_can_manage(s.org_id, s.provider_profile_id, p_actor) then
    perform public.booking_raise('not_found');
  end if;
  if s.status = 'ended' then
    perform public.booking_raise('invalid_transition');
  end if;
  v_today := (now() at time zone s.time_zone)::date;
  if p_from is null or p_from < v_today or p_from < s.starts_on or (s.ends_on is not null and p_from > s.ends_on) then
    perform public.booking_raise('invalid_input');
  end if;
  -- The new therapist must be manageable by the caller too (series_create re-checks with the new profile).
  v_cancelled := public.series_cancel_range(p_series, p_from, null, 'untouched', p_actor, 'series_changed');
  update public.appointment_series
  set ends_on = p_from - 1, status = case when p_from - 1 < v_today then 'ended' else status end, updated_at = now()
  where id = p_series;

  v_new := public.series_create(
    p_actor, s.org_id, coalesce(p_profile, s.provider_profile_id), coalesce(p_service, s.service_id), s.child_id, s.case_id,
    s.guardian_user_id, coalesce(p_weekdays, s.weekdays), coalesce(p_start_time, s.start_time), p_from,
    case when p_clear_end then null else coalesce(p_ends_on, s.ends_on) end, coalesce(p_billing, s.billing_mode),
    false, s.id);
  v_new_id := (v_new ->> 'series_id')::uuid;
  perform public.series_enqueue(v_new_id, 'series.changed', jsonb_build_object('change', 'time_changed', 'date', p_from::text),
    'series:' || s.id || ':changed:' || v_new_id);
  return v_new || jsonb_build_object('cancelled', v_cancelled, 'replaced_series_id', s.id);
end;
$$;

-- FR-5 Pause: cancels the occurrences in [p_from, p_to] (reason series_paused) and keeps the horizon from creating
-- them. One pause window at a time. One message to the family.
create or replace function public.series_pause(p_series uuid, p_actor uuid, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.appointment_series;
  v_today date;
  v_cancelled int;
begin
  perform public.series_lock(p_series);
  select * into s from public.appointment_series where id = p_series;
  if not found or not public.series_can_manage(s.org_id, s.provider_profile_id, p_actor) then
    perform public.booking_raise('not_found');
  end if;
  if s.status = 'ended' then
    perform public.booking_raise('invalid_transition');
  end if;
  v_today := (now() at time zone s.time_zone)::date;
  if p_from is null or p_to is null or p_from < v_today or p_to < p_from or p_to > p_from + 366 then
    perform public.booking_raise('invalid_input');
  end if;
  if s.paused_until is not null and s.paused_until >= v_today then
    perform public.booking_raise('pause_exists');
  end if;
  v_cancelled := public.series_cancel_range(p_series, p_from, p_to, 'all', p_actor, 'series_paused');
  update public.appointment_series
  set paused_from = p_from, paused_until = p_to, status = 'paused', updated_at = now()
  where id = p_series;
  perform public.series_enqueue(p_series, 'series.changed',
    jsonb_build_object('change', 'paused', 'date', p_from::text, 'until', p_to::text),
    'series:' || p_series || ':paused:' || p_from || ':' || p_to);
  return jsonb_build_object('series_id', p_series, 'cancelled', v_cancelled);
end;
$$;

-- FR-5 End: no occurrences after p_ends_on (default today); later ones are cancelled. One message to the family.
create or replace function public.series_end(p_series uuid, p_actor uuid, p_ends_on date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.appointment_series;
  v_today date;
  v_end date;
  v_cancelled int;
begin
  perform public.series_lock(p_series);
  select * into s from public.appointment_series where id = p_series;
  if not found or not public.series_can_manage(s.org_id, s.provider_profile_id, p_actor) then
    perform public.booking_raise('not_found');
  end if;
  if s.status = 'ended' then
    perform public.booking_raise('invalid_transition');
  end if;
  v_today := (now() at time zone s.time_zone)::date;
  v_end := coalesce(p_ends_on, v_today);
  if v_end < v_today - 1 then
    perform public.booking_raise('invalid_input');
  end if;
  v_cancelled := public.series_cancel_range(p_series, v_end + 1, null, 'all', p_actor, 'series_ended');
  update public.appointment_series
  set ends_on = greatest(v_end, starts_on - 1), status = case when v_end < v_today or v_end < starts_on then 'ended' else status end,
      updated_at = now()
  where id = p_series;
  perform public.series_enqueue(p_series, 'series.changed', jsonb_build_object('change', 'ended', 'date', v_end::text),
    'series:' || p_series || ':ended:' || v_end);
  return jsonb_build_object('series_id', p_series, 'cancelled', v_cancelled);
end;
$$;

-- FR-6 Conflicts: `Skip this date` (no session that day) or `Pick another time` (a confirmed appointment for that
-- occurrence at p_start, checked like any occurrence: hours, blocked dates, clashes). One message to the family.
create or replace function public.series_resolve_conflict(p_conflict uuid, p_actor uuid, p_action text, p_start timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.series_conflicts;
  s public.appointment_series;
  v_series uuid;
  v_problem text;
  v_duration int;
  v_id uuid;
begin
  select series_id into v_series from public.series_conflicts where id = p_conflict;
  if v_series is null then
    perform public.booking_raise('not_found');
  end if;
  perform public.series_lock(v_series);
  select * into s from public.appointment_series where id = v_series;
  if not public.series_can_manage(s.org_id, s.provider_profile_id, p_actor) then
    perform public.booking_raise('not_found');
  end if;
  select * into c from public.series_conflicts where id = p_conflict for update;
  if c.resolved_at is not null then
    perform public.booking_raise('already_resolved');
  end if;

  if p_action = 'skip' then
    update public.series_conflicts set resolved_at = now(), resolution = 'skipped', resolved_by = p_actor where id = c.id;
    perform public.series_enqueue(s.id, 'series.changed', jsonb_build_object('change', 'skipped', 'date', c.occurrence_date::text),
      'series:' || s.id || ':conflict:' || c.id || ':skipped');
    return jsonb_build_object('conflict_id', c.id, 'resolution', 'skipped');
  end if;
  if p_action <> 'reschedule' or p_start is null then
    perform public.booking_raise('invalid_input');
  end if;
  if p_start < now() + interval '1 hour' then
    perform public.booking_raise('too_soon');
  end if;
  if p_start > now() + interval '120 days' then
    perform public.booking_raise('invalid_input');
  end if;

  v_duration := (s.service_snapshot ->> 'duration_min')::int;
  perform public.booking_lock_provider(s.provider_profile_id);
  perform public.booking_expire_stale(s.provider_profile_id);
  v_problem := public.series_slot_problem(s.provider_profile_id, s.service_snapshot ->> 'mode',
    nullif(s.service_snapshot -> 'location' ->> 'id', '')::uuid, v_duration,
    coalesce((s.service_snapshot ->> 'buffer_min')::int, 0), p_start, null);
  if v_problem is not null then
    perform public.booking_raise(v_problem);
  end if;
  begin
    insert into public.appointments (
      provider_profile_id, org_id, service_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status,
      series_id, series_occurrence_date, meet_status
    ) values (
      s.provider_profile_id, s.org_id, s.service_id, s.service_snapshot, s.child_id, s.guardian_user_id, s.case_id,
      tstzrange(p_start, p_start + make_interval(mins => v_duration), '[)'), 'confirmed', s.id, c.occurrence_date,
      case when s.service_snapshot ->> 'mode' = 'video' then 'pending' else 'not_needed' end
    ) returning id into v_id;
  exception
    when exclusion_violation then
      perform public.booking_raise('slot_taken');
    when unique_violation then
      perform public.booking_raise('already_resolved');
  end;
  perform public.booking_log(v_id, null, 'confirmed', p_actor, 'provider', 'series:' || s.id || ':conflict');
  update public.series_conflicts
  set resolved_at = now(), resolution = 'rescheduled', resolved_by = p_actor, appointment_id = v_id
  where id = c.id;
  perform public.series_enqueue(s.id, 'series.changed',
    jsonb_build_object('change', 'moved', 'date', c.occurrence_date::text,
                       'new_start', to_char(p_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'series:' || s.id || ':conflict:' || c.id || ':moved');
  perform public.series_schedule_next(s.id);
  return jsonb_build_object('conflict_id', c.id, 'resolution', 'rescheduled', 'appointment_id', v_id);
end;
$$;

-- Cron housekeeping: a pause window that has passed -> active; a series past its end date -> ended. Returns the
-- live series ids to materialize (oldest horizon first).
create or replace function public.series_due(p_limit int default 2000)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.appointment_series
  set status = 'active', updated_at = now()
  where status = 'paused' and paused_until < (now() at time zone time_zone)::date;
  update public.appointment_series
  set status = 'ended', updated_at = now()
  where status in ('active', 'paused') and ends_on is not null and ends_on < (now() at time zone time_zone)::date;
  return query
    select id from public.appointment_series
    where status in ('active', 'paused')
    order by materialized_until nulls first, id
    limit greatest(1, least(p_limit, 10000));
end;
$$;

-- 041 erasure (`everything`): future occurrences are cancelled without per-occurrence messages, then the child's
-- series (and their conflicts) are deleted. 030's booking_erase_child then detaches the child from the appointments.
create or replace function public.series_erase_child(p_child uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_count int := 0;
begin
  for r in
    select a.id from public.appointments a join public.appointment_series s on s.id = a.series_id
    where s.child_id = p_child and a.status = 'confirmed' and lower(a.slot) > now()
    for update of a
  loop
    perform public.booking_cancel(r.id, null, 'system', 'erasure');
    perform public.outbox_cancel('appt:' || r.id || ':cancelled');
  end loop;
  delete from public.appointment_series where child_id = p_child;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- grants: the server (service role) only ----------
revoke all on function public.series_weekdays_valid(smallint[]) from public, anon, authenticated;
revoke all on function public.appointments_series_follow_reschedule() from public, anon, authenticated;
revoke all on function public.appointments_series_rate_prompt_off() from public, anon, authenticated;
revoke all on function public.series_can_manage(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.series_occurrence_start(date, time, text) from public, anon, authenticated;
revoke all on function public.series_lock(uuid) from public, anon, authenticated;
revoke all on function public.series_within_hours(uuid, text, uuid, int, timestamptz) from public, anon, authenticated;
revoke all on function public.series_slot_problem(uuid, text, uuid, int, int, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.series_notify_payload(uuid) from public, anon, authenticated;
revoke all on function public.series_enqueue(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.series_schedule_next(uuid) from public, anon, authenticated;
revoke all on function public.series_materialize(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.series_cancel_range(uuid, date, date, text, uuid, text) from public, anon, authenticated;
revoke all on function public.series_create(uuid, uuid, uuid, uuid, uuid, uuid, uuid, smallint[], time, date, date, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.series_change_from(uuid, uuid, date, uuid, uuid, smallint[], time, date, boolean, text) from public, anon, authenticated;
revoke all on function public.series_pause(uuid, uuid, date, date) from public, anon, authenticated;
revoke all on function public.series_end(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.series_resolve_conflict(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.series_due(int) from public, anon, authenticated;
revoke all on function public.series_erase_child(uuid) from public, anon, authenticated;

grant execute on function public.series_weekdays_valid(smallint[]) to service_role;
grant execute on function public.series_can_manage(uuid, uuid, uuid) to service_role;
grant execute on function public.series_occurrence_start(date, time, text) to service_role;
grant execute on function public.series_within_hours(uuid, text, uuid, int, timestamptz) to service_role;
grant execute on function public.series_slot_problem(uuid, text, uuid, int, int, timestamptz, uuid) to service_role;
grant execute on function public.series_notify_payload(uuid) to service_role;
grant execute on function public.series_schedule_next(uuid) to service_role;
grant execute on function public.series_materialize(uuid, date, uuid) to service_role;
grant execute on function public.series_create(uuid, uuid, uuid, uuid, uuid, uuid, uuid, smallint[], time, date, date, text, boolean, uuid) to service_role;
grant execute on function public.series_change_from(uuid, uuid, date, uuid, uuid, smallint[], time, date, boolean, text) to service_role;
grant execute on function public.series_pause(uuid, uuid, date, date) to service_role;
grant execute on function public.series_end(uuid, uuid, date) to service_role;
grant execute on function public.series_resolve_conflict(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.series_due(int) to service_role;
grant execute on function public.series_erase_child(uuid) to service_role;
