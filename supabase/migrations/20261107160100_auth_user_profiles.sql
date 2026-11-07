create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'therapist' check (role in ('admin', 'therapist')),
  created_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
grant select on public.user_profiles to authenticated;

create or replace function public.is_carethread_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

revoke all on function public.is_carethread_admin() from public;
grant execute on function public.is_carethread_admin() to authenticated;

create policy "Users can read their own profile; admins can read all profiles"
on public.user_profiles
for select
to authenticated
using (id = (select auth.uid()) or (select public.is_carethread_admin()));

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (id, role)
  values (new.id, 'therapist')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

insert into public.user_profiles (id, role)
select id, 'therapist'
from auth.users
on conflict (id) do nothing;
