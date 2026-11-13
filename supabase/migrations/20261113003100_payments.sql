-- Ticket 031: Razorpay payments (test mode). Payment state lives here, separate from appointment state (rule 12);
-- appointments still move only through 030's state machine helpers (booking_lock_provider / booking_conflicts /
-- booking_slot_valid / booking_log / booking_enqueue_confirmed). Additive only: new tables, functions and two
-- triggers on appointments that react to cancellations and reschedules (refunds, the payment follows a reschedule).
--
-- Payment statuses: created -> (authorized) -> captured -> refund_pending -> refunded; created/authorized -> failed
-- (a later successful attempt on the same order can still capture). One Razorpay order per appointment.

-- ---------- tables ----------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  -- Financial record: an appointment with a payment cannot be deleted (restrict); privacy erasure only detaches the
  -- child from the appointment (030 booking_erase_child), the payment keeps amounts and ids only.
  appointment_id uuid not null references public.appointments(id) on delete restrict,
  gateway text not null check (gateway in ('razorpay', 'demo')),
  razorpay_order_id text not null unique check (razorpay_order_id ~ '^order_[A-Za-z0-9]{6,40}$'),
  razorpay_payment_id text unique check (razorpay_payment_id ~ '^pay_[A-Za-z0-9]{6,40}$'),
  amount_paise int not null check (amount_paise between 100 and 10000000),
  currency text not null default 'INR' check (currency = 'INR'),
  status text not null default 'created'
    check (status in ('created', 'authorized', 'captured', 'failed', 'refund_pending', 'refunded')),
  refund_id text unique check (refund_id ~ '^rfnd_[A-Za-z0-9]{6,40}$'),
  -- Why a refund is due (FR-6 late payment, FR-7 cancellation policy).
  refund_reason text check (refund_reason in ('slot_unavailable', 'appointment_cancelled', 'provider_cancelled',
                                              'guardian_cancelled', 'system_cancelled', 'amount_mismatch', 'external')),
  failure_reason text check (char_length(failure_reason) <= 300),
  captured_at timestamptz,
  refund_requested_at timestamptz,
  refunded_at timestamptz,
  -- Refund job (lib/payments/jobs.ts): lease + retries, like 032's notifications.
  refund_attempts int not null default 0,
  refund_next_attempt_at timestamptz,
  refund_locked_until timestamptz,
  refund_last_error text check (char_length(refund_last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_refund_reason_set check (status not in ('refund_pending', 'refunded') or refund_reason is not null),
  constraint payments_captured_has_payment check (status not in ('captured', 'refund_pending', 'refunded') or razorpay_payment_id is not null)
);
-- FR-1: at most one non-failed payment per appointment.
create unique index payments_one_per_appointment on public.payments (appointment_id) where status <> 'failed';
create index payments_appointment_idx on public.payments (appointment_id);
create index payments_refund_due_idx on public.payments (refund_next_attempt_at) where status = 'refund_pending';

-- Webhook deliveries (FR-5): deduplicated by Razorpay's event id. `payload` is an allowlisted copy (lib/payments/
-- webhook.ts strips card, VPA, bank, wallet, email and phone details before anything is stored; NFR-1).
create table public.payment_events (
  id bigint generated always as identity primary key,
  razorpay_event_id text not null unique check (char_length(razorpay_event_id) between 1 and 100),
  event_type text not null check (char_length(event_type) between 1 and 80),
  payment_id uuid references public.payments(id) on delete set null,
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 16384),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text check (char_length(outcome) <= 80)
);
create index payment_events_payment_idx on public.payment_events (payment_id) where payment_id is not null;

alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
grant select on public.payments to authenticated;
-- Browsers may read the payments of their own appointments (guardian) or of their profile (provider); everything
-- else goes through the server (service role), which gates every route itself.
create policy "Guardians and providers read their payments" on public.payments
for select to authenticated using (
  exists (
    select 1 from public.appointments a
    where a.id = appointment_id
      and (a.guardian_user_id = (select auth.uid())
           or exists (select 1 from public.provider_profiles p where p.id = a.provider_profile_id and p.user_id = (select auth.uid())))
  )
);
revoke all on public.payment_events from public, anon, authenticated;
grant select, insert, update, delete on public.payments, public.payment_events to service_role;

-- =====================================================================================================
-- Functions (security definer, service role only). Errors are raised with the code as the message
-- (lib/payments/store.ts maps them): payment_not_found, payment_conflict.
-- =====================================================================================================

create or replace function public.payment_raise(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using message = p_code, errcode = 'P0001', hint = 'payment';
end;
$$;

-- Marks a payment for a full refund (the refund job calls Razorpay). Only captured payments; returns true when the
-- payment moved to refund_pending.
create or replace function public.payment_request_refund(p_payment uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payments
  set status = 'refund_pending', refund_reason = p_reason, refund_requested_at = now(), refund_next_attempt_at = now(),
      refund_attempts = 0, refund_locked_until = null, refund_last_error = null, updated_at = now()
  where id = p_payment and status = 'captured';
  return found;
end;
$$;

-- FR-6: the single "payment captured" path for the checkout handler (POST /api/payments/verify) and the
-- `payment.captured` webhook. One transaction, idempotent:
--   * already captured (or refunding/refunded) -> no-op;
--   * payment -> captured;
--   * appointment pending_payment and unexpired -> confirmed + 030 confirmation/reminders (booking_enqueue_confirmed);
--   * late payment (pending_payment past its expiry, or expired by the cron): re-book the same appointment if the
--     slot is still free, still published and in the future (exclusion constraint + per-provider lock), else refund;
--   * appointment cancelled (guardian, provider or system) -> refund (a deliberate cancellation is never undone);
--   * already confirmed -> no-op on the appointment.
-- p_amount_paise (webhook only): a different amount than the order -> refund, appointment untouched.
create or replace function public.payment_apply_captured(
  p_order_id text, p_payment_id text, p_amount_paise int default null, p_actor uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  a public.appointments;
  v_payment uuid;
  v_profile uuid;
  v_outcome text;
  v_event bigint;
  v_free boolean := false;
  v_reason text;
  v_kind text := case when p_actor is null then 'system' else 'guardian' end;
begin
  if p_payment_id is null or p_payment_id !~ '^pay_[A-Za-z0-9]{6,40}$' then
    perform public.payment_raise('payment_conflict');
  end if;
  select id into v_payment from public.payments where razorpay_order_id = p_order_id;
  if not found then
    perform public.payment_raise('payment_not_found');
  end if;
  -- Lock order (also used by booking_reschedule + the cancel trigger): provider lock -> appointment -> payment.
  select ap.provider_profile_id into v_profile
  from public.payments p join public.appointments ap on ap.id = p.appointment_id where p.id = v_payment;
  perform public.booking_lock_provider(v_profile);
  select ap.* into a from public.appointments ap
  where ap.id = (select appointment_id from public.payments where id = v_payment) for update;
  select * into pay from public.payments where id = v_payment for update;

  if pay.status in ('captured', 'refund_pending', 'refunded') then
    v_outcome := case when pay.razorpay_payment_id = p_payment_id then 'already_captured' else 'duplicate_payment' end;
    return jsonb_build_object('payment_id', pay.id, 'appointment_id', a.id, 'outcome', v_outcome,
                              'payment_status', pay.status, 'appointment_status', a.status);
  end if;
  if exists (select 1 from public.payments where razorpay_payment_id = p_payment_id and id <> pay.id) then
    perform public.payment_raise('payment_conflict');
  end if;

  update public.payments
  set status = 'captured', razorpay_payment_id = p_payment_id, captured_at = now(), failure_reason = null, updated_at = now()
  where id = pay.id;

  if p_amount_paise is not null and p_amount_paise <> pay.amount_paise then
    v_reason := 'amount_mismatch';
  elsif a.status in ('confirmed', 'completed', 'no_show') then
    v_outcome := 'already_confirmed';
  elsif a.status = 'pending_payment' and a.hold_expires_at > now() then
    update public.appointments
    set status = 'confirmed', hold_expires_at = null, hold_owner_session = null, updated_at = now()
    where id = a.id;
    perform public.booking_log(a.id, a.status, 'confirmed', p_actor, v_kind, 'payment_captured');
    v_event := public.booking_enqueue_confirmed(a.id);
    v_outcome := 'confirmed';
  elsif a.status in ('pending_payment', 'expired') then
    -- Late payment (D-3): same slot if it is still free, published and in the future, and the child still linked.
    -- Other stale holds of the provider are expired first (this row is locked, so it is skipped).
    perform public.booking_expire_stale(a.provider_profile_id);
    if lower(a.slot) > now()
       and a.child_id is not null
       and exists (select 1 from public.guardian_links gl join public.children c on c.id = gl.child_id
                   where gl.child_id = a.child_id and gl.user_id = a.guardian_user_id and gl.status = 'active' and c.deleted_at is null)
       and public.booking_slot_valid(a.provider_profile_id, a.service_snapshot ->> 'mode',
                                     nullif(a.service_snapshot -> 'location' ->> 'id', '')::uuid,
                                     (a.service_snapshot ->> 'duration_min')::int, lower(a.slot))
       and not public.booking_conflicts(a.provider_profile_id, lower(a.slot), upper(a.slot),
                                        coalesce((a.service_snapshot ->> 'buffer_min')::int, 0), a.id) then
      begin
        update public.appointments
        set status = 'confirmed', hold_expires_at = null, hold_owner_session = null, updated_at = now()
        where id = a.id;
        v_free := true;
      exception when exclusion_violation then
        v_free := false;
      end;
    end if;
    if v_free then
      perform public.booking_log(a.id, a.status, 'confirmed', p_actor, v_kind, 'late_payment');
      v_event := public.booking_enqueue_confirmed(a.id);
      v_outcome := 'late_confirmed';
    else
      v_reason := 'slot_unavailable';
    end if;
  elsif a.status = 'cancelled' then
    v_reason := 'appointment_cancelled';
  else
    v_reason := 'slot_unavailable';
  end if;

  if v_reason is not null then
    perform public.payment_request_refund(pay.id, v_reason);
    v_outcome := 'refund_' || v_reason;
  end if;

  select * into pay from public.payments where id = pay.id;
  select * into a from public.appointments where id = a.id;
  return jsonb_build_object('payment_id', pay.id, 'appointment_id', a.id, 'outcome', v_outcome, 'payment_status', pay.status,
                            'appointment_status', a.status, 'event_id', v_event, 'refund_reason', pay.refund_reason);
end;
$$;

-- `payment.authorized` (webhook): records the payment id; the appointment waits for the capture.
create or replace function public.payment_mark_authorized(p_order_id text, p_payment_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
begin
  select * into pay from public.payments where razorpay_order_id = p_order_id for update;
  if not found then
    perform public.payment_raise('payment_not_found');
  end if;
  if pay.status not in ('created', 'failed') then
    return jsonb_build_object('payment_id', pay.id, 'outcome', 'ignored', 'payment_status', pay.status);
  end if;
  if exists (select 1 from public.payments where razorpay_payment_id = p_payment_id and id <> pay.id) then
    perform public.payment_raise('payment_conflict');
  end if;
  update public.payments
  set status = 'authorized', razorpay_payment_id = p_payment_id, failure_reason = null, updated_at = now()
  where id = pay.id;
  return jsonb_build_object('payment_id', pay.id, 'outcome', 'authorized', 'payment_status', 'authorized');
end;
$$;

-- `payment.failed` (webhook, demo failure): the attempt failed; the guardian can retry on the same order while the
-- appointment is still pending. Never downgrades a captured payment.
create or replace function public.payment_mark_failed(p_order_id text, p_payment_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
begin
  select * into pay from public.payments where razorpay_order_id = p_order_id for update;
  if not found then
    perform public.payment_raise('payment_not_found');
  end if;
  if pay.status not in ('created', 'authorized', 'failed') then
    return jsonb_build_object('payment_id', pay.id, 'outcome', 'ignored', 'payment_status', pay.status);
  end if;
  update public.payments
  set status = 'failed', failure_reason = left(nullif(btrim(p_reason), ''), 300), updated_at = now(),
      razorpay_payment_id = case
        when p_payment_id ~ '^pay_[A-Za-z0-9]{6,40}$'
             and not exists (select 1 from public.payments o where o.razorpay_payment_id = p_payment_id and o.id <> pay.id)
        then p_payment_id else razorpay_payment_id end
  where id = pay.id;
  return jsonb_build_object('payment_id', pay.id, 'outcome', 'failed', 'payment_status', 'failed');
end;
$$;

-- Refund done (refund job with a processed refund, or the `refund.processed` webhook). Idempotent. A refund made
-- outside the app (Razorpay dashboard) on a captured payment is recorded too (reason `external`). The guardian gets
-- `payment.refunded` (FR-6 wording for slot_unavailable) in the same transaction.
create or replace function public.payment_mark_refunded(p_payment_id text, p_refund_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  v_event bigint;
begin
  select * into pay from public.payments where razorpay_payment_id = p_payment_id for update;
  if not found then
    perform public.payment_raise('payment_not_found');
  end if;
  if pay.status = 'refunded' then
    return jsonb_build_object('payment_id', pay.id, 'appointment_id', pay.appointment_id, 'outcome', 'already_refunded', 'payment_status', 'refunded');
  end if;
  if pay.status not in ('refund_pending', 'captured') then
    return jsonb_build_object('payment_id', pay.id, 'appointment_id', pay.appointment_id, 'outcome', 'ignored', 'payment_status', pay.status);
  end if;
  update public.payments
  set status = 'refunded', refund_id = coalesce(refund_id, p_refund_id), refund_reason = coalesce(refund_reason, 'external'),
      refunded_at = now(), refund_locked_until = null, refund_next_attempt_at = null, refund_last_error = null, updated_at = now()
  where id = pay.id
  returning * into pay;
  v_event := public.outbox_enqueue('payment.refunded', 'payment', pay.id,
    jsonb_build_object('payment_id', pay.id, 'appointment_id', pay.appointment_id, 'reason', pay.refund_reason),
    'payment:' || pay.id || ':refunded', now());
  return jsonb_build_object('payment_id', pay.id, 'appointment_id', pay.appointment_id, 'outcome', 'refunded',
                            'payment_status', 'refunded', 'event_id', v_event);
end;
$$;

-- FR-7 cancellation policy, in the cancelling transaction (booking_cancel / booking_erase_child): a paid appointment
-- cancelled by the provider or the system -> full refund; by the guardian >= 24 h before the start -> full refund;
-- later -> no refund (the payment stays captured). Reschedules are not cancellations: the payment follows the new
-- appointment (trigger below).
create or replace function public.payments_on_appointment_cancelled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment uuid;
begin
  if new.cancel_reason is not distinct from 'rescheduled' then
    return new;
  end if;
  select id into v_payment from public.payments where appointment_id = new.id and status = 'captured' for update;
  if v_payment is null then
    return new;
  end if;
  if new.cancelled_by = 'provider' then
    perform public.payment_request_refund(v_payment, 'provider_cancelled');
  elsif new.cancelled_by = 'guardian' then
    if lower(new.slot) - now() >= interval '24 hours' then
      perform public.payment_request_refund(v_payment, 'guardian_cancelled');
    end if;
  else
    perform public.payment_request_refund(v_payment, 'system_cancelled');
  end if;
  return new;
end;
$$;

create trigger payments_on_appointment_cancelled
after update of status on public.appointments
for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
execute procedure public.payments_on_appointment_cancelled();

-- 030 booking_reschedule cancels the old appointment and inserts the new one in one transaction: the captured
-- payment moves with it (the guardian paid for the visit, not for the time).
create or replace function public.payments_follow_reschedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payments set appointment_id = new.id, updated_at = now()
  where appointment_id = new.rescheduled_from and status in ('authorized', 'captured');
  return new;
end;
$$;

create trigger payments_follow_reschedule
after insert on public.appointments
for each row when (new.rescheduled_from is not null)
execute procedure public.payments_follow_reschedule();

-- ---------- grants: the server (service role) only ----------
revoke all on function public.payment_raise(text) from public, anon, authenticated;
revoke all on function public.payment_request_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.payment_apply_captured(text, text, int, uuid) from public, anon, authenticated;
revoke all on function public.payment_mark_authorized(text, text) from public, anon, authenticated;
revoke all on function public.payment_mark_failed(text, text, text) from public, anon, authenticated;
revoke all on function public.payment_mark_refunded(text, text) from public, anon, authenticated;
revoke all on function public.payments_on_appointment_cancelled() from public, anon, authenticated;
revoke all on function public.payments_follow_reschedule() from public, anon, authenticated;

grant execute on function public.payment_request_refund(uuid, text) to service_role;
grant execute on function public.payment_apply_captured(text, text, int, uuid) to service_role;
grant execute on function public.payment_mark_authorized(text, text) to service_role;
grant execute on function public.payment_mark_failed(text, text, text) to service_role;
grant execute on function public.payment_mark_refunded(text, text) to service_role;
