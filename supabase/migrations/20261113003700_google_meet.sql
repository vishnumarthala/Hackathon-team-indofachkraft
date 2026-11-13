-- 037: Google Meet for video appointments. Additive only (see docs/google-meet.md):
--   * provider_google_connections: the provider's own Google account (refresh token AES-256-GCM encrypted by the app,
--     never readable by browsers);
--   * appointments.meet_url / google_event_id / meet_status (expand -> backfill -> check);
--   * outbox_job_attempts: attempt bookkeeping for outbox "job" topics (`meet.create`, `meet.update`, `meet.delete`)
--     that the outbox worker runs instead of fanning out notifications (lib/notify/jobs.ts);
--   * triggers that turn the booking state machine's own outbox events into Meet jobs in the same transaction
--     (`appointment.confirmed` / `.rescheduled` -> create or patch, `.cancelled` -> delete). The 030 booking functions
--     are not changed.

-- ---------- provider_google_connections (FR-1, FR-2) ----------
create table public.provider_google_connections (
  provider_profile_id uuid primary key references public.provider_profiles(id) on delete cascade,
  google_email text not null check (char_length(google_email) between 3 and 320),
  -- version (1 byte) || iv (12) || auth tag (16) || ciphertext; key = TOKEN_ENCRYPTION_KEY, AAD binds it to the profile.
  refresh_token_encrypted bytea not null check (octet_length(refresh_token_encrypted) between 30 and 4096),
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  connected_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- NFR-1: browsers never read connections (not even their own): no grants, no policies. The server uses the service role.
alter table public.provider_google_connections enable row level security;
revoke all on public.provider_google_connections from public, anon, authenticated;
grant select, insert, update, delete on public.provider_google_connections to service_role;

-- ---------- appointments: Meet fields (FR-1) ----------
alter table public.appointments
  add column meet_url text,
  add column google_event_id text,
  add column meet_status text;

-- Backfill: in-clinic -> not_needed; confirmed video appointments booked before this ticket have no link and no
-- connected calendar -> failed (the provider can add a link by hand). Video holds stay null until confirmed.
update public.appointments set meet_status = case
    when coalesce(service_snapshot ->> 'mode', '') <> 'video' then 'not_needed'
    when status = 'confirmed' then 'failed'
  end
where meet_status is null;

alter table public.appointments
  add constraint appointments_meet_status_check
    check (meet_status in ('not_needed', 'pending', 'created', 'failed', 'manual')),
  add constraint appointments_meet_url_check
    check (meet_url is null or (meet_url ~ '^https://meet\.google\.com/[a-z0-9][a-z0-9-]{2,63}$' and char_length(meet_url) <= 100)),
  add constraint appointments_google_event_id_check
    check (google_event_id is null or (google_event_id ~ '^[A-Za-z0-9_-]+$' and char_length(google_event_id) <= 1024)),
  add constraint appointments_meet_link_present
    check (meet_status not in ('created', 'manual') or meet_url is not null);

-- New rows: in-clinic -> not_needed. A rescheduled video appointment inherits its predecessor's link and calendar event
-- (the event is patched to the new time by `meet.update`, so the guardian keeps the same link).
create or replace function public.appointments_meet_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prev public.appointments;
begin
  if coalesce(new.service_snapshot ->> 'mode', '') <> 'video' then
    new.meet_status := coalesce(new.meet_status, 'not_needed');
  elsif new.rescheduled_from is not null and new.meet_url is null and new.google_event_id is null then
    select * into prev from public.appointments where id = new.rescheduled_from;
    if found then
      new.meet_url := prev.meet_url;
      new.google_event_id := prev.google_event_id;
      new.meet_status := prev.meet_status;
    end if;
  end if;
  return new;
end;
$$;

create trigger appointments_meet_defaults before insert on public.appointments
for each row execute function public.appointments_meet_defaults();

-- ---------- outbox job attempts (FR-3 retries) ----------
-- One row per job event (topic `meet.*`): attempts so far and the last error (one line, no tokens, no payload).
create table public.outbox_job_attempts (
  event_id bigint primary key references public.outbox_events(id) on delete cascade,
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (char_length(last_error) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.outbox_job_attempts enable row level security;
revoke all on public.outbox_job_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.outbox_job_attempts to service_role;

-- ---------- appointment events -> Meet jobs (FR-3), in the booking transaction ----------
-- Dedup keys `meet:<appointment id>:<create|update|delete>` (not under `appt:<id>:`, so booking_cancel's
-- outbox_cancel never drops a job: the create job itself skips appointments that are no longer confirmed and removes
-- any event an earlier timed-out attempt created).
create or replace function public.meet_jobs_from_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  a public.appointments;
begin
  if new.topic not in ('appointment.confirmed', 'appointment.rescheduled', 'appointment.cancelled')
     or coalesce(new.payload ->> 'mode', '') <> 'video' then
    return null;
  end if;
  v_id := nullif(new.payload ->> 'appointment_id', '')::uuid;
  select * into a from public.appointments where id = v_id;
  if not found then
    return null;
  end if;

  if new.topic = 'appointment.cancelled' then
    if a.google_event_id is not null or a.meet_status in ('pending', 'created') then
      perform public.outbox_enqueue('meet.delete', 'meet', a.id, jsonb_build_object('appointment_id', a.id),
        'meet:' || a.id || ':delete', now());
    end if;
  elsif new.topic = 'appointment.rescheduled' and a.google_event_id is not null then
    perform public.outbox_enqueue('meet.update', 'meet', a.id, jsonb_build_object('appointment_id', a.id),
      'meet:' || a.id || ':update', now());
  elsif a.status = 'confirmed' and coalesce(a.meet_status, 'pending') in ('pending', 'failed') then
    -- First confirmation (031: also after payment), or a reschedule of an appointment that has no event yet.
    update public.appointments set meet_status = 'pending' where id = a.id;
    perform public.outbox_enqueue('meet.create', 'meet', a.id, jsonb_build_object('appointment_id', a.id),
      'meet:' || a.id || ':create', now());
  end if;
  return null;
end;
$$;

create trigger outbox_events_meet_jobs after insert on public.outbox_events
for each row execute function public.meet_jobs_from_outbox();

revoke all on function public.appointments_meet_defaults() from public, anon, authenticated;
revoke all on function public.meet_jobs_from_outbox() from public, anon, authenticated;
