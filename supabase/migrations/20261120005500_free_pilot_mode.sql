-- 055: free pilot mode. The server switch is the env var PAYMENTS_ENABLED (lib/env.ts; only "true" turns payments on).
-- The database cannot read it, so the application passes it:
--   * booking_confirm(..., p_require_payment): false = every booking confirms directly (never pending_payment) and its
--     frozen service snapshot becomes free (payment_mode `free`, fee 0, `free_pilot` true), so a pilot booking stays
--     free even after payments are switched on later;
--   * attendance_mark(..., p_payments_enabled): false = the marking is never billable and creates no charge, package
--     session or refund;
--   * payments_set_enabled(false) (transaction-local setting `app.payments_enabled`) for the other paths that mark an
--     outcome through 030's functions (Mark completed / No-show / provider cancel, lib/booking/store.ts). 044's sync
--     trigger and 045's billing trigger read it through payments_enabled().
-- Unset = enabled: direct SQL callers and existing tests keep 031/044/045 behaviour. Nothing is dropped: switching
-- PAYMENTS_ENABLED=true restores the paid flow without another migration.

-- =====================================================================================================
-- the transaction-local flag
-- =====================================================================================================

create or replace function public.payments_enabled()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.payments_enabled', true), ''), 'true') <> 'false';
$$;

-- Sets the flag for the rest of the current transaction (set_config is_local) and returns it.
create or replace function public.payments_set_enabled(p_enabled boolean)
returns boolean
language sql
volatile
set search_path = ''
as $$
  select set_config('app.payments_enabled', case when coalesce(p_enabled, true) then 'true' else 'false' end, true) = 'true';
$$;

-- =====================================================================================================
-- 030 booking_confirm with p_require_payment (FR-3 of 030 otherwise unchanged)
-- =====================================================================================================

drop function if exists public.booking_confirm(uuid, uuid);

create or replace function public.booking_confirm(p_appointment uuid, p_guardian uuid, p_require_payment boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_to text;
  v_event bigint;
  v_pay boolean := coalesce(p_require_payment, true);
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

  if v_pay and a.service_snapshot ->> 'payment_mode' = 'online' then
    v_to := 'pending_payment';
    update public.appointments
    set status = v_to, hold_expires_at = now() + interval '15 minutes', updated_at = now()
    where id = p_appointment;
  else
    v_to := 'confirmed';
    update public.appointments
    set status = v_to, hold_expires_at = null, hold_owner_session = null, updated_at = now(),
        -- 055: booked during the free pilot = free for good (no charge at attendance, no payment, no payout).
        service_snapshot = case
          when v_pay or coalesce(service_snapshot ->> 'payment_mode', 'free') = 'free' then service_snapshot
          else service_snapshot || jsonb_build_object('payment_mode', 'free', 'fee_inr', 0, 'free_pilot', true)
        end
    where id = p_appointment;
  end if;
  perform public.booking_log(p_appointment, 'held', v_to, p_guardian, 'guardian', null);
  if v_to = 'confirmed' then
    v_event := public.booking_enqueue_confirmed(p_appointment);
  end if;
  return jsonb_build_object('appointment_id', p_appointment, 'status', v_to, 'event_id', v_event);
end;
$$;

-- =====================================================================================================
-- 044 billing rule: never billable while payments are off
-- =====================================================================================================

create or replace function public.attendance_billable_for(p_appointment public.appointments, p_attendance text, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.payments_enabled() and public.attendance_billable(
    (select o.attendance_policy from public.organizations o where o.id = p_appointment.org_id),
    p_attendance,
    coalesce((p_appointment.service_snapshot ->> 'fee_inr')::int, 0),
    lower(p_appointment.slot),
    p_at);
$$;

-- 044 attendance_mark with p_payments_enabled (sets the transaction flag first, so 030's booking_complete /
-- booking_cancel and the sync trigger see it too). Otherwise unchanged.
drop function if exists public.attendance_mark(uuid, uuid, text, text);

create or replace function public.attendance_mark(
  p_appointment uuid, p_actor uuid, p_attendance text, p_reason text, p_payments_enabled boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_from text;
  v_status text;
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_manager boolean;
  v_billable boolean;
  v_cancel_reason text;
begin
  perform public.payments_set_enabled(coalesce(p_payments_enabled, true));
  if p_attendance is null or p_attendance not in ('present', 'absent', 'late_cancel_family', 'cancelled_centre') then
    perform public.booking_raise('invalid_status');
  end if;
  -- One writer per appointment: a double tap waits here and then sees the first tap's result (NFR-2).
  select * into a from public.appointments where id = p_appointment for update;
  if not found or p_actor is null or not public.series_can_manage(a.org_id, a.provider_profile_id, p_actor) then
    perform public.booking_raise('not_found');
  end if;

  v_from := coalesce(a.attendance, case a.status when 'completed' then 'present' when 'no_show' then 'absent' end);
  if v_from = p_attendance then
    return jsonb_build_object('result', 'unchanged', 'appointment_id', a.id, 'org_id', a.org_id, 'child_id', a.child_id,
      'case_id', a.case_id, 'from', v_from, 'to', p_attendance, 'billable', a.billable,
      'from_status', a.status, 'to_status', a.status);
  end if;
  if v_from is null and a.status <> 'confirmed' then
    perform public.booking_raise('invalid_transition');
  end if;

  -- D-3: members mark and correct the last 7 days; older sessions need an owner/admin.
  v_manager := exists (select 1 from public.org_members m where m.org_id = a.org_id and m.user_id = p_actor
                       and m.status = 'active' and m.org_role in ('owner', 'admin'));
  if not v_manager and lower(a.slot) < now() - interval '7 days' then
    perform public.booking_raise('correction_window');
  end if;
  -- FR-4: present / absent only from the start time onwards (cancel types any time).
  if p_attendance in ('present', 'absent') and lower(a.slot) > now() then
    perform public.booking_raise('not_started');
  end if;
  if v_from is not null and v_reason is null then
    perform public.booking_raise('reason_required');
  end if;

  v_status := case p_attendance when 'present' then 'completed' when 'absent' then 'no_show' else 'cancelled' end;
  v_cancel_reason := case p_attendance when 'late_cancel_family' then 'late_cancel_family'
                                       when 'cancelled_centre' then 'centre_cancelled' end;

  if v_from is null then
    -- First marking: 030's functions (the sync trigger fills attendance + billable in their row update).
    if p_attendance in ('present', 'absent') then
      perform public.booking_complete(a.id, p_actor, v_status);
    elsif lower(a.slot) > now() then
      perform public.booking_cancel(a.id, p_actor, 'provider', v_cancel_reason);
    else
      -- After the start 030's cancel refuses (`too_late`); the register records what happened. No message to the
      -- family about a session that is already over; unsent reminders are withdrawn.
      update public.appointments
      set status = 'cancelled', cancelled_by = 'provider', cancel_reason = v_cancel_reason, hold_expires_at = null,
          updated_at = now()
      where id = a.id;
      perform public.booking_log(a.id, 'confirmed', 'cancelled', p_actor, 'provider', v_cancel_reason);
      perform public.outbox_cancel('appt:' || a.id || ':');
    end if;
    v_billable := public.attendance_billable_for(a, p_attendance, now());
    update public.appointments
    set attendance = p_attendance, attendance_marked_by = p_actor, attendance_marked_at = now(), billable = v_billable
    where id = a.id;
  else
    -- Correction between outcomes (audited with the reason by the caller).
    v_billable := public.attendance_billable_for(a, p_attendance, now());
    update public.appointments
    set status = v_status,
        attendance = p_attendance,
        attendance_marked_by = p_actor,
        attendance_marked_at = now(),
        billable = v_billable,
        cancelled_by = case when v_status = 'cancelled' then 'provider' end,
        cancel_reason = v_cancel_reason,
        updated_at = now()
    where id = a.id;
    perform public.booking_log(a.id, a.status, v_status, p_actor, 'provider',
      left('attendance_corrected:' || v_from || '->' || p_attendance || ': ' || v_reason, 300));
    if v_status = 'cancelled' and lower(a.slot) > now() then
      perform public.outbox_cancel('appt:' || a.id || ':');
    end if;
  end if;

  return jsonb_build_object('result', case when v_from is null then 'marked' else 'corrected' end,
    'appointment_id', a.id, 'org_id', a.org_id, 'child_id', a.child_id, 'case_id', a.case_id,
    'from', v_from, 'to', p_attendance, 'billable', v_billable, 'from_status', a.status, 'to_status', v_status);
end;
$$;

-- =====================================================================================================
-- 045 billing hook: no ledger charge, package session or refund while payments are off
-- =====================================================================================================

create or replace function public.appointments_fees_on_billable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.payments_enabled() then
    perform public.fees_apply_billable(new.id);
  end if;
  return null;
end;
$$;

-- ---------- grants ----------
revoke all on function public.payments_enabled() from public, anon, authenticated;
revoke all on function public.payments_set_enabled(boolean) from public, anon, authenticated;
revoke all on function public.booking_confirm(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.attendance_billable_for(public.appointments, text, timestamptz) from public, anon, authenticated;
revoke all on function public.attendance_mark(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke all on function public.appointments_fees_on_billable() from public, anon, authenticated;
grant execute on function public.payments_enabled() to service_role;
grant execute on function public.payments_set_enabled(boolean) to service_role;
grant execute on function public.booking_confirm(uuid, uuid, boolean) to service_role;
grant execute on function public.attendance_billable_for(public.appointments, text, timestamptz) to service_role;
grant execute on function public.attendance_mark(uuid, uuid, text, text, boolean) to service_role;
