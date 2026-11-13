-- 045: packages and family payments on DoctorNearMe (decision 8: the family pays on DoctorNearMe; 046 pays the centre
-- out per consultation through Razorpay Route). Expand -> backfill -> enforce, additive only:
--   * retire `at_clinic`: existing services become `online` (fee > 0) or `free`; a check keeps it out; providers see a
--     one-time notice (services.migrated_from_at_clinic_at, provider_profiles.at_clinic_notice_dismissed_at);
--     appointments keep their frozen snapshot and are charged when attendance makes them billable (FR-2, FR-4);
--   * packages (org catalogue), child_packages (a package offered to / bought for a child, D-4 per-session value);
--   * payments grow Razorpay payment links: `purpose` appointment (031 orders) | package | balance, link id + short URL,
--     a DoctorNearMe receipt number (FR-6, gap-free per Indian financial year, assigned by a trigger in the capturing
--     transaction) - every captured payment gets one, also 031's one-off prepayments;
--   * family_ledger: the per-child, per-organisation account (charge / payment / refund / adjustment), append-only (D-3,
--     FR-10). Balance due = sum(charge) - sum(payment) + sum(adjustment). A `refund` row records money returned to the
--     family together with the part of the charge it cancels, so it does not change the balance;
--   * fee_link_items (which ledger rows a balance link covers), fee_link_requests (balance links to refresh, consumed by
--     lib/fees/jobs.ts), fee_refunds (partial refunds of link payments: package unused sessions, session charges);
--   * appointments.consultation_amount_paise (+ child_package_id): what one delivered consultation is worth (046 pays it
--     out). One-off prepaid: the payment; package: price / sessions_total rounded down, remainder on the last session;
--     per-session: the fee;
--   * the billing hook: a trigger on appointments reacts to every change of 044's `billable` (first marking, corrections,
--     030's schedule buttons) in the same transaction.
-- Final rule for prepaid one-offs (reconciles 031 + 044): `billable` decides. A prepaid session that ends up not billable
-- (absent without bill_absent, late family cancellation without bill_late_cancel, centre cancellation) is refunded in
-- full; a billable one keeps its payment. Guardian self-cancellations keep 031's 24-hour rule.

-- =====================================================================================================
-- FR-2: retire "pay at clinic"
-- =====================================================================================================

alter table public.services add column if not exists migrated_from_at_clinic_at timestamptz;
alter table public.provider_profiles add column if not exists at_clinic_notice_dismissed_at timestamptz;

update public.services
set payment_mode = case when fee_inr > 0 then 'online' else 'free' end,
    migrated_from_at_clinic_at = now(),
    updated_at = now()
where payment_mode = 'at_clinic';

alter table public.services drop constraint if exists services_payment_mode_045;
alter table public.services
  add constraint services_payment_mode_045 check (payment_mode in ('online', 'free'));

-- =====================================================================================================
-- tables
-- =====================================================================================================

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  session_count int not null check (session_count between 1 and 60),
  price_inr int not null check (price_inr between 1 and 100000),
  validity_days int not null check (validity_days between 7 and 180),
  service_ids uuid[] not null check (cardinality(service_ids) between 1 and 50),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists packages_org_idx on public.packages (org_id, active);

create table if not exists public.child_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  package_id uuid references public.packages(id) on delete set null,
  -- What was offered, frozen (name, session_count, price_inr, validity_days, service_ids).
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  service_ids uuid[] not null check (cardinality(service_ids) between 1 and 50),
  price_paise int not null check (price_paise between 100 and 10000000),
  payment_id uuid,
  starts_on date,
  expires_on date,
  sessions_total int not null check (sessions_total between 1 and 60),
  sessions_used int not null default 0,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'used_up', 'expired', 'cancelled')),
  offer_expires_at timestamptz not null,
  offered_by uuid references auth.users(id) on delete set null,
  cancel_reason text check (char_length(cancel_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint child_packages_used check (sessions_used between 0 and sessions_total),
  constraint child_packages_dates check (
    status in ('pending_payment', 'cancelled') or (starts_on is not null and expires_on is not null and expires_on >= starts_on))
);
create index if not exists child_packages_child_idx on public.child_packages (org_id, child_id, status);

-- Payments: 031 orders + 045 payment links. Link payments belong to an organisation and a child, not an appointment.
alter table public.payments alter column appointment_id drop not null;
alter table public.payments alter column razorpay_order_id drop not null;
alter table public.payments
  add column if not exists purpose text not null default 'appointment',
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists child_id uuid references public.children(id) on delete set null,
  add column if not exists child_package_id uuid references public.child_packages(id) on delete set null,
  add column if not exists razorpay_payment_link_id text unique check (razorpay_payment_link_id ~ '^plink_[A-Za-z0-9]{6,40}$'),
  -- NFR-3: the Razorpay short URL only (no child name, no query string with personal data).
  add column if not exists payment_link_url text check (payment_link_url ~ '^https?://[A-Za-z0-9.:-]+/[A-Za-z0-9/_-]{1,120}$'),
  add column if not exists link_expires_at timestamptz,
  add column if not exists receipt_no text unique check (receipt_no ~ '^DNM/[0-9]{4}-[0-9]{2}/[0-9]{6,}$'),
  add column if not exists created_by uuid references auth.users(id) on delete set null;

alter table public.payments drop constraint if exists payments_purpose_check;
alter table public.payments add constraint payments_purpose_check check (purpose in ('appointment', 'package', 'balance'));
alter table public.payments drop constraint if exists payments_purpose_shape;
alter table public.payments add constraint payments_purpose_shape check (
  (purpose = 'appointment' and appointment_id is not null and razorpay_order_id is not null)
  or (purpose in ('package', 'balance') and appointment_id is null and org_id is not null and razorpay_payment_link_id is not null)
);
-- 045 adds `not_billable` (prepaid session not billable after attendance) and `session_refund` (owner/admin refund).
alter table public.payments drop constraint if exists payments_refund_reason_check;
alter table public.payments add constraint payments_refund_reason_check check (refund_reason in (
  'slot_unavailable', 'appointment_cancelled', 'provider_cancelled', 'guardian_cancelled', 'system_cancelled',
  'amount_mismatch', 'external', 'not_billable', 'session_refund'));
create index if not exists payments_link_open_idx on public.payments (org_id, child_id) where purpose <> 'appointment' and status = 'created';
create index if not exists payments_child_idx on public.payments (child_id) where child_id is not null;

alter table public.child_packages drop constraint if exists child_packages_payment_fk;
alter table public.child_packages
  add constraint child_packages_payment_fk foreign key (payment_id) references public.payments(id) on delete set null;

create table if not exists public.platform_receipt_counters (
  fy text primary key check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  next int not null check (next >= 1)
);

-- The family account. No foreign keys to children / appointments / payments: rows are kept as a financial record even
-- when those rows go (erasure keeps the child row anyway; test clean-up removes them with the maintenance flag).
create table if not exists public.family_ledger (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  child_id uuid not null,
  kind text not null check (kind in ('charge', 'payment', 'refund', 'adjustment')),
  -- Positive for charge / payment / refund; adjustments are signed (+ = the family owes more, - = credit).
  amount_paise int not null check (amount_paise <> 0 and abs(amount_paise) <= 10000000),
  appointment_id uuid,
  child_package_id uuid,
  payment_id uuid,
  -- The row this one settles or reverses (a credit cancelling a charge, a refund of a charge).
  ref_id bigint references public.family_ledger(id),
  note text not null check (char_length(btrim(note)) between 1 and 300),
  receipt_no text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint family_ledger_sign check (kind = 'adjustment' or amount_paise > 0),
  constraint family_ledger_receipt check (receipt_no is null or kind = 'payment')
);
create index if not exists family_ledger_account_idx on public.family_ledger (org_id, child_id, id);
create index if not exists family_ledger_child_idx on public.family_ledger (child_id, id);
create index if not exists family_ledger_appointment_idx on public.family_ledger (appointment_id) where appointment_id is not null;
create index if not exists family_ledger_ref_idx on public.family_ledger (ref_id) where ref_id is not null;
create unique index if not exists family_ledger_one_payment_row on public.family_ledger (payment_id) where kind = 'payment';

create table if not exists public.fee_link_items (
  payment_id uuid not null references public.payments(id) on delete cascade,
  ledger_id bigint not null references public.family_ledger(id) on delete cascade,
  amount_paise int not null check (amount_paise <> 0),
  primary key (payment_id, ledger_id)
);
create index if not exists fee_link_items_ledger_idx on public.fee_link_items (ledger_id);

create table if not exists public.fee_link_requests (
  org_id uuid not null references public.organizations(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  requested_at timestamptz not null default now(),
  primary key (org_id, child_id)
);

create table if not exists public.fee_refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  child_id uuid references public.children(id) on delete set null,
  payment_id uuid not null references public.payments(id) on delete cascade,
  amount_paise int not null check (amount_paise between 1 and 10000000),
  reason text not null check (reason in ('package_unused', 'session_charge', 'not_billable', 'overpaid')),
  child_package_id uuid references public.child_packages(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  charge_ledger_id bigint references public.family_ledger(id) on delete cascade,
  note text check (char_length(note) <= 300),
  status text not null default 'pending' check (status in ('pending', 'processed')),
  razorpay_refund_id text unique check (razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{6,40}$'),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (char_length(last_error) <= 500),
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists fee_refunds_due_idx on public.fee_refunds (next_attempt_at) where status = 'pending';
create index if not exists fee_refunds_payment_idx on public.fee_refunds (payment_id);

alter table public.appointments
  add column if not exists consultation_amount_paise int check (consultation_amount_paise between 0 and 10000000),
  add column if not exists child_package_id uuid references public.child_packages(id) on delete set null;
create index if not exists appointments_child_package_idx on public.appointments (child_package_id) where child_package_id is not null;

-- ---------- RLS: the server (service role) only; every route gates itself ----------
alter table public.packages enable row level security;
alter table public.child_packages enable row level security;
alter table public.platform_receipt_counters enable row level security;
alter table public.family_ledger enable row level security;
alter table public.fee_link_items enable row level security;
alter table public.fee_link_requests enable row level security;
alter table public.fee_refunds enable row level security;
revoke all on public.packages, public.child_packages, public.platform_receipt_counters, public.family_ledger,
  public.fee_link_items, public.fee_link_requests, public.fee_refunds from public, anon, authenticated;
grant select, insert, update, delete on public.packages, public.child_packages, public.platform_receipt_counters,
  public.fee_link_items, public.fee_link_requests, public.fee_refunds to service_role;
grant select, insert on public.family_ledger to service_role;

-- =====================================================================================================
-- D-3 / FR-10: the ledger is append-only (only the maintenance flag - test clean-up - may delete rows)
-- =====================================================================================================

create or replace function public.family_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_level = 'ROW' and tg_op = 'DELETE' and current_setting('dnm.ledger_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'family_ledger is append-only: fix mistakes with an adjustment' using errcode = '42501';
end;
$$;

drop trigger if exists family_ledger_no_update on public.family_ledger;
create trigger family_ledger_no_update before update or delete on public.family_ledger
for each row execute function public.family_ledger_append_only();
drop trigger if exists family_ledger_no_truncate on public.family_ledger;
create trigger family_ledger_no_truncate before truncate on public.family_ledger
for each statement execute function public.family_ledger_append_only();

-- =====================================================================================================
-- FR-6 receipts: DNM/<FY>/<000001>, Indian financial year (1 April - 31 March, Asia/Kolkata), gap-free: the counter
-- row is incremented in the capturing transaction (a rollback gives the number back; the row lock serialises).
-- =====================================================================================================

create or replace function public.fees_financial_year(p_at timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case when extract(month from local_at) >= 4
              then extract(year from local_at)::int::text || '-' || lpad(((extract(year from local_at)::int + 1) % 100)::text, 2, '0')
              else (extract(year from local_at)::int - 1)::text || '-' || lpad((extract(year from local_at)::int % 100)::text, 2, '0')
         end
  from (select p_at at time zone 'Asia/Kolkata' as local_at) t;
$$;

create or replace function public.fees_next_receipt_no(p_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fy text := public.fees_financial_year(coalesce(p_at, now()));
  v_n int;
begin
  insert into public.platform_receipt_counters as c (fy, next) values (v_fy, 2)
  on conflict (fy) do update set next = c.next + 1
  returning c.next - 1 into v_n;
  return 'DNM/' || v_fy || '/' || lpad(v_n::text, 6, '0');
end;
$$;

create or replace function public.payments_assign_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'captured' and new.receipt_no is null
     and (tg_op = 'INSERT' or old.status is distinct from 'captured') then
    new.receipt_no := public.fees_next_receipt_no(coalesce(new.captured_at, now()));
  end if;
  return new;
end;
$$;

drop trigger if exists payments_assign_receipt on public.payments;
create trigger payments_assign_receipt before insert or update of status on public.payments
for each row execute function public.payments_assign_receipt();

-- Backfill: payments captured before this ticket get their receipt numbers in capture order.
do $$
declare
  r record;
begin
  for r in select id, coalesce(captured_at, updated_at) as at from public.payments
           where receipt_no is null and status in ('captured', 'refund_pending', 'refunded')
           order by coalesce(captured_at, updated_at), id
  loop
    update public.payments set receipt_no = public.fees_next_receipt_no(r.at) where id = r.id;
  end loop;
end;
$$;

-- =====================================================================================================
-- account helpers
-- =====================================================================================================

create or replace function public.fees_raise(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using message = p_code, errcode = 'P0001', hint = 'fees';
end;
$$;

-- Balance due (paise): charges - payments + adjustments. Refunds return money together with the part of a charge they
-- cancel, so they do not move the balance. Negative = the family has credit (e.g. a refund still being processed).
create or replace function public.fees_balance(p_org uuid, p_child uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case kind when 'charge' then amount_paise when 'payment' then -amount_paise
                                when 'adjustment' then amount_paise else 0 end), 0)::bigint
  from public.family_ledger where org_id = p_org and child_id = p_child;
$$;

-- A charge is void once a credit / refund points at it or a refund of it is pending.
create or replace function public.fees_charge_void(p_ledger bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.family_ledger v where v.ref_id = p_ledger)
      or exists (select 1 from public.fee_refunds r where r.charge_ledger_id = p_ledger);
$$;

-- The captured payment that settled a ledger row (charge / adjustment): set on the row (one-off, package) or a captured
-- balance link that covered it.
create or replace function public.fees_settled_by(p_ledger bigint)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select l.payment_id from public.family_ledger l where l.id = p_ledger and l.kind = 'charge'),
    (select i.payment_id from public.fee_link_items i join public.payments p on p.id = i.payment_id
     where i.ledger_id = p_ledger and p.status in ('captured', 'refund_pending', 'refunded')
     order by p.captured_at limit 1));
$$;

-- What a balance link must cover now: per-session charges and manual adjustments that are neither settled nor void.
-- Their sum equals fees_balance() (tests assert it).
create or replace function public.fees_open_items(p_org uuid, p_child uuid)
returns table (ledger_id bigint, kind text, amount_paise int, appointment_id uuid, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.kind, l.amount_paise, l.appointment_id, l.created_at
  from public.family_ledger l
  where l.org_id = p_org and l.child_id = p_child
    and ((l.kind = 'charge' and l.child_package_id is null and l.payment_id is null) or (l.kind = 'adjustment' and l.ref_id is null))
    and not exists (select 1 from public.fee_link_items i join public.payments p on p.id = i.payment_id
                    where i.ledger_id = l.id and p.status in ('captured', 'refund_pending', 'refunded'))
    and not (l.kind = 'charge' and public.fees_charge_void(l.id))
  order by l.id;
$$;

create or replace function public.fees_request_link(p_org uuid, p_child uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.fee_link_requests (org_id, child_id) values (p_org, p_child)
  on conflict (org_id, child_id) do update set requested_at = now();
$$;

-- The appointment's open per-session charge (latest charge row that is not void).
create or replace function public.fees_open_charge(p_appointment uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select l.id from public.family_ledger l
  where l.appointment_id = p_appointment and l.kind = 'charge' and l.child_package_id is null and l.payment_id is null
    and not public.fees_charge_void(l.id)
  order by l.id desc limit 1;
$$;

-- =====================================================================================================
-- FR-4: the billing hook. Runs whenever 044's `billable` changes (first marking, correction, 030's schedule buttons),
-- inside that transaction (the appointment row is already locked by the update).
-- =====================================================================================================

create or replace function public.fees_apply_billable(p_appointment uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  pay public.payments;
  pkg public.child_packages;
  v_fee int;
  v_n int;
  v_amount int;
  v_charge bigint;
  v_settled uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into a from public.appointments where id = p_appointment;
  if not found or a.child_id is null or a.is_demo then
    return jsonb_build_object('result', 'skipped');
  end if;

  if a.billable then
    if a.consultation_amount_paise is not null then
      return jsonb_build_object('result', 'unchanged');
    end if;
    v_fee := coalesce((a.service_snapshot ->> 'fee_inr')::int, 0) * 100;
    if v_fee <= 0 then
      return jsonb_build_object('result', 'free');
    end if;

    -- 1. One-off prepaid online (031): the payment is the consultation amount.
    select * into pay from public.payments
    where appointment_id = a.id and purpose = 'appointment' and status = 'captured' limit 1;
    if found then
      update public.appointments set consultation_amount_paise = pay.amount_paise where id = a.id;
      return jsonb_build_object('result', 'prepaid', 'amount_paise', pay.amount_paise);
    end if;

    -- 2. An active package of this organisation that covers the service (earliest expiry first).
    select * into pkg from public.child_packages cp
    where cp.org_id = a.org_id and cp.child_id = a.child_id and cp.status = 'active'
      and cp.expires_on >= v_today and cp.sessions_used < cp.sessions_total
      and a.service_id is not null and a.service_id = any(cp.service_ids)
    order by cp.expires_on, cp.created_at
    limit 1
    for update;
    if found then
      v_n := pkg.sessions_used + 1;
      if v_n >= pkg.sessions_total then
        -- D-4: the last session takes the remainder, so the sessions add up to the price exactly.
        v_amount := pkg.price_paise - coalesce((select sum(x.consultation_amount_paise) from public.appointments x
                                                 where x.child_package_id = pkg.id and x.id <> a.id), 0);
      else
        v_amount := pkg.price_paise / pkg.sessions_total;
      end if;
      update public.child_packages
      set sessions_used = v_n, status = case when v_n >= sessions_total then 'used_up' else 'active' end, updated_at = now()
      where id = pkg.id;
      update public.appointments set consultation_amount_paise = v_amount, child_package_id = pkg.id where id = a.id;
      return jsonb_build_object('result', 'package', 'child_package_id', pkg.id, 'amount_paise', v_amount,
                                'sessions_used', v_n, 'sessions_total', pkg.sessions_total);
    end if;

    -- 3. Per-session charge (also legacy at_clinic appointments and package series without a package): a ledger
    -- charge and a balance payment link (created by the fee job right after the response, lib/fees/jobs.ts).
    insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, note)
    values (a.org_id, a.child_id, 'charge', v_fee, a.id, 'session');
    perform public.fees_request_link(a.org_id, a.child_id);
    update public.appointments set consultation_amount_paise = v_fee where id = a.id;
    return jsonb_build_object('result', 'charged', 'amount_paise', v_fee);
  end if;

  -- Not billable (any more): undo what the billable marking did.
  if a.child_package_id is not null then
    update public.child_packages
    set sessions_used = greatest(sessions_used - 1, 0),
        status = case when status = 'used_up' and expires_on >= v_today then 'active' else status end,
        updated_at = now()
    where id = a.child_package_id;
    update public.appointments set consultation_amount_paise = null, child_package_id = null where id = a.id;
    return jsonb_build_object('result', 'package_session_returned', 'child_package_id', a.child_package_id);
  end if;

  select * into pay from public.payments
  where appointment_id = a.id and purpose = 'appointment' and status = 'captured' limit 1;
  if found then
    -- Cancellations are handled by 031/044's cancellation trigger (same rule); absences and corrections here.
    if a.status <> 'cancelled' then
      perform public.payment_request_refund(pay.id, 'not_billable');
    end if;
    update public.appointments set consultation_amount_paise = null where id = a.id;
    return jsonb_build_object('result', 'prepaid_refund', 'payment_id', pay.id);
  end if;

  v_charge := public.fees_open_charge(a.id);
  if v_charge is not null then
    v_settled := public.fees_settled_by(v_charge);
    if v_settled is not null then
      insert into public.fee_refunds (org_id, child_id, payment_id, amount_paise, reason, appointment_id, charge_ledger_id, note)
      select a.org_id, a.child_id, v_settled, l.amount_paise, 'not_billable', a.id, l.id, 'Session no longer billable'
      from public.family_ledger l where l.id = v_charge;
    else
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, ref_id, note)
      select a.org_id, a.child_id, 'adjustment', -l.amount_paise, a.id, l.id, 'session_not_billable'
      from public.family_ledger l where l.id = v_charge;
      perform public.fees_request_link(a.org_id, a.child_id);
    end if;
  end if;
  if a.consultation_amount_paise is not null then
    update public.appointments set consultation_amount_paise = null where id = a.id;
  end if;
  return jsonb_build_object('result', case when v_charge is null then 'nothing' else 'charge_cancelled' end);
end;
$$;

create or replace function public.appointments_fees_on_billable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fees_apply_billable(new.id);
  return null;
end;
$$;

drop trigger if exists appointments_fees_on_billable on public.appointments;
create trigger appointments_fees_on_billable after update on public.appointments
for each row when (old.billable is distinct from new.billable and new.billable is not null)
execute function public.appointments_fees_on_billable();

-- =====================================================================================================
-- 031 payments in the ledger: a captured one-off prepayment is a charge + a payment (receipt), its refund a refund row;
-- every capture (one-off, package, balance) sends the guardian their receipt (FR-6) in the same transaction.
-- =====================================================================================================

create or replace function public.payments_fees_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_charge bigint;
  v_child uuid;
begin
  if new.status = 'captured' and old.status is distinct from 'captured' and old.status not in ('refund_pending', 'refunded') then
    if new.purpose = 'appointment' then
      select * into a from public.appointments where id = new.appointment_id;
      if found and a.child_id is not null and not exists (select 1 from public.family_ledger where payment_id = new.id and kind = 'payment') then
        insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, payment_id, note)
        values (a.org_id, a.child_id, 'charge', new.amount_paise, a.id, new.id, 'appointment');
        insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, payment_id, note, receipt_no)
        values (a.org_id, a.child_id, 'payment', new.amount_paise, a.id, new.id, 'appointment', new.receipt_no);
      end if;
      v_child := a.child_id;
    else
      v_child := new.child_id;
    end if;
    if v_child is not null then
      perform public.outbox_enqueue('fees.receipt', 'payment', new.id,
        jsonb_build_object('payment_id', new.id, 'child_id', v_child), 'payment:' || new.id || ':receipt', now());
    end if;
  elsif new.status = 'refunded' and old.status is distinct from 'refunded' and new.purpose = 'appointment' then
    select l.id into v_charge from public.family_ledger l where l.payment_id = new.id and l.kind = 'charge' limit 1;
    if v_charge is not null then
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, payment_id, ref_id, note)
      select l.org_id, l.child_id, 'refund', new.amount_paise, l.appointment_id, new.id, l.id,
             coalesce(new.refund_reason, 'refund')
      from public.family_ledger l where l.id = v_charge;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists payments_fees_ledger on public.payments;
create trigger payments_fees_ledger after update of status on public.payments
for each row execute function public.payments_fees_ledger();

-- Backfill: 031 one-off payments captured before this ticket (charge + payment; refund rows for refunded ones).
insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, payment_id, note, created_at)
select a.org_id, a.child_id, 'charge', p.amount_paise, a.id, p.id, 'appointment', coalesce(p.captured_at, p.updated_at)
from public.payments p join public.appointments a on a.id = p.appointment_id
where p.purpose = 'appointment' and p.status in ('captured', 'refund_pending', 'refunded') and a.child_id is not null
  and not exists (select 1 from public.family_ledger l where l.payment_id = p.id);
insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, payment_id, note, receipt_no, created_at)
select a.org_id, a.child_id, 'payment', p.amount_paise, a.id, p.id, 'appointment', p.receipt_no, coalesce(p.captured_at, p.updated_at)
from public.payments p join public.appointments a on a.id = p.appointment_id
where p.purpose = 'appointment' and p.status in ('captured', 'refund_pending', 'refunded') and a.child_id is not null
  and not exists (select 1 from public.family_ledger l where l.payment_id = p.id and l.kind = 'payment');
insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, payment_id, ref_id, note, created_at)
select l.org_id, l.child_id, 'refund', p.amount_paise, l.appointment_id, p.id, l.id, coalesce(p.refund_reason, 'refund'),
       coalesce(p.refunded_at, p.updated_at)
from public.payments p join public.family_ledger l on l.payment_id = p.id and l.kind = 'charge'
where p.status = 'refunded'
  and not exists (select 1 from public.family_ledger r where r.payment_id = p.id and r.kind = 'refund');

-- =====================================================================================================
-- FR-3 / FR-5: a payment link was paid (webhook `payment_link.paid`, the signed redirect, the demo gateway). One
-- transaction, idempotent. Package -> active + charge + payment; balance -> payment (+ refunds of anything it covered
-- that was cancelled meanwhile). Amount mismatch / package no longer available -> captured and refunded in full.
-- =====================================================================================================

create or replace function public.fees_apply_link_paid(
  p_link_id text, p_payment_id text, p_amount_paise int default null, p_captured_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  pkg public.child_packages;
  it record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_outcome text;
  v_refund boolean := false;
begin
  if p_payment_id is null or p_payment_id !~ '^pay_[A-Za-z0-9]{6,40}$' then
    perform public.fees_raise('payment_conflict');
  end if;
  select * into pay from public.payments where razorpay_payment_link_id = p_link_id for update;
  if not found then
    perform public.fees_raise('payment_not_found');
  end if;
  if pay.status in ('captured', 'refund_pending', 'refunded') then
    return jsonb_build_object('payment_id', pay.id, 'outcome',
      case when pay.razorpay_payment_id = p_payment_id then 'already_captured' else 'duplicate_payment' end,
      'payment_status', pay.status, 'receipt_no', pay.receipt_no);
  end if;
  if exists (select 1 from public.payments where razorpay_payment_id = p_payment_id and id <> pay.id) then
    perform public.fees_raise('payment_conflict');
  end if;

  update public.payments
  set status = 'captured', razorpay_payment_id = p_payment_id, failure_reason = null, updated_at = now(),
      -- The gateway's payment time when known (receipt date and financial year), never in the future.
      captured_at = least(coalesce(p_captured_at, now()), now())
  where id = pay.id
  returning * into pay;

  if p_amount_paise is not null and p_amount_paise <> pay.amount_paise then
    v_refund := true;
    v_outcome := 'refund_amount_mismatch';
  elsif pay.purpose = 'package' then
    select * into pkg from public.child_packages where id = pay.child_package_id for update;
    if not found or pkg.status <> 'pending_payment' then
      v_refund := true;
      v_outcome := 'refund_package_unavailable';
    else
      update public.child_packages
      set status = 'active', starts_on = v_today,
          expires_on = v_today + greatest(((snapshot ->> 'validity_days')::int) - 1, 0),
          payment_id = pay.id, updated_at = now()
      where id = pkg.id;
      v_outcome := 'package_active';
    end if;
  else
    v_outcome := 'balance_paid';
  end if;

  if pay.child_id is not null then
    if v_refund then
      -- Money we cannot use: recorded as paid and returned in full.
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, payment_id, note)
      values (pay.org_id, pay.child_id, 'charge', pay.amount_paise, pay.id, 'unallocated_payment');
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, payment_id, note, receipt_no)
      values (pay.org_id, pay.child_id, 'payment', pay.amount_paise, pay.id, pay.purpose, pay.receipt_no);
      insert into public.fee_refunds (org_id, child_id, payment_id, amount_paise, reason, charge_ledger_id, note)
      select pay.org_id, pay.child_id, pay.id, pay.amount_paise, 'overpaid', l.id, v_outcome
      from public.family_ledger l where l.payment_id = pay.id and l.kind = 'charge';
    elsif pay.purpose = 'package' then
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, child_package_id, payment_id, note)
      values (pay.org_id, pay.child_id, 'charge', pay.amount_paise, pkg.id, pay.id, 'package');
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, child_package_id, payment_id, note, receipt_no)
      values (pay.org_id, pay.child_id, 'payment', pay.amount_paise, pkg.id, pay.id, 'package', pay.receipt_no);
    else
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, payment_id, note, receipt_no)
      values (pay.org_id, pay.child_id, 'payment', pay.amount_paise, pay.id, 'balance', pay.receipt_no);
      -- Charges this link covered that were cancelled after it was created: paid anyway -> re-applied and refunded.
      for it in
        select i.ledger_id, i.amount_paise from public.fee_link_items i join public.family_ledger l on l.id = i.ledger_id
        where i.payment_id = pay.id and l.kind = 'charge' and exists (select 1 from public.family_ledger v where v.ref_id = l.id)
          and not exists (select 1 from public.fee_refunds r where r.charge_ledger_id = l.id)
      loop
        insert into public.family_ledger (org_id, child_id, kind, amount_paise, payment_id, ref_id, note)
        values (pay.org_id, pay.child_id, 'adjustment', it.amount_paise, pay.id, it.ledger_id, 'paid_after_cancel');
        insert into public.fee_refunds (org_id, child_id, payment_id, amount_paise, reason, charge_ledger_id, note)
        values (pay.org_id, pay.child_id, pay.id, it.amount_paise, 'overpaid', it.ledger_id, 'paid_after_cancel');
      end loop;
      perform public.fees_request_link(pay.org_id, pay.child_id);
    end if;
  end if;

  return jsonb_build_object('payment_id', pay.id, 'outcome', v_outcome, 'payment_status', pay.status,
                            'receipt_no', pay.receipt_no, 'purpose', pay.purpose, 'child_package_id', pay.child_package_id,
                            'refund', v_refund);
end;
$$;

-- A link expired or was cancelled at Razorpay (or replaced by us): the payment row closes; a pending package offer is
-- withdrawn with it.
create or replace function public.fees_close_link(p_link_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
begin
  select * into pay from public.payments where razorpay_payment_link_id = p_link_id for update;
  if not found then
    perform public.fees_raise('payment_not_found');
  end if;
  if pay.status not in ('created', 'authorized') then
    return jsonb_build_object('payment_id', pay.id, 'outcome', 'ignored', 'payment_status', pay.status);
  end if;
  update public.payments set status = 'failed', failure_reason = left(p_reason, 300), updated_at = now() where id = pay.id;
  if pay.purpose = 'package' then
    update public.child_packages set status = 'cancelled', cancel_reason = left(p_reason, 300), updated_at = now()
    where id = pay.child_package_id and status = 'pending_payment';
  end if;
  return jsonb_build_object('payment_id', pay.id, 'outcome', 'closed', 'payment_status', 'failed');
end;
$$;

-- A fee refund went through (refund job or `refund.processed`): one `refund` row + the guardian's notification.
create or replace function public.fees_mark_refund_processed(p_fee_refund uuid, p_refund_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.fee_refunds;
  v_ref bigint;
  v_event bigint;
begin
  select * into r from public.fee_refunds where id = p_fee_refund for update;
  if not found then
    perform public.fees_raise('refund_not_found');
  end if;
  if r.status = 'processed' then
    return jsonb_build_object('fee_refund_id', r.id, 'outcome', 'already_processed');
  end if;
  update public.fee_refunds
  set status = 'processed', razorpay_refund_id = coalesce(razorpay_refund_id, p_refund_id), processed_at = now(),
      locked_until = null, last_error = null
  where id = r.id;
  v_ref := coalesce(r.charge_ledger_id,
    (select l.id from public.family_ledger l where l.child_package_id = r.child_package_id and l.kind = 'charge'
     and r.child_package_id is not null order by l.id limit 1));
  if r.child_id is not null then
    insert into public.family_ledger (org_id, child_id, kind, amount_paise, appointment_id, child_package_id, payment_id, ref_id, note, created_by)
    values (r.org_id, r.child_id, 'refund', r.amount_paise, r.appointment_id, r.child_package_id, r.payment_id, v_ref,
            r.reason, r.requested_by);
    v_event := public.outbox_enqueue('fees.refunded', 'fee_refund', r.id,
      jsonb_build_object('fee_refund_id', r.id, 'child_id', r.child_id), 'fee_refund:' || r.id || ':processed', now());
  end if;
  return jsonb_build_object('fee_refund_id', r.id, 'outcome', 'processed', 'event_id', v_event);
end;
$$;

-- =====================================================================================================
-- 046 seam: what one delivered consultation is worth and which captured payment funds it.
-- =====================================================================================================

create or replace function public.fees_consultations(p_org uuid default null, p_appointment uuid default null)
returns table (
  appointment_id uuid,
  org_id uuid,
  child_id uuid,
  source text,
  consultation_amount_paise int,
  payment_id uuid,
  razorpay_payment_id text,
  payment_amount_paise int,
  refunded_paise bigint,
  child_package_id uuid,
  marked_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with billable as (
    select a.* from public.appointments a
    where a.billable and a.consultation_amount_paise is not null
      and (p_org is null or a.org_id = p_org) and (p_appointment is null or a.id = p_appointment)
  ), funding as (
    select b.id as appointment_id,
      case when b.child_package_id is not null then 'package'
           when exists (select 1 from public.payments p where p.appointment_id = b.id and p.purpose = 'appointment'
                        and p.status in ('captured', 'refund_pending', 'refunded')) then 'one_off'
           else 'per_session' end as source,
      coalesce(
        (select cp.payment_id from public.child_packages cp where cp.id = b.child_package_id),
        (select p.id from public.payments p where p.appointment_id = b.id and p.purpose = 'appointment'
         and p.status in ('captured', 'refund_pending', 'refunded') limit 1),
        (select public.fees_settled_by(public.fees_open_charge(b.id)))) as payment_id
    from billable b
  )
  select b.id, b.org_id, b.child_id, f.source, b.consultation_amount_paise, p.id, p.razorpay_payment_id, p.amount_paise,
    (case when p.status = 'refunded' then p.amount_paise else 0 end
     + coalesce((select sum(r.amount_paise) from public.fee_refunds r where r.payment_id = p.id and r.status = 'processed'), 0))::bigint,
    b.child_package_id, b.attendance_marked_at
  from billable b join funding f on f.appointment_id = b.id
  left join public.payments p on p.id = f.payment_id;
$$;

-- ---------- grants: the server (service role) only ----------
revoke all on function public.family_ledger_append_only() from public, anon, authenticated;
revoke all on function public.fees_financial_year(timestamptz) from public, anon, authenticated;
revoke all on function public.fees_next_receipt_no(timestamptz) from public, anon, authenticated;
revoke all on function public.payments_assign_receipt() from public, anon, authenticated;
revoke all on function public.fees_raise(text) from public, anon, authenticated;
revoke all on function public.fees_balance(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fees_charge_void(bigint) from public, anon, authenticated;
revoke all on function public.fees_settled_by(bigint) from public, anon, authenticated;
revoke all on function public.fees_open_items(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fees_request_link(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fees_open_charge(uuid) from public, anon, authenticated;
revoke all on function public.fees_apply_billable(uuid) from public, anon, authenticated;
revoke all on function public.appointments_fees_on_billable() from public, anon, authenticated;
revoke all on function public.payments_fees_ledger() from public, anon, authenticated;
revoke all on function public.fees_apply_link_paid(text, text, int, timestamptz) from public, anon, authenticated;
revoke all on function public.fees_close_link(text, text) from public, anon, authenticated;
revoke all on function public.fees_mark_refund_processed(uuid, text) from public, anon, authenticated;
revoke all on function public.fees_consultations(uuid, uuid) from public, anon, authenticated;

grant execute on function public.fees_financial_year(timestamptz) to service_role;
grant execute on function public.fees_next_receipt_no(timestamptz) to service_role;
grant execute on function public.fees_balance(uuid, uuid) to service_role;
grant execute on function public.fees_charge_void(bigint) to service_role;
grant execute on function public.fees_settled_by(bigint) to service_role;
grant execute on function public.fees_open_items(uuid, uuid) to service_role;
grant execute on function public.fees_request_link(uuid, uuid) to service_role;
grant execute on function public.fees_open_charge(uuid) to service_role;
grant execute on function public.fees_apply_billable(uuid) to service_role;
grant execute on function public.fees_apply_link_paid(text, text, int, timestamptz) to service_role;
grant execute on function public.fees_close_link(text, text) to service_role;
grant execute on function public.fees_mark_refund_processed(uuid, text) to service_role;
grant execute on function public.fees_consultations(uuid, uuid) to service_role;
