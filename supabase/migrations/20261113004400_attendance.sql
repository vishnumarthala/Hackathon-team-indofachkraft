-- 044: attendance register. Expand -> backfill -> enforce.
--   * `organizations.attendance_policy` (D-2: absent and late family cancellations are not billable unless the org
--     turns it on; a late cancellation is one inside `late_cancel_hours` of the start, default 24);
--   * `appointments.attendance` / `attendance_marked_by` / `attendance_marked_at` / `billable` (D-1: one source of truth,
--     mapped onto 030's statuses: present = completed, absent = no_show, late_cancel_family / cancelled_centre =
--     cancelled with cancel_reason `late_cancel_family` / `centre_cancelled`);
--   * `attendance_mark()`: first markings call 030's booking_complete / booking_cancel; transitions 030 has no function
--     for (a cancel type after the start, corrections between outcomes) are done here and written to 030's state
--     history (`appointment_events`) like every other change. 030's functions are unchanged.
-- Every route gates first (lib/booking/attendance.ts); the function re-checks the actor with 043's `series_can_manage`
-- (active member of the appointment's org who is owner/admin or the therapist bound to the profile).

-- =====================================================================================================
-- expand
-- =====================================================================================================

create or replace function public.attendance_policy_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and jsonb_typeof(p) = 'object'
     and jsonb_typeof(p -> 'bill_absent') = 'boolean'
     and jsonb_typeof(p -> 'bill_late_cancel') = 'boolean'
     and jsonb_typeof(p -> 'late_cancel_hours') = 'number'
     and (p ->> 'late_cancel_hours')::numeric between 0 and 168
     and (p ->> 'late_cancel_hours')::numeric = trunc((p ->> 'late_cancel_hours')::numeric)
     and (select count(*) from jsonb_object_keys(p)) = 3;
$$;

-- A constant default fills every existing organisation (the backfill) without rewriting the table.
alter table public.organizations
  add column if not exists attendance_policy jsonb not null
    default '{"bill_absent": false, "bill_late_cancel": false, "late_cancel_hours": 24}'::jsonb;

alter table public.appointments
  add column if not exists attendance text,
  add column if not exists attendance_marked_by uuid references auth.users(id) on delete set null,
  add column if not exists attendance_marked_at timestamptz,
  add column if not exists billable boolean;

-- =====================================================================================================
-- billing rule (FR-2)
-- =====================================================================================================

-- present: billable when the fee is > 0. absent: only with bill_absent. late_cancel_family: only with bill_late_cancel
-- and when recorded inside late_cancel_hours of the start (or after it). cancelled_centre: never.
create or replace function public.attendance_billable(
  p_policy jsonb, p_attendance text, p_fee int, p_start timestamptz, p_at timestamptz
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_fee, 0) <= 0 then false
    when p_attendance = 'present' then true
    when p_attendance = 'absent' then coalesce((p_policy ->> 'bill_absent')::boolean, false)
    when p_attendance = 'late_cancel_family' then
      coalesce((p_policy ->> 'bill_late_cancel')::boolean, false)
      and p_start - p_at < make_interval(hours => coalesce((p_policy ->> 'late_cancel_hours')::int, 24))
    else false
  end;
$$;

create or replace function public.attendance_billable_for(p_appointment public.appointments, p_attendance text, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.attendance_billable(
    (select o.attendance_policy from public.organizations o where o.id = p_appointment.org_id),
    p_attendance,
    coalesce((p_appointment.service_snapshot ->> 'fee_inr')::int, 0),
    lower(p_appointment.slot),
    p_at);
$$;

-- =====================================================================================================
-- backfill (idempotent): appointments completed / marked no-show before this ticket
-- =====================================================================================================

update public.appointments a
set attendance = case a.status when 'completed' then 'present' else 'absent' end,
    attendance_marked_at = coalesce(
      (select e.created_at from public.appointment_events e
       where e.appointment_id = a.id and e.to_status = a.status order by e.id desc limit 1), a.updated_at),
    attendance_marked_by = (select e.actor_user_id from public.appointment_events e
                            where e.appointment_id = a.id and e.to_status = a.status order by e.id desc limit 1),
    billable = public.attendance_billable(
      '{"bill_absent": false, "bill_late_cancel": false, "late_cancel_hours": 24}'::jsonb,
      case a.status when 'completed' then 'present' else 'absent' end,
      coalesce((a.service_snapshot ->> 'fee_inr')::int, 0), lower(a.slot), a.updated_at)
where a.status in ('completed', 'no_show') and a.attendance is null;

-- =====================================================================================================
-- enforce
-- =====================================================================================================

alter table public.organizations drop constraint if exists organizations_attendance_policy_check;
alter table public.organizations
  add constraint organizations_attendance_policy_check check (public.attendance_policy_valid(attendance_policy));

alter table public.appointments drop constraint if exists appointments_attendance_check;
alter table public.appointments
  add constraint appointments_attendance_check
    check (attendance in ('present', 'absent', 'late_cancel_family', 'cancelled_centre'));
-- D-1: the attendance always agrees with 030's status.
alter table public.appointments drop constraint if exists appointments_attendance_status;
alter table public.appointments
  add constraint appointments_attendance_status check (
    attendance is null
    or (attendance = 'present' and status = 'completed')
    or (attendance = 'absent' and status = 'no_show')
    or (attendance in ('late_cancel_family', 'cancelled_centre') and status = 'cancelled')
  );
alter table public.appointments drop constraint if exists appointments_attendance_marked;
alter table public.appointments
  add constraint appointments_attendance_marked check (attendance is null or (attendance_marked_at is not null and billable is not null));

create index if not exists appointments_org_start_idx on public.appointments (org_id, lower(slot));
-- FR-4 `Needs attention`: started, still confirmed, never marked.
create index if not exists appointments_unmarked_idx on public.appointments (org_id, lower(slot))
  where status = 'confirmed' and attendance is null;

-- Keeps the attendance in step when 030's functions are called directly (the schedule's `Mark completed` / `No-show`,
-- a provider cancellation with an attendance reason): the column and `billable` are filled in the same row update.
-- attendance_mark() then records who marked it.
create or replace function public.appointments_attendance_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.attendance is null then
    new.attendance := case
      when new.status = 'completed' then 'present'
      when new.status = 'no_show' then 'absent'
      when new.status = 'cancelled' and new.cancel_reason = 'late_cancel_family' then 'late_cancel_family'
      when new.status = 'cancelled' and new.cancel_reason = 'centre_cancelled' then 'cancelled_centre'
    end;
    if new.attendance is not null then
      new.attendance_marked_at := now();
      new.billable := public.attendance_billable_for(new, new.attendance, now());
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_attendance_sync on public.appointments;
create trigger appointments_attendance_sync before update of status on public.appointments
for each row when (old.status = 'confirmed' and new.status in ('completed', 'no_show', 'cancelled'))
execute function public.appointments_attendance_sync();

-- 031 FR-7 cancellation policy, extended for 044: a late family cancellation recorded by the centre (reason
-- `late_cancel_family`) keeps an online prepayment when the org bills late cancellations (the same rule as `billable`),
-- and is refunded as a guardian cancellation otherwise. Everything else is unchanged.
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
  if new.cancel_reason is not distinct from 'late_cancel_family' then
    if not public.attendance_billable_for(new, 'late_cancel_family', now()) then
      perform public.payment_request_refund(v_payment, 'guardian_cancelled');
    end if;
  elsif new.cancelled_by = 'provider' then
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

-- =====================================================================================================
-- attendance_mark (FR-1 - FR-4, FR-8 audit is written by the caller in the same transaction, NFR-2)
-- Errors (booking_raise, message = code): not_found, invalid_status, invalid_transition, not_started,
-- reason_required, correction_window.
-- Returns { result: marked | corrected | unchanged, appointment_id, org_id, child_id, case_id, from, to, billable,
--           from_status, to_status }.
-- =====================================================================================================

create or replace function public.attendance_mark(p_appointment uuid, p_actor uuid, p_attendance text, p_reason text)
returns jsonb
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

-- ---------- grants ----------
-- attendance_policy_valid / attendance_billable are pure helpers (the first backs a check constraint) and stay callable.
revoke all on function public.attendance_billable_for(public.appointments, text, timestamptz) from public, anon, authenticated;
revoke all on function public.appointments_attendance_sync() from public, anon, authenticated;
revoke all on function public.attendance_mark(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.attendance_billable_for(public.appointments, text, timestamptz) to service_role;
grant execute on function public.attendance_mark(uuid, uuid, text, text) to service_role;
