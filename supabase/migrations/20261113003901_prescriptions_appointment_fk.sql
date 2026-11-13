-- Ticket 039 (after 030 merged): `prescriptions.appointment_id` -> `appointments(id)`.
--
-- ON DELETE SET NULL (not RESTRICT): the appointment link is context, the prescription is the clinical record. An
-- appointment row can disappear through paths owned by other tickets (030 `booking_erase_child` on a 041 erasure, the
-- organisation cascade); RESTRICT would make those fail (or block erasure) because of a signed prescription, and
-- CASCADE would delete a signed prescription. So the link is cleared and the prescription stays.
-- `prescriptions_guard` is redefined so that `appointment_id` may become null on a signed or void prescription (it can
-- still never be set or changed once signed), and a new trigger checks that a linked appointment belongs to the
-- prescription's organisation and to its case or child. Existing rows: `appointment_id` is null everywhere (no API sets
-- it yet), so nothing to backfill and no row violates the FK.

create or replace function public.prescriptions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
  v_child uuid;
begin
  if tg_op = 'DELETE' then
    -- Signed/void prescriptions go only with their case (cascade: the case row is already gone).
    if old.status <> 'draft' and exists (select 1 from public.cases where id = old.case_id)
       and coalesce(current_setting('dnm.privacy_maintenance', true), '') <> 'on' then
      raise exception 'signed prescriptions cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  select c.org_id, c.child_id into v_org, v_child from public.cases c where c.id = new.case_id;
  if not found then
    -- The case is being deleted (cascades may set source_report_id null first): the row goes with it.
    if tg_op = 'UPDATE' then
      return new;
    end if;
    raise exception 'case not found' using errcode = '23503';
  end if;
  if v_child is null then
    raise exception 'case has no child' using errcode = '23502';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a prescription starts as a draft' using errcode = '23514';
    end if;
    new.org_id := v_org;
    new.child_id := v_child;
    return new;
  end if;
  -- created_by / voided_by / source_report_id / appointment_id may only become null (account, AI draft or
  -- appointment deleted).
  if new.case_id <> old.case_id
     or (new.created_by is distinct from old.created_by and new.created_by is not null)
     or (new.source_report_id is distinct from old.source_report_id and new.source_report_id is not null) then
    raise exception 'prescription case and origin cannot change' using errcode = '42501';
  end if;
  if old.status = 'void' then
    if (to_jsonb(new) - 'child_id' - 'updated_at' - 'source_report_id' - 'created_by' - 'voided_by' - 'appointment_id')
       <> (to_jsonb(old) - 'child_id' - 'updated_at' - 'source_report_id' - 'created_by' - 'voided_by' - 'appointment_id')
       or (new.voided_by is distinct from old.voided_by and new.voided_by is not null)
       or (new.appointment_id is distinct from old.appointment_id and new.appointment_id is not null) then
      raise exception 'a void prescription cannot change' using errcode = '42501';
    end if;
  elsif old.status = 'signed' then
    if new.status not in ('signed', 'void')
       or new.prescriber_profile_id <> old.prescriber_profile_id
       or new.current_version <> old.current_version
       or (new.appointment_id is distinct from old.appointment_id and new.appointment_id is not null) then
      raise exception 'a signed prescription cannot change' using errcode = '42501';
    end if;
  elsif new.status = 'void' then
    raise exception 'only a signed prescription can be voided' using errcode = '23514';
  end if;
  new.org_id := v_org;
  new.child_id := v_child;
  return new;
end;
$$;

alter table public.prescriptions
  add constraint prescriptions_appointment_id_fkey
  foreign key (appointment_id) references public.appointments(id) on delete set null;
create index if not exists prescriptions_appointment_idx on public.prescriptions (appointment_id) where appointment_id is not null;

-- Runs after prescriptions_guard (trigger names fire in alphabetical order), so org_id/child_id are the case's.
create or replace function public.prescriptions_guard_appointment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.appointment_id is not null and not exists (
    select 1 from public.appointments a
    where a.id = new.appointment_id and a.org_id = new.org_id
      and (a.case_id = new.case_id or a.child_id = new.child_id)
  ) then
    raise exception 'appointment belongs to another organisation, case or child' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists prescriptions_guard_appointment on public.prescriptions;
create trigger prescriptions_guard_appointment before insert or update of appointment_id on public.prescriptions
for each row when (new.appointment_id is not null)
execute function public.prescriptions_guard_appointment();
