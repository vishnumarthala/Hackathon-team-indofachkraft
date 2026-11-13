-- 030: availability and atomic one-off booking (design rules 10, 11, 12).
-- Additive only: services, weekly availability rules, date overrides, appointments with a btree_gist exclusion
-- constraint on (provider, half-open slot) over the blocking statuses, an append-only state history, and one
-- security-definer SQL function per state transition (each a single transaction, service role only).
-- Times are stored as timestamptz; slots are half-open `[start, end)` ranges. Rule and override times are
-- wall-clock times in the location's time zone (video-only: the provider profile's time zone).

create extension if not exists btree_gist with schema extensions;

-- ---------- services ----------
create table public.services (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  mode text not null check (mode in ('in_clinic', 'video')),
  duration_min int not null check (duration_min in (15, 20, 30, 45, 60, 90)),
  fee_inr int not null default 0 check (fee_inr between 0 and 100000),
  payment_mode text not null check (payment_mode in ('online', 'at_clinic', 'free')),
  buffer_min int not null default 0 check (buffer_min between 0 and 30),
  -- 035: which pre-consult intake the appointment triggers.
  intake_kind text not null default 'none' check (intake_kind in ('child_dev', 'generic', 'none')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (location_id, org_id) references public.practice_locations(id, org_id) on delete cascade,
  constraint services_in_clinic_location check (mode <> 'in_clinic' or location_id is not null),
  constraint services_free_fee check (payment_mode <> 'free' or fee_inr = 0)
);
create index services_profile_idx on public.services (provider_profile_id) where active;

-- ---------- weekly availability ----------
create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid,
  weekday int not null check (weekday between 0 and 6), -- 0 = Monday
  start_time time not null,
  end_time time not null,
  mode text not null check (mode in ('in_clinic', 'video', 'both')),
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  foreign key (location_id, org_id) references public.practice_locations(id, org_id) on delete cascade,
  constraint availability_rules_times check (start_time < end_time),
  constraint availability_rules_validity check (valid_to is null or valid_to >= valid_from),
  constraint availability_rules_location check (mode = 'video' or location_id is not null)
);
create index availability_rules_profile_idx on public.availability_rules (provider_profile_id, weekday);

-- `unavailable` with null times = the whole day. `location_id`/`mode` null = every location/mode. Extra hours
-- need a mode (and a location unless video). Wall-clock in the location's (else the profile's) time zone.
create table public.availability_overrides (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('unavailable', 'extra')),
  start_time time,
  end_time time,
  mode text check (mode in ('in_clinic', 'video', 'both')),
  location_id uuid references public.practice_locations(id) on delete cascade,
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  constraint availability_overrides_pair check ((start_time is null) = (end_time is null)),
  constraint availability_overrides_times check (start_time is null or start_time < end_time),
  constraint availability_overrides_extra check (
    kind = 'unavailable' or (start_time is not null and mode is not null and (mode = 'video' or location_id is not null))
  )
);
create index availability_overrides_profile_idx on public.availability_overrides (provider_profile_id, date);

-- ---------- appointments ----------
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  -- Rule 11: what was booked, frozen at hold time (later service edits never change an appointment).
  service_snapshot jsonb not null,
  child_id uuid references public.children(id) on delete set null,
  guardian_user_id uuid references auth.users(id) on delete set null,
  case_id uuid references public.cases(id) on delete set null, -- 035
  slot tstzrange not null,
  status text not null check (status in ('held', 'pending_payment', 'confirmed', 'cancelled', 'expired', 'completed', 'no_show')),
  hold_owner_user_id uuid references auth.users(id) on delete set null,
  -- sha256 (hex) of an anonymous booking-session id (web cookie, 034 voice agent session); never the raw id.
  hold_owner_session text check (hold_owner_session ~ '^[0-9a-f]{64}$'),
  hold_expires_at timestamptz,
  cancelled_by text check (cancelled_by in ('guardian', 'provider', 'system')),
  cancel_reason text check (char_length(cancel_reason) <= 300),
  rescheduled_from uuid references public.appointments(id) on delete set null,
  -- First appointment of a reschedule chain: the calendar (.ics) UID stays the same across reschedules.
  origin_appointment_id uuid references public.appointments(id) on delete set null,
  -- Namespaced by owner inside booking_hold (`u:<user>:<key>` / `s:<session hash>:<key>`).
  idempotency_key text unique check (char_length(idempotency_key) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_slot_half_open check (lower(slot) < upper(slot) and lower_inc(slot) and not upper_inc(slot)),
  constraint appointments_hold_expiry check (status not in ('held', 'pending_payment') or hold_expires_at is not null),
  -- Rule 10: double booking is impossible by construction.
  constraint appointments_no_overlap exclude using gist (provider_profile_id with =, slot with &&)
    where (status in ('held', 'pending_payment', 'confirmed'))
);
create index appointments_profile_start_idx on public.appointments (provider_profile_id, lower(slot));
create index appointments_guardian_idx on public.appointments (guardian_user_id, lower(slot));
create index appointments_child_idx on public.appointments (child_id) where child_id is not null;
create index appointments_hold_expiry_idx on public.appointments (hold_expires_at) where status in ('held', 'pending_payment');
create index appointments_hold_user_idx on public.appointments (hold_owner_user_id) where status = 'held';
create index appointments_hold_session_idx on public.appointments (hold_owner_session) where status = 'held';

-- State history (append-only). Rows go only with their appointment (cascade, e.g. privacy erasure).
create table public.appointment_events (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('guardian', 'provider', 'system', 'anonymous')),
  reason text check (char_length(reason) <= 300),
  created_at timestamptz not null default now()
);
create index appointment_events_appointment_idx on public.appointment_events (appointment_id, id);

create or replace function public.appointment_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A direct delete runs this trigger at depth 1; a cascade from appointments runs inside the FK trigger (depth 2).
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'appointment_events is append-only';
end;
$$;

create trigger appointment_events_append_only
before update or delete on public.appointment_events
for each row execute procedure public.appointment_events_append_only();

-- ---------- consistency triggers ----------
-- In-clinic services, rules and extra hours must use a location the provider practises at (028 provider_locations).
create or replace function public.booking_check_location()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.location_id is not null and not exists (
    select 1 from public.provider_locations pl
    where pl.provider_profile_id = new.provider_profile_id and pl.location_id = new.location_id
  ) then
    raise exception 'location_not_linked' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger services_check_location before insert or update of location_id, provider_profile_id on public.services
for each row execute procedure public.booking_check_location();
create trigger availability_rules_check_location before insert or update of location_id, provider_profile_id on public.availability_rules
for each row execute procedure public.booking_check_location();
create trigger availability_overrides_check_location before insert or update of location_id, provider_profile_id on public.availability_overrides
for each row execute procedure public.booking_check_location();

-- 028/029 consultation modes are derived from active services once a provider has any service (FR-8). Profiles
-- without services (seeded listings) keep the flags set by the editor/admin.
create or replace function public.booking_derived_modes(p_profile uuid, out has_services boolean, out offers_video boolean, out offers_in_clinic boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) > 0,
         coalesce(bool_or(active and mode = 'video'), false),
         coalesce(bool_or(active and mode = 'in_clinic'), false)
  from public.services where provider_profile_id = p_profile;
$$;

create or replace function public.services_refresh_modes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid := coalesce(new.provider_profile_id, old.provider_profile_id);
  m record;
begin
  select * into m from public.booking_derived_modes(v_profile);
  update public.provider_profiles
  set offers_video = case when m.has_services then m.offers_video else offers_video end,
      offers_in_clinic = case when m.has_services then m.offers_in_clinic else offers_in_clinic end
  where id = v_profile
    and m.has_services
    and (offers_video is distinct from m.offers_video or offers_in_clinic is distinct from m.offers_in_clinic);
  return null;
end;
$$;

create trigger services_refresh_modes after insert or update or delete on public.services
for each row execute procedure public.services_refresh_modes();

create or replace function public.provider_profiles_derive_modes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  if new.offers_video is distinct from old.offers_video or new.offers_in_clinic is distinct from old.offers_in_clinic then
    select * into m from public.booking_derived_modes(new.id);
    if m.has_services then
      new.offers_video := m.offers_video;
      new.offers_in_clinic := m.offers_in_clinic;
    end if;
  end if;
  return new;
end;
$$;

create trigger provider_profiles_derive_modes before update of offers_video, offers_in_clinic on public.provider_profiles
for each row execute procedure public.provider_profiles_derive_modes();

-- ---------- RLS (browser/Realtime reads only; the server gates every route in lib/booking + lib/authz.ts) ----------
alter table public.services enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_overrides enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_events enable row level security;

grant select on public.services, public.availability_rules, public.availability_overrides, public.appointments to authenticated;

create policy "Providers read their own services" on public.services
for select to authenticated using (
  exists (select 1 from public.provider_profiles p where p.id = provider_profile_id and p.user_id = (select auth.uid()))
);
create policy "Providers read their own availability" on public.availability_rules
for select to authenticated using (
  exists (select 1 from public.provider_profiles p where p.id = provider_profile_id and p.user_id = (select auth.uid()))
);
create policy "Providers read their own overrides" on public.availability_overrides
for select to authenticated using (
  exists (select 1 from public.provider_profiles p where p.id = provider_profile_id and p.user_id = (select auth.uid()))
);
create policy "Guardians and providers read their appointments" on public.appointments
for select to authenticated using (
  guardian_user_id = (select auth.uid())
  or exists (select 1 from public.provider_profiles p where p.id = provider_profile_id and p.user_id = (select auth.uid()))
);

revoke insert, update, delete, truncate on public.appointment_events from public, anon, authenticated;

-- =====================================================================================================
-- State machine (FR-3). Errors are raised with the code as the message (lib/booking/errors.ts maps them):
--   slot_taken, slot_unavailable, too_soon, too_far, service_not_found, not_found, invalid_transition,
--   hold_expired, child_required, child_not_linked, not_guardian, too_late, not_started, invalid_owner,
--   idempotency_mismatch, invalid_status.
-- Blocking statuses: held, pending_payment, confirmed.
-- =====================================================================================================

create or replace function public.booking_raise(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using message = p_code, errcode = 'P0001', hint = 'booking';
end;
$$;

create or replace function public.booking_lock_provider(p_profile uuid)
returns void
language sql
set search_path = ''
as $$
  -- Serialises writes per provider so the buffer check and the insert see each other; the exclusion constraint
  -- stays the hard guarantee for the slot itself.
  select pg_advisory_xact_lock(hashtextextended('booking:' || p_profile::text, 0));
$$;

create or replace function public.booking_log(p_appointment uuid, p_from text, p_to text, p_actor uuid, p_kind text, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.appointment_events (appointment_id, from_status, to_status, actor_user_id, actor_kind, reason)
  values (p_appointment, p_from, p_to, p_actor, p_kind, left(p_reason, 300));
$$;

-- Is the slot inside the provider's published availability? Mirrors lib/booking/slots.ts (kept in sync by tests):
-- a weekly rule (weekday, validity, mode/location) or extra hours on that date, aligned to the duration from the
-- window start, not touched by an `unavailable` override.
create or replace function public.booking_slot_valid(p_profile uuid, p_mode text, p_location uuid, p_duration int, p_start timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end timestamptz := p_start + make_interval(mins => p_duration);
  v_profile_tz text;
  v_ok boolean := false;
  r record;
  v_ls timestamp;
  v_le timestamp;
  v_day date;
  v_ws timestamp;
  v_we timestamp;
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
    v_ws := v_day + r.start_time;
    v_we := v_day + r.end_time;
    if (extract(isodow from v_day)::int - 1) = r.weekday
       and v_day >= r.valid_from and (r.valid_to is null or v_day <= r.valid_to)
       and v_ls >= v_ws and v_le <= v_we
       and mod(extract(epoch from (v_ls - v_ws))::bigint, p_duration * 60) = 0 then
      v_ok := true;
      exit;
    end if;
  end loop;

  if not v_ok then
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
      v_ws := r.date + r.start_time;
      v_we := r.date + r.end_time;
      if v_ls::date = r.date and v_ls >= v_ws and v_le <= v_we
         and mod(extract(epoch from (v_ls - v_ws))::bigint, p_duration * 60) = 0 then
        v_ok := true;
        exit;
      end if;
    end loop;
  end if;

  if not v_ok then
    return false;
  end if;

  return not exists (
    select 1
    from public.availability_overrides o
    left join public.practice_locations pl on pl.id = o.location_id
    where o.provider_profile_id = p_profile and o.kind = 'unavailable'
      and (o.location_id is null or o.location_id is not distinct from p_location)
      and (o.mode is null or o.mode = 'both' or o.mode = p_mode)
      and tsrange(o.date + coalesce(o.start_time, time '00:00'),
                  case when o.end_time is null then (o.date + 1)::timestamp else o.date + o.end_time end, '[)')
          && tsrange(p_start at time zone coalesce(pl.time_zone, v_profile_tz), v_end at time zone coalesce(pl.time_zone, v_profile_tz), '[)')
  );
end;
$$;

-- Does [p_start, p_end) (plus its buffer) collide with a blocking appointment of the provider (plus theirs)?
-- Holds whose expiry passed do not count (they are expired in the same transaction).
create or replace function public.booking_conflicts(p_profile uuid, p_start timestamptz, p_end timestamptz, p_buffer int, p_except uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appointments a
    where a.provider_profile_id = p_profile
      and a.id is distinct from p_except
      and (a.status = 'confirmed' or (a.status in ('held', 'pending_payment') and a.hold_expires_at > now()))
      and p_start < upper(a.slot) + make_interval(mins => coalesce((a.service_snapshot ->> 'buffer_min')::int, 0))
      and lower(a.slot) < p_end + make_interval(mins => p_buffer)
  );
$$;

-- Expires stale holds/pending payments (hold_expires_at passed). Rows locked by another transaction are skipped
-- (it is expiring or changing them). Optionally only one provider's.
create or replace function public.booking_expire_stale(p_profile uuid default null, p_limit int default 1000)
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
    select id, status from public.appointments
    where status in ('held', 'pending_payment') and hold_expires_at < now()
      and (p_profile is null or provider_profile_id = p_profile)
    order by hold_expires_at
    limit greatest(1, least(p_limit, 10000))
    for update skip locked
  loop
    update public.appointments set status = 'expired', updated_at = now() where id = r.id;
    perform public.booking_log(r.id, r.status, 'expired', null, 'system', 'hold_expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Notification payload: small, non-clinical values for the templates (no child name, no clinical content).
create or replace function public.booking_notify_payload(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'appointment_id', a.id,
    'starts_at', to_char(lower(a.slot) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ends_at', to_char(upper(a.slot) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'provider_name', left(coalesce(a.service_snapshot ->> 'provider_name', p.display_name), 120),
    'mode', a.service_snapshot ->> 'mode',
    'time_zone', coalesce(a.service_snapshot ->> 'time_zone', p.time_zone),
    'location', left(nullif(concat_ws(', ', a.service_snapshot -> 'location' ->> 'name', a.service_snapshot -> 'location' ->> 'address'), ''), 300)
  )
  from public.appointments a join public.provider_profiles p on p.id = a.provider_profile_id
  where a.id = p_id;
$$;

-- Confirmation + reminders (rule 12: in the confirming transaction). Reminders are scheduled only while still in
-- the future. Topic names have no digits (032's outbox_events_topic_check), so FR-6's reminder_24h / reminder_2h are
-- `appointment.reminder_day_before` / `appointment.reminder_two_hours`; the dedup keys keep `r24` / `r2`.
-- Dedup keys share the prefix `appt:<id>:` so cancel/reschedule can cancel them (outbox_cancel).
-- 031 calls this when a payment completes (pending_payment -> confirmed).
create or replace function public.booking_enqueue_confirmed(p_id uuid, p_topic text default 'appointment.confirmed', p_suffix text default 'confirmed')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_payload jsonb := public.booking_notify_payload(p_id);
  v_aggregate uuid;
  v_event bigint;
begin
  select * into a from public.appointments where id = p_id;
  v_aggregate := coalesce(a.origin_appointment_id, a.id);
  v_event := public.outbox_enqueue(p_topic, 'appointment', v_aggregate, v_payload, 'appt:' || a.id || ':' || p_suffix, now());
  if lower(a.slot) - interval '24 hours' > now() then
    perform public.outbox_enqueue('appointment.reminder_day_before', 'appointment', v_aggregate, v_payload,
      'appt:' || a.id || ':r24', lower(a.slot) - interval '24 hours');
  end if;
  if lower(a.slot) - interval '2 hours' > now() then
    perform public.outbox_enqueue('appointment.reminder_two_hours', 'appointment', v_aggregate, v_payload,
      'appt:' || a.id || ':r2', lower(a.slot) - interval '2 hours');
  end if;
  return v_event;
end;
$$;

-- Provider-side actor: the provider bound to the profile, or an active owner/admin of the appointment's org.
create or replace function public.booking_is_provider(p_profile uuid, p_org uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    exists (select 1 from public.provider_profiles p where p.id = p_profile and p.user_id = p_user)
    or exists (select 1 from public.org_members m
               where m.org_id = p_org and m.user_id = p_user and m.status = 'active' and m.org_role in ('owner', 'admin'))
  );
$$;

-- FR-3 hold. Exactly one of p_owner_user / p_owner_session (sha256 hex). Same key from the same owner -> the same
-- appointment (`replay`). Max one active hold per owner: the older one is released.
create or replace function public.booking_hold(
  p_service_id uuid, p_start timestamptz, p_owner_user uuid, p_owner_session text, p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.services;
  p public.provider_profiles;
  loc public.practice_locations;
  v_key text;
  v_end timestamptz;
  v_existing public.appointments;
  v_id uuid;
  v_expires timestamptz;
  r record;
begin
  if (p_owner_user is null) = (p_owner_session is null)
     or (p_owner_session is not null and p_owner_session !~ '^[0-9a-f]{64}$')
     or coalesce(char_length(p_idempotency_key), 0) not between 8 and 200 then
    perform public.booking_raise('invalid_owner');
  end if;
  v_key := case when p_owner_user is not null then 'u:' || p_owner_user else 's:' || p_owner_session end || ':' || p_idempotency_key;

  select * into v_existing from public.appointments where idempotency_key = v_key;
  if found then
    if v_existing.service_id is distinct from p_service_id or lower(v_existing.slot) <> p_start then
      perform public.booking_raise('idempotency_mismatch');
    end if;
    return jsonb_build_object('appointment_id', v_existing.id, 'hold_expires_at', v_existing.hold_expires_at,
                              'status', v_existing.status, 'replay', true);
  end if;

  select * into s from public.services where id = p_service_id and active;
  if not found then
    perform public.booking_raise('service_not_found');
  end if;
  select * into p from public.provider_profiles where id = s.provider_profile_id and verification_status = 'verified' and listed;
  if not found then
    perform public.booking_raise('service_not_found');
  end if;
  if s.location_id is not null then
    select * into loc from public.practice_locations where id = s.location_id;
  end if;

  perform public.booking_lock_provider(s.provider_profile_id);
  perform public.booking_expire_stale(s.provider_profile_id);

  -- A concurrent request with the same key may have committed while we waited for the lock.
  select * into v_existing from public.appointments where idempotency_key = v_key;
  if found then
    return jsonb_build_object('appointment_id', v_existing.id, 'hold_expires_at', v_existing.hold_expires_at,
                              'status', v_existing.status, 'replay', true);
  end if;

  if p_start < now() + interval '2 hours' then
    perform public.booking_raise('too_soon');
  end if;
  if p_start >= now() + interval '14 days' then
    perform public.booking_raise('too_far');
  end if;
  if not public.booking_slot_valid(s.provider_profile_id, s.mode, s.location_id, s.duration_min, p_start) then
    perform public.booking_raise('slot_unavailable');
  end if;
  v_end := p_start + make_interval(mins => s.duration_min);

  -- One active hold per owner: release the older one (rolled back with everything else if this hold fails).
  for r in
    select id from public.appointments
    where status = 'held'
      and ((p_owner_user is not null and hold_owner_user_id = p_owner_user)
           or (p_owner_session is not null and hold_owner_session = p_owner_session))
    for update
  loop
    update public.appointments
    set status = 'cancelled', cancelled_by = 'system', cancel_reason = 'hold_released', hold_expires_at = null, updated_at = now()
    where id = r.id;
    perform public.booking_log(r.id, 'held', 'cancelled', p_owner_user, case when p_owner_user is null then 'anonymous' else 'guardian' end, 'hold_released');
  end loop;

  if public.booking_conflicts(s.provider_profile_id, p_start, v_end, s.buffer_min, null) then
    perform public.booking_raise('slot_taken');
  end if;

  v_expires := now() + interval '10 minutes';
  begin
    insert into public.appointments (
      provider_profile_id, org_id, service_id, service_snapshot, slot, status,
      hold_owner_user_id, hold_owner_session, hold_expires_at, guardian_user_id, idempotency_key
    ) values (
      s.provider_profile_id, s.org_id, s.id,
      jsonb_build_object(
        'name', s.name, 'duration_min', s.duration_min, 'mode', s.mode, 'fee_inr', s.fee_inr,
        'payment_mode', s.payment_mode, 'buffer_min', s.buffer_min, 'intake_kind', s.intake_kind,
        'provider_name', p.display_name, 'time_zone', coalesce(loc.time_zone, p.time_zone),
        'location', case when loc.id is null then null else jsonb_build_object(
          'id', loc.id, 'name', loc.name,
          'address', concat_ws(', ', loc.address_line1, loc.address_line2, loc.locality, loc.city || ' ' || loc.pincode),
          'lat', loc.lat, 'lng', loc.lng, 'time_zone', loc.time_zone) end
      ),
      tstzrange(p_start, v_end, '[)'), 'held',
      p_owner_user, p_owner_session, v_expires, p_owner_user, v_key
    ) returning id into v_id;
  exception
    when exclusion_violation then
      perform public.booking_raise('slot_taken');
    when unique_violation then
      select * into v_existing from public.appointments where idempotency_key = v_key;
      return jsonb_build_object('appointment_id', v_existing.id, 'hold_expires_at', v_existing.hold_expires_at,
                                'status', v_existing.status, 'replay', true);
  end;

  perform public.booking_log(v_id, null, 'held', p_owner_user, case when p_owner_user is null then 'anonymous' else 'guardian' end, null);
  return jsonb_build_object('appointment_id', v_id, 'hold_expires_at', v_expires, 'status', 'held', 'replay', false);
end;
$$;

-- FR-3 attach: a hold -> the signed-in guardian and one of their children. The caller proves ownership with the
-- user id or the anonymous session hash. Expired holds -> hold_expired; someone else's hold -> not_found.
create or replace function public.booking_attach(
  p_appointment uuid, p_owner_user uuid, p_owner_session text, p_guardian uuid, p_child uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
begin
  select * into a from public.appointments where id = p_appointment for update;
  if not found or not (
    (a.hold_owner_user_id is not null and a.hold_owner_user_id in (p_owner_user, p_guardian))
    or (a.hold_owner_user_id is null and p_owner_session is not null and a.hold_owner_session = p_owner_session)
  ) then
    perform public.booking_raise('not_found');
  end if;
  if a.status = 'expired' or (a.status = 'held' and a.hold_expires_at <= now()) then
    perform public.booking_raise('hold_expired');
  end if;
  if a.status <> 'held' then
    perform public.booking_raise('invalid_transition');
  end if;
  if not exists (select 1 from public.user_profiles where id = p_guardian and role = 'guardian') then
    perform public.booking_raise('not_guardian');
  end if;
  if p_child is null then
    perform public.booking_raise('child_required');
  end if;
  if not exists (
    select 1 from public.guardian_links gl join public.children c on c.id = gl.child_id
    where gl.child_id = p_child and gl.user_id = p_guardian and gl.status = 'active' and c.deleted_at is null
  ) then
    perform public.booking_raise('child_not_linked');
  end if;

  update public.appointments
  set hold_owner_user_id = p_guardian, hold_owner_session = null, guardian_user_id = p_guardian, child_id = p_child, updated_at = now()
  where id = p_appointment;
  return jsonb_build_object('appointment_id', p_appointment, 'status', 'held');
end;
$$;

-- FR-3 confirm: free / at_clinic -> confirmed (+ confirmation and reminders in the same transaction);
-- online -> pending_payment for 15 minutes (031 completes it).
create or replace function public.booking_confirm(p_appointment uuid, p_guardian uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_to text;
  v_event bigint;
begin
  select * into a from public.appointments where id = p_appointment for update;
  if not found or a.guardian_user_id is distinct from p_guardian
     or (a.status = 'held' and a.hold_owner_user_id is distinct from p_guardian) then
    perform public.booking_raise('not_found');
  end if;
  if a.status = 'expired' or (a.status = 'held' and a.hold_expires_at <= now()) then
    perform public.booking_raise('hold_expired');
  end if;
  if a.status <> 'held' then
    perform public.booking_raise('invalid_transition');
  end if;
  if a.child_id is null then
    perform public.booking_raise('child_required');
  end if;
  if not exists (
    select 1 from public.guardian_links gl join public.children c on c.id = gl.child_id
    where gl.child_id = a.child_id and gl.user_id = p_guardian and gl.status = 'active' and c.deleted_at is null
  ) then
    perform public.booking_raise('child_not_linked');
  end if;

  if a.service_snapshot ->> 'payment_mode' = 'online' then
    v_to := 'pending_payment';
    update public.appointments
    set status = v_to, hold_expires_at = now() + interval '15 minutes', updated_at = now()
    where id = p_appointment;
  else
    v_to := 'confirmed';
    update public.appointments
    set status = v_to, hold_expires_at = null, hold_owner_session = null, updated_at = now()
    where id = p_appointment;
  end if;
  perform public.booking_log(p_appointment, 'held', v_to, p_guardian, 'guardian', null);
  if v_to = 'confirmed' then
    v_event := public.booking_enqueue_confirmed(p_appointment);
  end if;
  return jsonb_build_object('appointment_id', p_appointment, 'status', v_to, 'event_id', v_event);
end;
$$;

-- FR-3 cancel. Guardian: their own appointment, confirmed ones up to 2 h before the start. Provider: any time
-- before the start. Unsent notifications of the appointment are cancelled; a confirmed appointment gets
-- `appointment.cancelled`.
create or replace function public.booking_cancel(p_appointment uuid, p_actor uuid, p_actor_kind text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_event bigint;
begin
  if p_actor_kind not in ('guardian', 'provider', 'system') then
    perform public.booking_raise('invalid_owner');
  end if;
  select * into a from public.appointments where id = p_appointment for update;
  if not found
     or (p_actor_kind = 'guardian' and coalesce(a.guardian_user_id, a.hold_owner_user_id) is distinct from p_actor)
     or (p_actor_kind = 'provider' and not public.booking_is_provider(a.provider_profile_id, a.org_id, p_actor)) then
    perform public.booking_raise('not_found');
  end if;
  if a.status not in ('held', 'pending_payment', 'confirmed') then
    perform public.booking_raise('invalid_transition');
  end if;
  if lower(a.slot) <= now() then
    perform public.booking_raise('too_late');
  end if;
  if p_actor_kind = 'guardian' and a.status = 'confirmed' and lower(a.slot) < now() + interval '2 hours' then
    perform public.booking_raise('too_late');
  end if;

  update public.appointments
  set status = 'cancelled', cancelled_by = p_actor_kind, cancel_reason = left(nullif(btrim(p_reason), ''), 300),
      hold_expires_at = null, updated_at = now()
  where id = p_appointment;
  perform public.booking_log(p_appointment, a.status, 'cancelled', p_actor, p_actor_kind, left(nullif(btrim(p_reason), ''), 300));
  perform public.outbox_cancel('appt:' || a.id || ':');
  if a.status = 'confirmed' then
    v_event := public.outbox_enqueue('appointment.cancelled', 'appointment', coalesce(a.origin_appointment_id, a.id),
      public.booking_notify_payload(a.id) || jsonb_build_object('cancelled_by', p_actor_kind),
      'appt:' || a.id || ':cancelled', now());
  end if;
  return jsonb_build_object('appointment_id', p_appointment, 'status', 'cancelled', 'event_id', v_event);
end;
$$;

-- FR-3 reschedule: atomically creates the new confirmed appointment (same snapshot, rescheduled_from) and cancels the
-- old one. slot_taken (or any other error) leaves the old appointment untouched.
create or replace function public.booking_reschedule(p_appointment uuid, p_new_start timestamptz, p_actor uuid, p_actor_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_profile uuid;
  v_duration int;
  v_buffer int;
  v_end timestamptz;
  v_new uuid;
  v_event bigint;
begin
  if p_actor_kind not in ('guardian', 'provider') then
    perform public.booking_raise('invalid_owner');
  end if;
  select provider_profile_id into v_profile from public.appointments where id = p_appointment;
  if v_profile is null then
    perform public.booking_raise('not_found');
  end if;
  perform public.booking_lock_provider(v_profile);

  select * into a from public.appointments where id = p_appointment for update;
  if (p_actor_kind = 'guardian' and a.guardian_user_id is distinct from p_actor)
     or (p_actor_kind = 'provider' and not public.booking_is_provider(a.provider_profile_id, a.org_id, p_actor)) then
    perform public.booking_raise('not_found');
  end if;
  if a.status <> 'confirmed' then
    perform public.booking_raise('invalid_transition');
  end if;
  if lower(a.slot) <= now() or (p_actor_kind = 'guardian' and lower(a.slot) < now() + interval '2 hours') then
    perform public.booking_raise('too_late');
  end if;
  if p_new_start = lower(a.slot) then
    perform public.booking_raise('slot_unavailable');
  end if;
  if p_new_start < now() + interval '2 hours' then
    perform public.booking_raise('too_soon');
  end if;
  if p_new_start >= now() + interval '14 days' then
    perform public.booking_raise('too_far');
  end if;

  perform public.booking_expire_stale(a.provider_profile_id);
  v_duration := (a.service_snapshot ->> 'duration_min')::int;
  v_buffer := coalesce((a.service_snapshot ->> 'buffer_min')::int, 0);
  if not public.booking_slot_valid(a.provider_profile_id, a.service_snapshot ->> 'mode',
                                   nullif(a.service_snapshot -> 'location' ->> 'id', '')::uuid, v_duration, p_new_start) then
    perform public.booking_raise('slot_unavailable');
  end if;
  v_end := p_new_start + make_interval(mins => v_duration);
  if public.booking_conflicts(a.provider_profile_id, p_new_start, v_end, v_buffer, a.id) then
    perform public.booking_raise('slot_taken');
  end if;

  begin
    update public.appointments
    set status = 'cancelled', cancelled_by = p_actor_kind, cancel_reason = 'rescheduled', updated_at = now()
    where id = a.id;
    insert into public.appointments (
      provider_profile_id, org_id, service_id, service_snapshot, child_id, guardian_user_id, case_id, slot, status,
      rescheduled_from, origin_appointment_id
    ) values (
      a.provider_profile_id, a.org_id, a.service_id, a.service_snapshot, a.child_id, a.guardian_user_id, a.case_id,
      tstzrange(p_new_start, v_end, '[)'), 'confirmed', a.id, coalesce(a.origin_appointment_id, a.id)
    ) returning id into v_new;
  exception when exclusion_violation then
    perform public.booking_raise('slot_taken');
  end;

  perform public.booking_log(a.id, 'confirmed', 'cancelled', p_actor, p_actor_kind, 'rescheduled');
  perform public.booking_log(v_new, null, 'confirmed', p_actor, p_actor_kind, 'rescheduled_from:' || a.id);
  perform public.outbox_cancel('appt:' || a.id || ':');
  v_event := public.booking_enqueue_confirmed(v_new, 'appointment.rescheduled', 'rescheduled');
  return jsonb_build_object('appointment_id', v_new, 'rescheduled_from', a.id, 'status', 'confirmed', 'event_id', v_event);
end;
$$;

-- FR-3 complete: confirmed -> completed / no_show, only by the provider side and only after the start.
create or replace function public.booking_complete(p_appointment uuid, p_provider_user uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
begin
  if p_status not in ('completed', 'no_show') then
    perform public.booking_raise('invalid_status');
  end if;
  select * into a from public.appointments where id = p_appointment for update;
  if not found or not public.booking_is_provider(a.provider_profile_id, a.org_id, p_provider_user) then
    perform public.booking_raise('not_found');
  end if;
  if a.status <> 'confirmed' then
    perform public.booking_raise('invalid_transition');
  end if;
  if lower(a.slot) > now() then
    perform public.booking_raise('not_started');
  end if;
  update public.appointments set status = p_status, updated_at = now() where id = p_appointment;
  perform public.booking_log(p_appointment, 'confirmed', p_status, p_provider_user, 'provider', null);
  return jsonb_build_object('appointment_id', p_appointment, 'status', p_status);
end;
$$;

-- Privacy erasure (041 registry `appointments`): future blocking appointments of the child are cancelled
-- (provider notified), then the child is detached from every appointment. The provider keeps the time slot record.
create or replace function public.booking_erase_child(p_child uuid)
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
    select id, status, origin_appointment_id from public.appointments
    where child_id = p_child and status in ('held', 'pending_payment', 'confirmed') and lower(slot) > now()
    for update
  loop
    update public.appointments
    set status = 'cancelled', cancelled_by = 'system', cancel_reason = 'erasure', hold_expires_at = null, updated_at = now()
    where id = r.id;
    perform public.booking_log(r.id, r.status, 'cancelled', null, 'system', 'erasure');
    perform public.outbox_cancel('appt:' || r.id || ':');
    if r.status = 'confirmed' then
      perform public.outbox_enqueue('appointment.cancelled', 'appointment', coalesce(r.origin_appointment_id, r.id),
        public.booking_notify_payload(r.id) || jsonb_build_object('cancelled_by', 'system'), 'appt:' || r.id || ':cancelled', now());
    end if;
    v_count := v_count + 1;
  end loop;
  update public.appointments set child_id = null, cancel_reason = null, updated_at = now() where child_id = p_child;
  return v_count;
end;
$$;

-- ---------- grants: the server (service role) only ----------
revoke all on function public.booking_derived_modes(uuid) from public, anon, authenticated;
revoke all on function public.booking_raise(text) from public, anon, authenticated;
revoke all on function public.booking_lock_provider(uuid) from public, anon, authenticated;
revoke all on function public.booking_log(uuid, text, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.booking_slot_valid(uuid, text, uuid, int, timestamptz) from public, anon, authenticated;
revoke all on function public.booking_conflicts(uuid, timestamptz, timestamptz, int, uuid) from public, anon, authenticated;
revoke all on function public.booking_expire_stale(uuid, int) from public, anon, authenticated;
revoke all on function public.booking_notify_payload(uuid) from public, anon, authenticated;
revoke all on function public.booking_enqueue_confirmed(uuid, text, text) from public, anon, authenticated;
revoke all on function public.booking_is_provider(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.booking_hold(uuid, timestamptz, uuid, text, text) from public, anon, authenticated;
revoke all on function public.booking_attach(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.booking_confirm(uuid, uuid) from public, anon, authenticated;
revoke all on function public.booking_cancel(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.booking_reschedule(uuid, timestamptz, uuid, text) from public, anon, authenticated;
revoke all on function public.booking_complete(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.booking_erase_child(uuid) from public, anon, authenticated;
revoke all on function public.services_refresh_modes() from public, anon, authenticated;
revoke all on function public.provider_profiles_derive_modes() from public, anon, authenticated;

grant execute on function public.booking_derived_modes(uuid) to service_role;
grant execute on function public.booking_slot_valid(uuid, text, uuid, int, timestamptz) to service_role;
grant execute on function public.booking_conflicts(uuid, timestamptz, timestamptz, int, uuid) to service_role;
grant execute on function public.booking_expire_stale(uuid, int) to service_role;
grant execute on function public.booking_notify_payload(uuid) to service_role;
grant execute on function public.booking_enqueue_confirmed(uuid, text, text) to service_role;
grant execute on function public.booking_is_provider(uuid, uuid, uuid) to service_role;
grant execute on function public.booking_hold(uuid, timestamptz, uuid, text, text) to service_role;
grant execute on function public.booking_attach(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.booking_confirm(uuid, uuid) to service_role;
grant execute on function public.booking_cancel(uuid, uuid, text, text) to service_role;
grant execute on function public.booking_reschedule(uuid, timestamptz, uuid, text) to service_role;
grant execute on function public.booking_complete(uuid, uuid, text) to service_role;
grant execute on function public.booking_erase_child(uuid) to service_role;
grant select, insert, update, delete on public.services, public.availability_rules, public.availability_overrides,
  public.appointments to service_role;
grant select, insert on public.appointment_events to service_role;
