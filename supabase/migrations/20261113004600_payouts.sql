-- 046: payouts to centres and the platform fee (Razorpay Route; decision 8: the family pays on DoctorNearMe, DoctorNearMe
-- pays the centre per delivered consultation, minus a platform fee + GST on the fee). Additive only (expand; nothing to
-- backfill: legacy organisations have no payout account row and no fee policy row, which means "not set up", or - in
-- DEMO_MODE only - a fake active demo account, decided by the caller through p_demo).
--   * org_payout_accounts: the centre's Route linked account (set by a platform admin after KYC in the Razorpay
--     dashboard, a human step); platform_fee_policies (+ versions, acceptances): what DoctorNearMe keeps;
--   * payout_items: exactly one per billable consultation (unique appointment_id), or one per unused session of an
--     expired package paid out under `pay_centre` (FR-6); payout_transfers: every Route transfer attempt of an item
--     (one open transfer per item; NFR-3 is checked against the source payment when a transfer is claimed);
--   * platform_invoices (+ gap-free counter): the monthly platform-fee tax invoice per centre (FR-7);
--   * payout_reconciliation_flags: payments where transferred + refunded + platform share <> captured (FR-10).
-- Items are created by the payout job (lib/payouts/jobs.ts -> payouts_sync), which passes the env defaults
-- (PLATFORM_FEE_DEFAULT_BPS, PLATFORM_GST_BPS); the job runs every minute and right after attendance marking, captures
-- and webhooks (Next.js after()). Everything is service-role only; every route gates itself.

-- =====================================================================================================
-- organisation settings
-- =====================================================================================================

-- FR-6: what happens to the unused sessions of an expired package.
alter table public.organizations
  add column if not exists package_expiry_policy text not null default 'pay_centre';
alter table public.organizations drop constraint if exists organizations_package_expiry_policy_check;
alter table public.organizations
  add constraint organizations_package_expiry_policy_check check (package_expiry_policy in ('pay_centre', 'refund_family'));

-- FR-6: an expired package is settled once (paid out or refunded).
alter table public.child_packages
  add column if not exists expiry_settled_at timestamptz,
  add column if not exists expiry_outcome text;
alter table public.child_packages drop constraint if exists child_packages_expiry_outcome_check;
alter table public.child_packages
  add constraint child_packages_expiry_outcome_check
    check (expiry_outcome is null or expiry_outcome in ('pay_centre', 'refund_family', 'nothing_unused', 'not_paid'));

-- =====================================================================================================
-- tables
-- =====================================================================================================

create table if not exists public.org_payout_accounts (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- The Route linked account (acc_...). Set by a platform admin; KYC happens in the Razorpay dashboard.
  razorpay_account_id text check (razorpay_account_id ~ '^acc_[A-Za-z0-9]{6,40}$'),
  status text not null default 'not_started' check (status in ('not_started', 'pending_kyc', 'active', 'suspended')),
  legal_name text check (char_length(legal_name) <= 200),
  -- The centre's GSTIN for the platform-fee invoice, if registered (owner/admin, FR-7).
  gstin text check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint org_payout_accounts_linked check (status not in ('active', 'suspended') or razorpay_account_id is not null)
);

create table if not exists public.platform_fee_policies (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('percent', 'flat')),
  percent_bps int check (percent_bps between 0 and 3000),
  flat_paise int check (flat_paise between 0 and 10000000),
  min_paise int not null default 0 check (min_paise between 0 and 10000000),
  cap_paise int check (cap_paise between 0 and 10000000),
  -- D-5: free pilot month - no fee for consultations on or before this date (Asia/Kolkata).
  waived_until date,
  version int not null default 1 check (version >= 1),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint platform_fee_policies_shape check (
    (kind = 'percent' and percent_bps is not null and flat_paise is null)
    or (kind = 'flat' and flat_paise is not null and percent_bps is null)),
  constraint platform_fee_policies_cap check (cap_paise is null or cap_paise >= min_paise)
);

-- Every version of an organisation's policy (FR-9: a new version on each change). Version 0 = the platform default.
create table if not exists public.platform_fee_policy_versions (
  org_id uuid not null references public.organizations(id) on delete cascade,
  version int not null check (version >= 1),
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, version)
);

-- FR-8: the owner accepts each policy version once (version 0 = the platform default, with the policy it showed).
create table if not exists public.fee_policy_acceptances (
  org_id uuid not null references public.organizations(id) on delete cascade,
  policy_version int not null check (policy_version >= 0),
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz not null default now(),
  primary key (org_id, policy_version)
);

create table if not exists public.platform_invoice_counters (
  fy text primary key check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  next int not null check (next >= 1)
);

create table if not exists public.platform_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- First day of the invoiced month (Asia/Kolkata).
  period_month date not null check (extract(day from period_month) = 1),
  fee_paise int not null check (fee_paise > 0),
  gst_paise int not null check (gst_paise >= 0),
  gross_paise bigint not null check (gross_paise >= 0),
  item_count int not null check (item_count > 0),
  invoice_no text not null unique check (invoice_no ~ '^DNM-INV/[0-9]{4}-[0-9]{2}/[0-9]{4,}$'),
  -- The download path of the PDF (rendered on demand from this immutable row: lib/payouts/invoice.ts).
  pdf_path text not null,
  -- Who the invoice is from / to, frozen at issue (legal names and GSTINs).
  centre jsonb not null check (jsonb_typeof(centre) = 'object'),
  platform jsonb not null check (jsonb_typeof(platform) = 'object'),
  issued_at timestamptz not null default now(),
  unique (org_id, period_month)
);

create table if not exists public.payout_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'consultation' check (kind in ('consultation', 'package_expiry')),
  appointment_id uuid unique references public.appointments(id) on delete cascade,
  -- package_expiry: the package and the unused session (1..n) this item pays out.
  child_package_id uuid references public.child_packages(id) on delete cascade,
  unit_no int check (unit_no between 1 and 60),
  -- The captured payment that funds it (the Route transfer source).
  payment_id uuid not null references public.payments(id) on delete cascade,
  consultation_on date not null,
  consultation_paise int not null check (consultation_paise between 0 and 10000000),
  fee_paise int not null check (fee_paise >= 0),
  gst_paise int not null check (gst_paise >= 0),
  net_paise int not null check (net_paise >= 0),
  fee_policy_version int not null default 0,
  fee_waived boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'transferred', 'on_hold', 'released', 'reversed', 'failed')),
  razorpay_transfer_id text,
  attempts int not null default 0,
  next_attempt_at timestamptz default now(),
  locked_until timestamptz,
  failure_reason text check (char_length(failure_reason) <= 300),
  transferred_at timestamptz,
  processed_at timestamptz,
  reverse_requested_at timestamptz,
  reverse_reason text check (reverse_reason in ('not_billable', 'refund', 'admin')),
  reversed_at timestamptz,
  invoice_id uuid references public.platform_invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_items_net check (net_paise = consultation_paise - fee_paise - gst_paise),
  constraint payout_items_shape check (
    (kind = 'consultation' and appointment_id is not null and unit_no is null)
    or (kind = 'package_expiry' and appointment_id is null and child_package_id is not null and unit_no is not null))
);
create unique index if not exists payout_items_expiry_unit on public.payout_items (child_package_id, unit_no) where kind = 'package_expiry';
create index if not exists payout_items_org_idx on public.payout_items (org_id, consultation_on desc);
create index if not exists payout_items_payment_idx on public.payout_items (payment_id);
create index if not exists payout_items_due_idx on public.payout_items (next_attempt_at) where status in ('pending', 'failed');
create index if not exists payout_items_reverse_idx on public.payout_items (reverse_requested_at) where reverse_requested_at is not null;

create table if not exists public.payout_transfers (
  id uuid primary key default gen_random_uuid(),
  payout_item_id uuid not null references public.payout_items(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  account_id text not null,
  amount_paise int not null check (amount_paise > 0),
  on_hold boolean not null default false,
  -- creating: claimed, the API call is in flight or its outcome is unknown (the next attempt looks it up by our id).
  status text not null default 'creating' check (status in ('creating', 'created', 'processed', 'failed', 'reversed')),
  razorpay_transfer_id text unique check (razorpay_transfer_id ~ '^trf_[A-Za-z0-9]{6,40}$'),
  razorpay_reversal_id text unique check (razorpay_reversal_id ~ '^rvrsl_[A-Za-z0-9]{6,40}$'),
  reversed_paise int not null default 0 check (reversed_paise >= 0),
  failure_reason text check (char_length(failure_reason) <= 300),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  failed_at timestamptz,
  released_at timestamptz,
  reversed_at timestamptz,
  constraint payout_transfers_reversal check (reversed_paise <= amount_paise)
);
-- One open transfer per item at a time.
create unique index if not exists payout_transfers_one_open on public.payout_transfers (payout_item_id)
  where status in ('creating', 'created', 'processed');
create index if not exists payout_transfers_payment_idx on public.payout_transfers (payment_id);

create table if not exists public.payout_reconciliation_flags (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  captured_paise int not null,
  transferred_paise bigint not null,
  platform_share_paise bigint not null,
  refunded_paise bigint not null,
  diff_paise bigint not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists payout_reconciliation_open on public.payout_reconciliation_flags (payment_id) where resolved_at is null;

-- ---------- RLS: the server (service role) only ----------
alter table public.org_payout_accounts enable row level security;
alter table public.platform_fee_policies enable row level security;
alter table public.platform_fee_policy_versions enable row level security;
alter table public.fee_policy_acceptances enable row level security;
alter table public.platform_invoice_counters enable row level security;
alter table public.platform_invoices enable row level security;
alter table public.payout_items enable row level security;
alter table public.payout_transfers enable row level security;
alter table public.payout_reconciliation_flags enable row level security;
revoke all on public.org_payout_accounts, public.platform_fee_policies, public.platform_fee_policy_versions,
  public.fee_policy_acceptances, public.platform_invoice_counters, public.platform_invoices, public.payout_items,
  public.payout_transfers, public.payout_reconciliation_flags from public, anon, authenticated;
grant select, insert, update, delete on public.org_payout_accounts, public.platform_fee_policies,
  public.platform_fee_policy_versions, public.fee_policy_acceptances, public.platform_invoice_counters,
  public.platform_invoices, public.payout_items, public.payout_transfers, public.payout_reconciliation_flags to service_role;

-- =====================================================================================================
-- helpers
-- =====================================================================================================

-- The account the money goes to. No row = never set up: in DEMO_MODE (p_demo) a fake active demo account, otherwise
-- not_started.
create or replace function public.payouts_account(p_org uuid, p_demo boolean)
returns table (status text, razorpay_account_id text, explicit boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(a.status, case when p_demo then 'active' else 'not_started' end),
         coalesce(a.razorpay_account_id,
                  case when a.org_id is null and p_demo then 'acc_DEMO' || substr(md5(p_org::text), 1, 14) end),
         a.org_id is not null
  from (select 1) one
  left join public.org_payout_accounts a on a.org_id = p_org;
$$;

-- FR-2: may this organisation take money for paid services (booking visibility)?
create or replace function public.payouts_org_can_charge(p_org uuid, p_demo boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select status from public.payouts_account(p_org, p_demo)) = 'active';
$$;

-- FR-3 fee maths (lib/payouts/fees.ts is the same in TypeScript; tests compare both). Integer paise, half-up rounding:
-- fee = percent of the consultation or flat, clamped to min / cap, 0 while waived; GST = fee x gst_bps; the fee is
-- reduced so that fee + GST never exceeds the consultation (net >= 0).
create or replace function public.payouts_fee_split(
  p_amount int, p_kind text, p_bps int, p_flat int, p_min int, p_cap int, p_waived boolean, p_gst_bps int
)
returns table (fee_paise int, gst_paise int, net_paise int)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_fee bigint;
  v_gst bigint;
begin
  if coalesce(p_amount, 0) <= 0 or p_waived then
    return query select 0, 0, greatest(coalesce(p_amount, 0), 0);
    return;
  end if;
  if p_kind = 'flat' then
    v_fee := coalesce(p_flat, 0);
  else
    v_fee := (p_amount::bigint * coalesce(p_bps, 0) + 5000) / 10000;
  end if;
  v_fee := greatest(v_fee, coalesce(p_min, 0));
  if p_cap is not null then
    v_fee := least(v_fee, p_cap);
  end if;
  v_gst := (v_fee * p_gst_bps + 5000) / 10000;
  if v_fee + v_gst > p_amount then
    v_fee := (p_amount::bigint * 10000) / (10000 + p_gst_bps);
    v_gst := (v_fee * p_gst_bps + 5000) / 10000;
    if v_fee + v_gst > p_amount then
      v_gst := p_amount - v_fee;
    end if;
  end if;
  return query select v_fee::int, v_gst::int, (p_amount - v_fee - v_gst)::int;
end;
$$;

-- The organisation's policy, or the platform default (percent p_default_bps, version 0).
create or replace function public.payouts_policy(p_org uuid, p_default_bps int)
returns table (kind text, percent_bps int, flat_paise int, min_paise int, cap_paise int, waived_until date, version int)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p.kind, 'percent'),
         case when p.org_id is null then p_default_bps else p.percent_bps end,
         p.flat_paise, coalesce(p.min_paise, 0), p.cap_paise, p.waived_until, coalesce(p.version, 0)
  from (select 1) one
  left join public.platform_fee_policies p on p.org_id = p_org;
$$;

create or replace function public.payouts_split_for(p_org uuid, p_amount int, p_on date, p_default_bps int, p_gst_bps int)
returns table (fee_paise int, gst_paise int, net_paise int, version int, waived boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.fee_paise, s.gst_paise, s.net_paise, pol.version, coalesce(p_on <= pol.waived_until, false)
  from public.payouts_policy(p_org, p_default_bps) pol
  cross join lateral public.payouts_fee_split(p_amount, pol.kind, pol.percent_bps, pol.flat_paise, pol.min_paise,
                                              pol.cap_paise, coalesce(p_on <= pol.waived_until, false), p_gst_bps) s;
$$;

-- NFR-3: what is left of a payment that may still be transferred: captured - refunds (pending or done) - transfers
-- that moved (or may have moved) money and were not reversed.
create or replace function public.payouts_untransferred(p_payment uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select p.amount_paise::bigint
       - case when p.status in ('refund_pending', 'refunded') then p.amount_paise else 0 end
       - coalesce((select sum(r.amount_paise) from public.fee_refunds r where r.payment_id = p.id), 0)
       - coalesce((select sum(t.amount_paise - t.reversed_paise) from public.payout_transfers t
                   where t.payment_id = p.id and t.status in ('creating', 'created', 'processed', 'reversed')), 0)
  from public.payments p where p.id = p_payment;
$$;

-- =====================================================================================================
-- FR-3: one payout item per billable, funded consultation (idempotent; the unique index makes concurrent runs safe)
-- =====================================================================================================

-- p_orgs: only these organisations (tests and targeted runs); null = all.
create or replace function public.payouts_sync(p_default_bps int, p_gst_bps int, p_appointment uuid default null, p_orgs uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  c record;
  s record;
  it public.payout_items;
  v_n int;
  v_created int := 0;
  v_reopened int := 0;
  v_voided int := 0;
  v_reverse int := 0;
begin
  -- 1. New items (and items reversed because the consultation was not billable for a while, billable again).
  for r in
    select a.id, a.org_id, (lower(a.slot) at time zone 'Asia/Kolkata')::date as on_date
    from public.appointments a
    left join public.payout_items pi on pi.appointment_id = a.id
    where a.billable and coalesce(a.consultation_amount_paise, 0) > 0 and not a.is_demo
      and (p_appointment is null or a.id = p_appointment)
      and (p_orgs is null or a.org_id = any(p_orgs))
      and (pi.id is null
           or (pi.status = 'reversed' and pi.reverse_reason = 'not_billable' and pi.reversed_at > now() - interval '180 days')
           or (pi.reverse_requested_at is not null and pi.reverse_reason = 'not_billable'))
    order by lower(a.slot)
    limit 500
  loop
    select * into c from public.fees_consultations(null, r.id) limit 1;
    continue when not found or c.payment_id is null or c.consultation_amount_paise is null or c.consultation_amount_paise <= 0;
    continue when not exists (select 1 from public.payments p where p.id = c.payment_id and p.status = 'captured');
    select * into s from public.payouts_split_for(r.org_id, c.consultation_amount_paise, r.on_date, p_default_bps, p_gst_bps);

    select * into it from public.payout_items where appointment_id = r.id for update;
    if found then
      if it.reverse_requested_at is not null and it.status in ('transferred', 'on_hold', 'released') then
        -- Billable again before the reversal ran: keep the transfer (same funding only).
        if it.payment_id = c.payment_id and it.consultation_paise = c.consultation_amount_paise then
          update public.payout_items set reverse_requested_at = null, reverse_reason = null, updated_at = now() where id = it.id;
        end if;
        continue;
      end if;
      continue when it.status <> 'reversed';
      update public.payout_items
      set status = 'pending', payment_id = c.payment_id, consultation_on = r.on_date,
          consultation_paise = c.consultation_amount_paise, fee_paise = s.fee_paise, gst_paise = s.gst_paise,
          net_paise = s.net_paise, fee_policy_version = s.version, fee_waived = s.waived, razorpay_transfer_id = null,
          attempts = 0, next_attempt_at = now(), locked_until = null, failure_reason = null, transferred_at = null,
          processed_at = null, reverse_requested_at = null, reverse_reason = null, reversed_at = null, updated_at = now()
      where id = it.id;
      v_reopened := v_reopened + 1;
    else
      insert into public.payout_items (org_id, kind, appointment_id, child_package_id, payment_id, consultation_on,
                                       consultation_paise, fee_paise, gst_paise, net_paise, fee_policy_version, fee_waived)
      values (r.org_id, 'consultation', r.id, c.child_package_id, c.payment_id, r.on_date, c.consultation_amount_paise,
              s.fee_paise, s.gst_paise, s.net_paise, s.version, s.waived)
      on conflict (appointment_id) do nothing;
      get diagnostics v_n = row_count;
      v_created := v_created + v_n;
    end if;
  end loop;

  -- 2. Consultations that are no longer billable (044 corrections): nothing moved yet -> void; money moved -> reverse.
  for it in
    select pi.* from public.payout_items pi join public.appointments a on a.id = pi.appointment_id
    where pi.kind = 'consultation' and pi.status <> 'reversed' and pi.reverse_requested_at is null
      and (p_appointment is null or pi.appointment_id = p_appointment)
      and (p_orgs is null or pi.org_id = any(p_orgs))
      and (a.billable is not true or a.consultation_amount_paise is null)
    for update of pi skip locked
  loop
    if it.status in ('pending', 'failed')
       and not exists (select 1 from public.payout_transfers t where t.payout_item_id = it.id and t.status = 'creating') then
      update public.payout_items
      set status = 'reversed', reverse_reason = 'not_billable', reversed_at = now(), next_attempt_at = null,
          failure_reason = 'not_billable', updated_at = now()
      where id = it.id;
      v_voided := v_voided + 1;
    else
      update public.payout_items set reverse_requested_at = now(), reverse_reason = 'not_billable', updated_at = now()
      where id = it.id;
      v_reverse := v_reverse + 1;
    end if;
  end loop;

  return jsonb_build_object('created', v_created, 'reopened', v_reopened, 'voided', v_voided, 'reverse_requested', v_reverse);
end;
$$;

-- =====================================================================================================
-- FR-6: expired packages with unused sessions (once per package)
-- =====================================================================================================

create or replace function public.payouts_settle_package_expiry(p_default_bps int, p_gst_bps int, p_limit int default 50, p_orgs uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cp public.child_packages;
  pay public.payments;
  s record;
  v_policy text;
  v_unused int;
  v_left bigint;
  v_base int;
  v_amount int;
  v_outcome text;
  v_items int := 0;
  v_refunds int := 0;
  v_settled int := 0;
begin
  for cp in
    select * from public.child_packages
    where status = 'expired' and expiry_settled_at is null and (p_orgs is null or org_id = any(p_orgs))
    order by expires_on
    limit p_limit
    for update skip locked
  loop
    select * into pay from public.payments where id = cp.payment_id;
    v_unused := cp.sessions_total - cp.sessions_used;
    v_left := cp.price_paise
      - coalesce((select sum(a.consultation_amount_paise) from public.appointments a where a.child_package_id = cp.id), 0)
      - coalesce((select sum(r.amount_paise) from public.fee_refunds r where r.payment_id = cp.payment_id), 0);
    if pay.id is null or pay.status <> 'captured' then
      v_outcome := 'not_paid';
    elsif v_unused <= 0 or v_left <= 0 then
      v_outcome := 'nothing_unused';
    else
      select package_expiry_policy into v_policy from public.organizations where id = cp.org_id;
      if v_policy = 'refund_family' then
        -- Through 045's refund path (fee refund job -> ledger refund row -> the guardian's notification).
        insert into public.fee_refunds (org_id, child_id, payment_id, amount_paise, reason, child_package_id, note)
        values (cp.org_id, cp.child_id, pay.id, v_left, 'package_unused', cp.id, 'package_expired');
        v_refunds := v_refunds + 1;
        v_outcome := 'refund_family';
      else
        -- Paid out as if delivered (price / sessions each, the remainder on the last unit, D-4), fee applied.
        v_base := cp.price_paise / cp.sessions_total;
        for i in 1..v_unused loop
          v_amount := case when i = v_unused then v_left else least(v_base, v_left) end;
          v_left := v_left - v_amount;
          continue when v_amount <= 0;
          select * into s from public.payouts_split_for(cp.org_id, v_amount, cp.expires_on, p_default_bps, p_gst_bps);
          insert into public.payout_items (org_id, kind, child_package_id, unit_no, payment_id, consultation_on,
                                           consultation_paise, fee_paise, gst_paise, net_paise, fee_policy_version, fee_waived)
          values (cp.org_id, 'package_expiry', cp.id, i, pay.id, cp.expires_on, v_amount, s.fee_paise, s.gst_paise,
                  s.net_paise, s.version, s.waived)
          on conflict do nothing;
          v_items := v_items + 1;
        end loop;
        v_outcome := 'pay_centre';
      end if;
    end if;
    update public.child_packages set expiry_settled_at = now(), expiry_outcome = v_outcome, updated_at = now() where id = cp.id;
    v_settled := v_settled + 1;
  end loop;
  return jsonb_build_object('settled', v_settled, 'items', v_items, 'refunds', v_refunds);
end;
$$;

-- =====================================================================================================
-- transfers (FR-3, NFR-1, NFR-3)
-- =====================================================================================================

-- Claims due items under a lease and reserves their transfer (status 'creating'; its id is the idempotency key the job
-- sends to Razorpay and looks up before creating). The source payment row is locked, so concurrent claims of one
-- payment are serialised and the untransferred amount is checked in SQL (NFR-3).
create or replace function public.payouts_claim_transfers(
  p_limit int, p_item uuid default null, p_demo boolean default false, p_lease_seconds int default 120, p_orgs uuid[] default null
)
returns table (payout_item_id uuid, transfer_id uuid, org_id uuid, payment_id uuid, razorpay_payment_id text,
               account_id text, amount_paise int, on_hold boolean, attempts int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  it public.payout_items;
  pay public.payments;
  tr public.payout_transfers;
  acct record;
begin
  for it in
    select * from public.payout_items i
    where i.status in ('pending', 'failed') and i.reverse_requested_at is null
      and i.next_attempt_at is not null and i.next_attempt_at <= now()
      and (i.locked_until is null or i.locked_until < now())
      and (p_item is null or i.id = p_item)
      and (p_orgs is null or i.org_id = any(p_orgs))
    order by i.next_attempt_at
    limit p_limit
    for update skip locked
  loop
    select * into acct from public.payouts_account(it.org_id, p_demo);
    if acct.status not in ('active', 'suspended') or acct.razorpay_account_id is null then
      -- Waits for the payout account (no attempt counted); admins see it.
      update public.payout_items set failure_reason = 'payout_account_inactive',
        next_attempt_at = now() + interval '15 minutes', updated_at = now() where id = it.id;
      continue;
    end if;
    select * into pay from public.payments where id = it.payment_id for update;
    if pay.status <> 'captured' then
      -- The payment is being refunded: nothing will be transferred (an attempt of unknown outcome is resolved and
      -- reversed by the reversal job).
      if not exists (select 1 from public.payout_transfers t where t.payout_item_id = it.id and t.status = 'creating') then
        update public.payout_items set status = 'reversed', reverse_reason = 'refund', reversed_at = now(),
          next_attempt_at = null, failure_reason = 'payment_refunded', updated_at = now() where id = it.id;
      else
        update public.payout_items set reverse_requested_at = now(), reverse_reason = 'refund', updated_at = now()
        where id = it.id;
      end if;
      continue;
    end if;
    if it.net_paise = 0 then
      -- The fee took the whole consultation: nothing to transfer.
      update public.payout_items set status = 'transferred', transferred_at = now(), processed_at = now(),
        next_attempt_at = null, failure_reason = null, updated_at = now() where id = it.id;
      continue;
    end if;
    select * into tr from public.payout_transfers t where t.payout_item_id = it.id and t.status = 'creating';
    if not found then
      if it.net_paise > public.payouts_untransferred(pay.id) then
        update public.payout_items set status = 'failed', failure_reason = 'exceeds_payment', next_attempt_at = null,
          updated_at = now() where id = it.id;
        continue;
      end if;
      insert into public.payout_transfers (payout_item_id, payment_id, account_id, amount_paise, on_hold)
      values (it.id, pay.id, acct.razorpay_account_id, it.net_paise, acct.status = 'suspended')
      returning * into tr;
    end if;
    update public.payout_items
    set locked_until = now() + make_interval(secs => p_lease_seconds), attempts = it.attempts + 1, updated_at = now()
    where id = it.id;
    payout_item_id := it.id;
    transfer_id := tr.id;
    org_id := it.org_id;
    payment_id := pay.id;
    razorpay_payment_id := pay.razorpay_payment_id;
    account_id := tr.account_id;
    amount_paise := tr.amount_paise;
    on_hold := tr.on_hold;
    attempts := it.attempts + 1;
    return next;
  end loop;
end;
$$;

-- The transfer exists at Razorpay (API response, or found by our id): record it. Idempotent.
create or replace function public.payouts_record_transfer(p_transfer uuid, p_razorpay_id text, p_processed boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tr public.payout_transfers;
begin
  select * into tr from public.payout_transfers where id = p_transfer for update;
  if not found then
    raise exception using message = 'payout_transfer_not_found', errcode = 'P0001';
  end if;
  if tr.status in ('failed', 'reversed') then
    -- Razorpay already said it failed (webhook first), or it was reversed: nothing to record.
    return jsonb_build_object('outcome', 'ignored');
  end if;
  if tr.status in ('creating', 'created') then
    update public.payout_transfers
    set status = case when p_processed or tr.status = 'processed' then 'processed' else 'created' end,
        razorpay_transfer_id = coalesce(tr.razorpay_transfer_id, p_razorpay_id),
        processed_at = case when p_processed then coalesce(tr.processed_at, now()) else tr.processed_at end
    where id = tr.id;
  elsif tr.status = 'processed' then
    return jsonb_build_object('outcome', 'already_recorded');
  end if;
  update public.payout_items
  set status = case when status in ('pending', 'failed') then (case when tr.on_hold then 'on_hold' else 'transferred' end) else status end,
      razorpay_transfer_id = p_razorpay_id, transferred_at = coalesce(transferred_at, now()),
      processed_at = case when p_processed then coalesce(processed_at, now()) else processed_at end,
      locked_until = null, next_attempt_at = null, failure_reason = null, updated_at = now()
  where id = tr.payout_item_id;
  return jsonb_build_object('outcome', 'recorded');
end;
$$;

-- An attempt failed. p_transfer_failed: Razorpay definitely has no transfer for this attempt (refused, or
-- transfer.failed) - the reservation is released; otherwise (timeout, 5xx) the next attempt looks it up first.
-- Back-off after attempt n: p_backoff[n] seconds; after the last one the item waits for an admin (`Retry`).
create or replace function public.payouts_attempt_failed(
  p_item uuid, p_transfer uuid, p_transfer_failed boolean, p_reason text, p_backoff int[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it public.payout_items;
  v_next timestamptz;
begin
  select * into it from public.payout_items where id = p_item for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_transfer is not null and p_transfer_failed then
    update public.payout_transfers set status = 'failed', failed_at = now(), failure_reason = left(p_reason, 300)
    where id = p_transfer and status in ('creating', 'created', 'processed');
  end if;
  if it.status = 'reversed' then
    return jsonb_build_object('outcome', 'reversed');
  end if;
  v_next := case when it.attempts <= coalesce(array_length(p_backoff, 1), 0)
                 then now() + make_interval(secs => p_backoff[greatest(it.attempts, 1)]) end;
  if it.reverse_requested_at is not null and p_transfer_failed then
    -- Nothing moved and it should not be paid any more.
    update public.payout_items set status = 'reversed', reversed_at = now(), locked_until = null, next_attempt_at = null,
      failure_reason = left(p_reason, 300), razorpay_transfer_id = null, updated_at = now() where id = it.id;
    return jsonb_build_object('outcome', 'voided');
  end if;
  update public.payout_items
  set status = 'failed', failure_reason = left(p_reason, 300), locked_until = null, next_attempt_at = v_next,
      razorpay_transfer_id = case when p_transfer_failed then null else razorpay_transfer_id end, updated_at = now()
  where id = it.id;
  return jsonb_build_object('outcome', 'failed', 'exhausted', v_next is null, 'attempts', it.attempts);
end;
$$;

-- Signed webhooks `transfer.processed` / `transfer.failed` (by Razorpay's id, or by our id in the transfer notes when the
-- event arrives before the API response was recorded).
create or replace function public.payouts_apply_transfer_event(
  p_event text, p_razorpay_id text, p_our_id uuid, p_reason text, p_backoff int[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tr public.payout_transfers;
  r jsonb;
begin
  select * into tr from public.payout_transfers where razorpay_transfer_id = p_razorpay_id for update;
  if not found and p_our_id is not null then
    select * into tr from public.payout_transfers where id = p_our_id for update;
  end if;
  if tr.id is null then
    return jsonb_build_object('outcome', 'unknown_transfer');
  end if;
  if p_event = 'transfer.processed' then
    if tr.status in ('failed', 'reversed') then
      return jsonb_build_object('outcome', 'ignored', 'payment_id', tr.payment_id);
    end if;
    perform public.payouts_record_transfer(tr.id, p_razorpay_id, true);
    return jsonb_build_object('outcome', 'transfer_processed', 'payment_id', tr.payment_id, 'payout_item_id', tr.payout_item_id);
  end if;
  if tr.status in ('failed', 'reversed') then
    return jsonb_build_object('outcome', 'ignored', 'payment_id', tr.payment_id);
  end if;
  update public.payout_transfers set razorpay_transfer_id = coalesce(razorpay_transfer_id, p_razorpay_id) where id = tr.id;
  r := public.payouts_attempt_failed(tr.payout_item_id, tr.id, true, coalesce(p_reason, 'transfer_failed'), p_backoff);
  return r || jsonb_build_object('outcome', 'transfer_failed', 'payment_id', tr.payment_id, 'payout_item_id', tr.payout_item_id);
end;
$$;

-- Held transfers (account suspended when they were made) whose account is active again.
create or replace function public.payouts_claim_releases(p_limit int, p_demo boolean default false, p_orgs uuid[] default null)
returns table (payout_item_id uuid, transfer_id uuid, razorpay_transfer_id text)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select i.id as item_id, t.id as transfer_id, t.razorpay_transfer_id
    from public.payout_items i
    join public.payout_transfers t on t.payout_item_id = i.id
    where i.status = 'on_hold' and i.reverse_requested_at is null and (i.locked_until is null or i.locked_until < now())
      and t.status in ('created', 'processed') and t.on_hold and t.razorpay_transfer_id is not null
      and (select a.status from public.payouts_account(i.org_id, p_demo) a) = 'active'
      and (p_orgs is null or i.org_id = any(p_orgs))
    limit p_limit
    for update of i skip locked
  ), leased as (
    update public.payout_items i set locked_until = now() + interval '2 minutes', updated_at = now()
    from due where i.id = due.item_id
    returning i.id
  )
  select due.item_id, due.transfer_id, due.razorpay_transfer_id from due join leased on leased.id = due.item_id;
$$;

create or replace function public.payouts_record_release(p_transfer uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.payout_transfers set on_hold = false, released_at = now() where id = p_transfer;
  update public.payout_items set status = 'released', locked_until = null, updated_at = now()
  where id = (select payout_item_id from public.payout_transfers where id = p_transfer) and status = 'on_hold';
$$;

-- =====================================================================================================
-- reversals (FR-5): a refund reverses the matching transfers first; corrections reverse too
-- =====================================================================================================

-- Marks what must be reversed before a refund of p_amount from p_payment can go out, and says whether it is ready.
--   * p_appointment: that consultation's item (045 session refunds, 031 one-off refunds);
--   * p_full: every item of the payment (031 full refunds);
--   * otherwise (unused package sessions, overpayments): the payment must keep enough that is not allocated to items;
--     unused-session payouts of an expired package (FR-6 pay_centre) are reversed first, latest unit first.
-- Items where nothing moved yet are voided at once. Ready = nothing left to reverse.
create or replace function public.payouts_prepare_refund(
  p_payment uuid, p_amount int, p_appointment uuid, p_full boolean, p_exclude_refund uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay public.payments;
  it public.payout_items;
  v_free bigint;
  v_pending int := 0;
begin
  -- Same lock order as payouts_claim_transfers (items, then the payment): no deadlock with a transfer being claimed.
  perform 1 from public.payout_items i where i.payment_id = p_payment order by i.id for update;
  select * into pay from public.payments where id = p_payment for update;
  if not found then
    return jsonb_build_object('ready', true, 'pending', 0);
  end if;
  if p_appointment is null and not p_full then
    v_free := pay.amount_paise
      - case when pay.status in ('refund_pending', 'refunded') and not p_full then pay.amount_paise else 0 end
      - coalesce((select sum(r.amount_paise) from public.fee_refunds r
                  where r.payment_id = pay.id and (p_exclude_refund is null or r.id <> p_exclude_refund)), 0)
      - coalesce((select sum(i.consultation_paise) from public.payout_items i
                  where i.payment_id = pay.id and i.status <> 'reversed' and i.reverse_requested_at is null), 0);
  end if;
  for it in
    select * from public.payout_items i
    where i.payment_id = pay.id and i.status <> 'reversed'
      and (p_full or (p_appointment is not null and i.appointment_id = p_appointment)
           or (p_appointment is null and i.kind = 'package_expiry'))
    order by i.kind = 'package_expiry' desc, i.unit_no desc nulls last, i.created_at desc
    for update
  loop
    if p_appointment is null and not p_full then
      exit when v_free >= p_amount;
      if it.reverse_requested_at is null then
        v_free := v_free + it.consultation_paise;
      end if;
    end if;
    if it.status in ('pending', 'failed')
       and not exists (select 1 from public.payout_transfers t where t.payout_item_id = it.id and t.status = 'creating') then
      update public.payout_items set status = 'reversed', reverse_reason = coalesce(reverse_reason, 'refund'),
        reversed_at = now(), next_attempt_at = null, failure_reason = 'refunded', updated_at = now() where id = it.id;
    else
      if it.reverse_requested_at is null then
        update public.payout_items set reverse_requested_at = now(), reverse_reason = 'refund', updated_at = now() where id = it.id;
      end if;
      v_pending := v_pending + 1;
    end if;
  end loop;
  if p_appointment is null and not p_full and v_free < p_amount and v_pending = 0 then
    return jsonb_build_object('ready', false, 'pending', 0, 'reason', 'insufficient_untransferred');
  end if;
  return jsonb_build_object('ready', v_pending = 0, 'pending', v_pending);
end;
$$;

-- Items to reverse (reverse requested and money moved, or an unknown 'creating' transfer to resolve first).
create or replace function public.payouts_claim_reversals(p_limit int, p_payment uuid default null, p_orgs uuid[] default null)
returns table (payout_item_id uuid, transfer_id uuid, transfer_status text, razorpay_transfer_id text,
               razorpay_payment_id text, amount_paise int, reverse_reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  it public.payout_items;
  tr public.payout_transfers;
begin
  for it in
    select * from public.payout_items i
    where i.reverse_requested_at is not null and i.status <> 'reversed'
      and (i.locked_until is null or i.locked_until < now())
      and (p_payment is null or i.payment_id = p_payment)
      and (p_orgs is null or i.org_id = any(p_orgs))
    order by i.reverse_requested_at
    limit p_limit
    for update skip locked
  loop
    select * into tr from public.payout_transfers t
    where t.payout_item_id = it.id and t.status in ('creating', 'created', 'processed');
    if not found then
      update public.payout_items set status = 'reversed', reversed_at = now(), locked_until = null, next_attempt_at = null,
        updated_at = now() where id = it.id;
      continue;
    end if;
    update public.payout_items set locked_until = now() + interval '2 minutes', updated_at = now() where id = it.id;
    payout_item_id := it.id;
    transfer_id := tr.id;
    transfer_status := tr.status;
    razorpay_transfer_id := tr.razorpay_transfer_id;
    razorpay_payment_id := (select p.razorpay_payment_id from public.payments p where p.id = tr.payment_id);
    amount_paise := tr.amount_paise - tr.reversed_paise;
    reverse_reason := it.reverse_reason;
    return next;
  end loop;
end;
$$;

create or replace function public.payouts_record_reversal(p_transfer uuid, p_reversal_id text, p_amount int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tr public.payout_transfers;
begin
  select * into tr from public.payout_transfers where id = p_transfer for update;
  if tr.status <> 'reversed' then
    update public.payout_transfers
    set status = 'reversed', reversed_paise = least(amount_paise, reversed_paise + p_amount),
        razorpay_reversal_id = coalesce(razorpay_reversal_id, p_reversal_id), reversed_at = now()
    where id = tr.id;
  end if;
  update public.payout_items
  set status = 'reversed', reversed_at = coalesce(reversed_at, now()), locked_until = null, next_attempt_at = null,
      updated_at = now()
  where id = tr.payout_item_id;
end;
$$;

-- =====================================================================================================
-- FR-7 monthly platform-fee tax invoice: DNM-INV/<FY>/<0001>, gap-free per Indian financial year of the issue date
-- (counter row incremented in the issuing transaction). Covers every fee not invoiced yet for consultations up to the
-- end of the month (late items land on the next invoice). Idempotent per (organisation, month).
-- =====================================================================================================

create or replace function public.payouts_issue_invoice(
  p_org uuid, p_month date, p_issued_at timestamptz, p_centre jsonb, p_platform jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.platform_invoices;
  v_fee bigint;
  v_gst bigint;
  v_gross bigint;
  v_count int;
  v_fy text;
  v_n int;
  v_id uuid := gen_random_uuid();
begin
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception using message = 'invalid_month', errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('payout-invoice:' || p_org || ':' || p_month, 0));
  select * into inv from public.platform_invoices where org_id = p_org and period_month = p_month;
  if found then
    return jsonb_build_object('outcome', 'exists', 'invoice_id', inv.id, 'invoice_no', inv.invoice_no);
  end if;
  select coalesce(sum(fee_paise), 0), coalesce(sum(gst_paise), 0), coalesce(sum(consultation_paise), 0), count(*)
  into v_fee, v_gst, v_gross, v_count
  from public.payout_items
  where org_id = p_org and status <> 'reversed' and invoice_id is null
    and consultation_on < (p_month + interval '1 month')::date and created_at <= p_issued_at and fee_paise > 0;
  if v_fee <= 0 then
    return jsonb_build_object('outcome', 'nothing');
  end if;
  v_fy := public.fees_financial_year(p_issued_at);
  insert into public.platform_invoice_counters as c (fy, next) values (v_fy, 2)
  on conflict (fy) do update set next = c.next + 1
  returning c.next - 1 into v_n;
  insert into public.platform_invoices (id, org_id, period_month, fee_paise, gst_paise, gross_paise, item_count, invoice_no,
                                        pdf_path, centre, platform, issued_at)
  values (v_id, p_org, p_month, v_fee, v_gst, v_gross, v_count, 'DNM-INV/' || v_fy || '/' || lpad(v_n::text, 4, '0'),
          '/api/orgs/' || p_org || '/payouts/invoices/' || v_id || '/pdf', p_centre, p_platform, p_issued_at)
  returning * into inv;
  update public.payout_items set invoice_id = inv.id, updated_at = now()
  where org_id = p_org and status <> 'reversed' and invoice_id is null
    and consultation_on < (p_month + interval '1 month')::date and created_at <= p_issued_at and fee_paise > 0;
  perform public.outbox_enqueue('payouts.invoice_issued', 'platform_invoice', inv.id,
    jsonb_build_object('invoice_id', inv.id, 'org_id', p_org), 'payouts:invoice:' || inv.id, now());
  return jsonb_build_object('outcome', 'issued', 'invoice_id', inv.id, 'invoice_no', inv.invoice_no,
                            'fee_paise', inv.fee_paise, 'gst_paise', inv.gst_paise);
end;
$$;

-- =====================================================================================================
-- FR-10 reconciliation: per captured payment, captured vs transferred + refunded + platform share, and whether
-- everything it funds is settled (nothing pending, no refund in progress, the sessions are over / package closed).
-- =====================================================================================================

create or replace function public.payouts_reconciliation(p_org uuid default null, p_since timestamptz default null)
returns table (payment_id uuid, org_id uuid, purpose text, captured_paise int, transferred_paise bigint,
               platform_share_paise bigint, refunded_paise bigint, settled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(p.org_id, a.org_id), p.purpose, p.amount_paise,
    coalesce((select sum(t.amount_paise - t.reversed_paise) from public.payout_transfers t
              where t.payment_id = p.id and t.status in ('created', 'processed', 'reversed')), 0),
    coalesce((select sum(i.fee_paise + i.gst_paise) from public.payout_items i
              where i.payment_id = p.id and i.status <> 'reversed'), 0),
    (case when p.status = 'refunded' then p.amount_paise else 0 end)
      + coalesce((select sum(r.amount_paise) from public.fee_refunds r where r.payment_id = p.id and r.status = 'processed'), 0),
    p.status = 'captured'
      and not exists (select 1 from public.fee_refunds r where r.payment_id = p.id and r.status = 'pending')
      and not exists (select 1 from public.payout_items i where i.payment_id = p.id
                      and (i.status in ('pending', 'failed') or (i.reverse_requested_at is not null and i.status <> 'reversed')))
      and not exists (select 1 from public.payout_transfers t where t.payment_id = p.id and t.status = 'creating')
      and case p.purpose
            when 'appointment' then a.status in ('completed', 'no_show', 'cancelled', 'expired')
            when 'package' then exists (select 1 from public.child_packages cp where cp.id = p.child_package_id
                                        and (cp.status in ('used_up', 'cancelled')
                                             or (cp.status = 'expired' and cp.expiry_settled_at is not null)))
            else true end
      or p.status = 'refunded'
  from public.payments p
  left join public.appointments a on a.id = p.appointment_id
  where p.status in ('captured', 'refund_pending', 'refunded')
    and (p_org is null or coalesce(p.org_id, a.org_id) = p_org)
    and (p_since is null or p.captured_at >= p_since);
$$;

-- ---------- grants: the server (service role) only ----------
revoke all on function public.payouts_account(uuid, boolean) from public, anon, authenticated;
revoke all on function public.payouts_org_can_charge(uuid, boolean) from public, anon, authenticated;
revoke all on function public.payouts_fee_split(int, text, int, int, int, int, boolean, int) from public, anon, authenticated;
revoke all on function public.payouts_policy(uuid, int) from public, anon, authenticated;
revoke all on function public.payouts_split_for(uuid, int, date, int, int) from public, anon, authenticated;
revoke all on function public.payouts_untransferred(uuid) from public, anon, authenticated;
revoke all on function public.payouts_sync(int, int, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.payouts_settle_package_expiry(int, int, int, uuid[]) from public, anon, authenticated;
revoke all on function public.payouts_claim_transfers(int, uuid, boolean, int, uuid[]) from public, anon, authenticated;
revoke all on function public.payouts_record_transfer(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.payouts_attempt_failed(uuid, uuid, boolean, text, int[]) from public, anon, authenticated;
revoke all on function public.payouts_apply_transfer_event(text, text, uuid, text, int[]) from public, anon, authenticated;
revoke all on function public.payouts_claim_releases(int, boolean, uuid[]) from public, anon, authenticated;
revoke all on function public.payouts_record_release(uuid) from public, anon, authenticated;
revoke all on function public.payouts_prepare_refund(uuid, int, uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public.payouts_claim_reversals(int, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.payouts_record_reversal(uuid, text, int) from public, anon, authenticated;
revoke all on function public.payouts_issue_invoice(uuid, date, timestamptz, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.payouts_reconciliation(uuid, timestamptz) from public, anon, authenticated;

grant execute on function public.payouts_account(uuid, boolean) to service_role;
grant execute on function public.payouts_org_can_charge(uuid, boolean) to service_role;
grant execute on function public.payouts_fee_split(int, text, int, int, int, int, boolean, int) to service_role;
grant execute on function public.payouts_policy(uuid, int) to service_role;
grant execute on function public.payouts_split_for(uuid, int, date, int, int) to service_role;
grant execute on function public.payouts_untransferred(uuid) to service_role;
grant execute on function public.payouts_sync(int, int, uuid, uuid[]) to service_role;
grant execute on function public.payouts_settle_package_expiry(int, int, int, uuid[]) to service_role;
grant execute on function public.payouts_claim_transfers(int, uuid, boolean, int, uuid[]) to service_role;
grant execute on function public.payouts_record_transfer(uuid, text, boolean) to service_role;
grant execute on function public.payouts_attempt_failed(uuid, uuid, boolean, text, int[]) to service_role;
grant execute on function public.payouts_apply_transfer_event(text, text, uuid, text, int[]) to service_role;
grant execute on function public.payouts_claim_releases(int, boolean, uuid[]) to service_role;
grant execute on function public.payouts_record_release(uuid) to service_role;
grant execute on function public.payouts_prepare_refund(uuid, int, uuid, boolean, uuid) to service_role;
grant execute on function public.payouts_claim_reversals(int, uuid, uuid[]) to service_role;
grant execute on function public.payouts_record_reversal(uuid, text, int) to service_role;
grant execute on function public.payouts_issue_invoice(uuid, date, timestamptz, jsonb, jsonb) to service_role;
grant execute on function public.payouts_reconciliation(uuid, timestamptz) to service_role;
