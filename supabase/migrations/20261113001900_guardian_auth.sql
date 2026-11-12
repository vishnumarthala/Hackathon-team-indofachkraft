-- 019: guardian sign-in. New accounts default to the least-privileged role `guardian`; privileged roles
-- still come only from server-set app_metadata (admin API) or server-side promotion (017 invitations,
-- 028 self-registration). Adds the guardian display name, a server-maintained phone verification time
-- (copied from auth.users.phone_confirmed_at; 020 uses it for verifiable consent) and the app-level OTP
-- send rate limit. Expand-only: existing rows keep their role; new columns are nullable.

-- ---------- expand ----------
alter table public.user_profiles
  add column display_name text
    constraint user_profiles_display_name_length_check check (char_length(display_name) between 1 and 80);

alter table public.user_profiles add column phone_verified_at timestamptz;

alter table public.user_profiles alter column role set default 'guardian';

-- ---------- backfill ----------
update public.user_profiles p
set phone_verified_at = u.phone_confirmed_at
from auth.users u
where u.id = p.id and u.phone_confirmed_at is not null and coalesce(u.phone, '') <> '';

-- ---------- auth triggers ----------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested text := new.raw_app_meta_data ->> 'role';
begin
  insert into public.user_profiles (id, role, phone_verified_at)
  values (
    new.id,
    case when requested in ('provider', 'platform_admin') then requested else 'guardian' end,
    case when coalesce(new.phone, '') <> '' then new.phone_confirmed_at end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

-- GoTrue's admin createUser inserts the auth.users row first and writes custom app_metadata in a second
-- statement, so the insert trigger alone never sees `role`. Promote when the server (service role; users
-- cannot write app_metadata) sets app_metadata.role to `provider` or `platform_admin`; other values are ignored.
create or replace function public.sync_role_from_app_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested text := new.raw_app_meta_data ->> 'role';
begin
  if requested in ('provider', 'platform_admin') then
    update public.user_profiles set role = requested where id = new.id and role is distinct from requested;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_role_from_app_metadata() from public, anon, authenticated;

create trigger on_auth_user_app_role_changed
after update of raw_app_meta_data on auth.users
for each row
when ((old.raw_app_meta_data ->> 'role') is distinct from (new.raw_app_meta_data ->> 'role'))
execute procedure public.sync_role_from_app_metadata();

-- FR-10: the profile mirrors Supabase's confirmed-phone state; clients cannot write it.
create or replace function public.sync_phone_verified_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.user_profiles
  set phone_verified_at = case when coalesce(new.phone, '') <> '' then new.phone_confirmed_at end
  where id = new.id;
  return new;
end;
$$;

revoke all on function public.sync_phone_verified_at() from public, anon, authenticated;

create trigger on_auth_user_phone_changed
after update of phone, phone_confirmed_at on auth.users
for each row
when (old.phone is distinct from new.phone or old.phone_confirmed_at is distinct from new.phone_confirmed_at)
execute procedure public.sync_phone_verified_at();

-- Server-only lookup used to refuse linking a phone that belongs to another account (FR-9) and by the
-- demo OTP backend. `phone` is E.164 digits without '+', the format auth.users stores.
create or replace function public.auth_user_id_by_phone(target_phone text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where phone = target_phone and deleted_at is null limit 1;
$$;

revoke all on function public.auth_user_id_by_phone(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_phone(text) to service_role;

-- ---------- OTP send rate limit (NFR-1) ----------
-- Keys are HMACs of the phone number / client IP (never the raw values).
create table public.otp_send_attempts (
  id bigint generated always as identity primary key,
  phone_key text not null check (char_length(phone_key) between 16 and 128),
  ip_key text not null check (char_length(ip_key) between 16 and 128),
  created_at timestamptz not null default now()
);
create index otp_send_attempts_phone_idx on public.otp_send_attempts (phone_key, created_at);
create index otp_send_attempts_ip_idx on public.otp_send_attempts (ip_key, created_at);
alter table public.otp_send_attempts enable row level security;

-- Atomic check-and-record: per-key advisory locks serialise concurrent sends for the same number/IP.
-- `at` is passed by the server (testable clock). Returns 'ok', 'phone_limited' or 'ip_limited'.
create or replace function public.record_otp_send(
  p_phone_key text, p_ip_key text, per_phone integer, per_ip integer, at timestamptz
) returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('otp-phone:' || p_phone_key));
  perform pg_advisory_xact_lock(hashtext('otp-ip:' || p_ip_key));
  delete from public.otp_send_attempts where created_at < at - interval '1 day';
  if (select count(*) from public.otp_send_attempts
      where phone_key = p_phone_key and created_at > at - interval '1 hour' and created_at <= at) >= per_phone then
    return 'phone_limited';
  end if;
  if (select count(*) from public.otp_send_attempts
      where ip_key = p_ip_key and created_at > at - interval '1 hour' and created_at <= at) >= per_ip then
    return 'ip_limited';
  end if;
  insert into public.otp_send_attempts (phone_key, ip_key, created_at) values (p_phone_key, p_ip_key, at);
  return 'ok';
end;
$$;

revoke all on function public.record_otp_send(text, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.record_otp_send(text, text, integer, integer, timestamptz) to service_role;
