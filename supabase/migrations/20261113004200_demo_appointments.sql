-- 042 FR-2a: demo-booking safeguard. Synthetic (demo) provider profiles stay visible and bookable, but a booking on
-- one must never look like real care:
--   * appointments.is_demo: derived from the provider profile's is_synthetic when the row is inserted (never from
--     client input) and immutable afterwards. Reschedules insert a new row, so they are demo bookings too.
--   * no payment: a demo appointment's service snapshot says `free` / fee 0, so booking_confirm confirms it directly
--     (never pending_payment) and 031's order route answers not_payable; a payment row for it is refused.
--   * no Google Meet: meet_status `not_needed`, so 037's outbox trigger never enqueues meet.create.
--   * no email / WhatsApp: notification rows on those channels for an event about a demo appointment are dropped
--     (in-app only). The outbox worker filters the same way; this trigger is the guarantee for every writer.
-- The `demo_ack` acknowledgement is checked by the app before the hold (lib/booking/hooks.ts).
-- Additive only: the 030/031/032/037 functions are unchanged.

alter table public.appointments add column is_demo boolean not null default false;

-- Backfill: appointments already made on demo profiles are demo bookings (stops their reminders leaving the app).
update public.appointments a
set is_demo = true
from public.provider_profiles p
where p.id = a.provider_profile_id and p.is_synthetic and not a.is_demo;

create index appointments_demo_idx on public.appointments (provider_profile_id) where is_demo;

-- Fires before 037's appointments_meet_defaults (triggers run in name order), which keeps a preset meet_status.
create or replace function public.appointments_demo_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.is_demo := old.is_demo;
    return new;
  end if;
  new.is_demo := coalesce((select p.is_synthetic from public.provider_profiles p where p.id = new.provider_profile_id), false);
  if new.is_demo then
    new.service_snapshot := coalesce(new.service_snapshot, '{}'::jsonb)
      || jsonb_build_object('payment_mode', 'free', 'fee_inr', 0, 'demo', true);
    new.meet_status := 'not_needed';
    new.meet_url := null;
    new.google_event_id := null;
  end if;
  return new;
end;
$$;

create trigger appointments_demo_flag before insert or update of is_demo on public.appointments
for each row execute function public.appointments_demo_flag();

-- Is this outbox event about a demo appointment? Appointment events use the appointment (or the first appointment of
-- a reschedule chain) as aggregate; other topics (Meet jobs, payments, 035 intake) carry `appointment_id`.
create or replace function public.outbox_event_is_demo(p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appointments a
    where a.is_demo
      and ((p_aggregate_type = 'appointment' and a.id = p_aggregate_id)
        or (coalesce(p_payload ->> 'appointment_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and a.id = (p_payload ->> 'appointment_id')::uuid))
  );
$$;

create or replace function public.notifications_demo_in_app_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.outbox_events;
begin
  if new.channel = 'in_app' then
    return new;
  end if;
  select * into e from public.outbox_events where id = new.event_id;
  if found and public.outbox_event_is_demo(e.aggregate_type, e.aggregate_id, e.payload) then
    return null;
  end if;
  return new;
end;
$$;

create trigger notifications_demo_in_app_only before insert on public.notifications
for each row execute function public.notifications_demo_in_app_only();

create or replace function public.payments_refuse_demo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.appointments where id = new.appointment_id and is_demo) then
    raise exception 'not_payable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger payments_refuse_demo before insert on public.payments
for each row execute function public.payments_refuse_demo();

revoke all on function public.appointments_demo_flag() from public, anon, authenticated;
revoke all on function public.outbox_event_is_demo(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.notifications_demo_in_app_only() from public, anon, authenticated;
revoke all on function public.payments_refuse_demo() from public, anon, authenticated;
grant execute on function public.outbox_event_is_demo(text, uuid, jsonb) to service_role;
