-- Reconcile the hosted pilot database (project hapgjuuvesppasaxoalc) with this repository.
--
-- Production ran two migrations that never reached this repository: 20261107170000_case_owner and
-- 20261107170050_case_owner_required. They added cases.owner_id (+ demo_keep), user_profiles.name / is_demo, a
-- check that every case has an owner, and a trigger that picks a demo user as the owner. The organisation model
-- (20261112120000_orgs_roles) replaced per-case ownership and the app never sets owner_id, so those rules would
-- reject new cases and block deleting any account that owns one (privacy deletion, 041).
--
-- This keeps the data (owner_id stays as information) and removes the rules. On databases that never had them
-- (local, CI, a fresh project) every statement is a no-op.

drop trigger if exists cases_set_default_owner on public.cases;
drop function if exists public.set_default_case_owner();
alter table public.cases drop constraint if exists cases_owner_required;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cases' and column_name = 'owner_id'
  ) then
    alter table public.cases drop constraint if exists cases_owner_id_fkey;
    alter table public.cases
      add constraint cases_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete set null;
  end if;
end
$$;
