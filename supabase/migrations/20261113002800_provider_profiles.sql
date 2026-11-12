-- 028: public provider profiles, credential verification, admin seeding and claim links.
-- Additive only: new tables, new defaulted/nullable columns on organizations, two storage buckets.
-- Existing rows keep working (organizations.listed defaults to false, every other new column is null).
-- Multi-step writes are security-definer functions callable only by the service role, so each one is a
-- single transaction (and verification decisions write their audit row in that same transaction).

-- ---------- organisations: public fields ----------
alter table public.organizations
  add column public_name text check (char_length(public_name) between 1 and 120),
  add column about text check (char_length(about) <= 2000),
  add column phone_public text check (phone_public ~ '^\+?[0-9][0-9 -]{5,19}$'),
  add column website text check (website ~ '^https?://[^\s]+$' and char_length(website) <= 200),
  add column listed boolean not null default false;

-- ---------- provider profiles ----------
create table public.provider_profiles (
  id uuid primary key default gen_random_uuid(),
  -- Stable provider identity across organisations (rule 10); null while a seeded profile is unclaimed.
  user_id uuid unique references auth.users(id) on delete set null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  provider_type text not null check (provider_type in (
    'developmental_pediatrician', 'child_psychiatrist', 'child_psychologist', 'speech_language_pathologist',
    'occupational_therapist', 'aba_therapist', 'special_educator', 'physiotherapist', 'pediatrician'
  )),
  qualifications text check (char_length(qualifications) <= 300),
  bio text check (char_length(bio) <= 1500),
  languages text[] not null default '{}'
    check (languages <@ array['en', 'hi', 'te', 'ur', 'ta', 'kn', 'mr']::text[]),
  years_experience int check (years_experience between 0 and 60),
  photo_path text check (char_length(photo_path) <= 200),
  registration_council text check (registration_council in ('NMC', 'STATE_MEDICAL_COUNCIL', 'RCI', 'OTHER')),
  registration_state text check (char_length(registration_state) between 1 and 60),
  registration_number text check (char_length(registration_number) between 1 and 60),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'pending', 'verified', 'rejected', 'suspended')),
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  -- What the platform admin checked (required for council OTHER). Internal: never shown publicly.
  verification_note text check (char_length(verification_note) <= 1000),
  time_zone text not null default 'Asia/Kolkata' check (char_length(time_zone) between 1 and 64),
  listed boolean not null default false,
  claimed boolean not null default false,
  is_synthetic boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint provider_profiles_listed_requires_verified check (not listed or verification_status = 'verified')
);
create index provider_profiles_public_idx on public.provider_profiles (verification_status, listed);

-- Prescriber rule (D-3, rule 9): derived, never stored and never taken from client input.
create or replace function public.provider_prescriber_rule(p_type text, p_status text, p_council text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_type in ('developmental_pediatrician', 'child_psychiatrist', 'pediatrician')
      and p_status = 'verified'
      and p_council in ('NMC', 'STATE_MEDICAL_COUNCIL'),
    false
  );
$$;

create or replace function public.provider_can_prescribe(profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select public.provider_prescriber_rule(p.provider_type, p.verification_status, p.registration_council)
    from public.provider_profiles p where p.id = profile_id
  ), false);
$$;

-- ---------- practice locations ----------
create table public.practice_locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  address_line1 text not null check (char_length(address_line1) between 1 and 200),
  address_line2 text check (char_length(address_line2) <= 200),
  locality text not null check (char_length(locality) between 1 and 80),
  city text not null default 'Hyderabad' check (char_length(city) between 1 and 80),
  state text not null default 'Telangana' check (char_length(state) between 1 and 80),
  pincode text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  lat numeric(9, 6) check (lat between -90 and 90),
  lng numeric(9, 6) check (lng between -180 and 180),
  time_zone text not null default 'Asia/Kolkata' check (char_length(time_zone) between 1 and 64),
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create index practice_locations_org_idx on public.practice_locations (org_id);

-- org_id is denormalised for org-scoped queries; the composite key keeps it equal to the location's org.
create table public.provider_locations (
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  location_id uuid not null,
  org_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (provider_profile_id, location_id),
  foreign key (location_id, org_id) references public.practice_locations(id, org_id) on delete cascade
);
create index provider_locations_org_idx on public.provider_locations (org_id);
create index provider_locations_location_idx on public.provider_locations (location_id);

-- ---------- credential submissions ----------
create table public.credential_submissions (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  council text not null check (council in ('NMC', 'STATE_MEDICAL_COUNCIL', 'RCI', 'OTHER')),
  state text check (char_length(state) between 1 and 60),
  registration_number text not null check (char_length(registration_number) between 1 and 60),
  -- Object in the private `credentials` bucket; null when re-review was triggered without a new upload.
  certificate_path text check (char_length(certificate_path) <= 300),
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  reviewer_id uuid references auth.users(id) on delete set null,
  reviewer_note text check (char_length(reviewer_note) <= 1000),
  submitted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint credential_submissions_state_required check (council <> 'STATE_MEDICAL_COUNCIL' or state is not null)
);
-- At most one open submission per profile: a re-submission replaces the open one.
create unique index credential_submissions_open_idx on public.credential_submissions (provider_profile_id)
  where status = 'submitted';
create index credential_submissions_queue_idx on public.credential_submissions (created_at) where status = 'submitted';

-- ---------- claim tokens ----------
create table public.provider_claim_tokens (
  id uuid primary key default gen_random_uuid(),
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index provider_claim_tokens_profile_idx on public.provider_claim_tokens (provider_profile_id);

-- ---------- profile guard: re-verification and listing ----------
-- FR-3: changing the provider type or any registration field of a verified profile sends it back to
-- `pending` and unlists it, whatever code path made the change. A profile that is not verified is never
-- listed (FR-8; the check constraint backs this up).
create or replace function public.provider_profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if old.verification_status = 'verified' and new.verification_status = 'verified' and (
    new.provider_type is distinct from old.provider_type
    or new.registration_council is distinct from old.registration_council
    or new.registration_state is distinct from old.registration_state
    or new.registration_number is distinct from old.registration_number
  ) then
    new.verification_status := 'pending';
  end if;
  if new.verification_status <> 'verified' then
    new.listed := false;
  end if;
  return new;
end;
$$;

create trigger provider_profiles_guard
before update on public.provider_profiles
for each row execute procedure public.provider_profiles_guard();

-- A verified profile that drops to `pending` without a new submission (e.g. provider_type edited) gets a
-- re-review entry in the admin queue built from its current registration details.
create or replace function public.provider_profiles_requeue()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.verification_status = 'verified' and new.verification_status = 'pending'
     and new.registration_council is not null and new.registration_number is not null
     and not exists (
       select 1 from public.credential_submissions
       where provider_profile_id = new.id and status = 'submitted'
     ) then
    insert into public.credential_submissions (provider_profile_id, council, state, registration_number, certificate_path)
    select new.id, new.registration_council, new.registration_state, new.registration_number,
      (select certificate_path from public.credential_submissions
       where provider_profile_id = new.id and certificate_path is not null
       order by created_at desc limit 1);
  end if;
  return null;
end;
$$;

create trigger provider_profiles_requeue
after update on public.provider_profiles
for each row execute procedure public.provider_profiles_requeue();

-- ---------- RLS (browser/Realtime reads only; the server enforces access in lib/authz.ts) ----------
alter table public.provider_profiles enable row level security;
alter table public.practice_locations enable row level security;
alter table public.provider_locations enable row level security;
alter table public.credential_submissions enable row level security;
alter table public.provider_claim_tokens enable row level security;

grant select on public.provider_profiles, public.practice_locations, public.provider_locations to authenticated;

create policy "Providers read their own profile" on public.provider_profiles
for select to authenticated using (user_id = (select auth.uid()));

create policy "Members read their organisation's locations" on public.practice_locations
for select to authenticated using ((select public.is_org_member(org_id)));

create policy "Members read their organisation's provider locations" on public.provider_locations
for select to authenticated using ((select public.is_org_member(org_id)));

-- ---------- storage ----------
-- Public profile photos (public by design, random object names); credentials stay private and are only
-- reached through short-lived signed URLs minted for platform admins.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('provider-photos', 'provider-photos', true, 2097152, array['image/jpeg', 'image/png']),
  ('credentials', 'credentials', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- ---------- operations (service role only; each is one transaction) ----------

-- True when 020's guardian_links table exists and the user has an active link to a child.
create or replace function public.user_has_guardian_links(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_link boolean := false;
begin
  if to_regclass('public.guardian_links') is null then
    return false;
  end if;
  execute 'select exists (select 1 from public.guardian_links where user_id = $1 and status = ''active'')'
    into found_link using p_user;
  return found_link;
end;
$$;

-- FR-2 self-registration. The role is decided here, never by the client: only accounts that are a plain
-- guardian (no child links) or already a provider become providers; platform admins are refused.
create or replace function public.register_provider(
  p_user uuid, p_display_name text, p_provider_type text, p_profile_slug text, p_org_name text, p_org_slug text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_role_name text;
  existing uuid;
  new_org uuid;
  new_profile uuid;
begin
  select role into current_role_name from public.user_profiles where id = p_user for update;
  if current_role_name is null or current_role_name not in ('guardian', 'provider') then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if public.user_has_guardian_links(p_user) then
    return jsonb_build_object('result', 'forbidden');
  end if;

  select id into existing from public.provider_profiles where user_id = p_user;
  if existing is not null then
    return jsonb_build_object('result', 'exists', 'profile_id', existing);
  end if;

  insert into public.organizations (name, slug, kind, city, created_by)
  values (p_org_name, p_org_slug, 'solo', 'Hyderabad', p_user)
  returning id into new_org;
  insert into public.org_members (org_id, user_id, org_role) values (new_org, p_user, 'owner');

  update public.user_profiles set role = 'provider' where id = p_user;

  insert into public.provider_profiles (user_id, slug, display_name, provider_type, claimed, created_by)
  values (p_user, p_profile_slug, p_display_name, p_provider_type, true, p_user)
  returning id into new_profile;

  return jsonb_build_object('result', 'created', 'profile_id', new_profile, 'org_id', new_org);
end;
$$;

-- FR-5 admin seeding: organisation (or an existing seeded one) + location + unclaimed profile.
create or replace function public.seed_provider_profile(p_admin uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_org uuid := nullif(p ->> 'org_id', '')::uuid;
  target_location uuid := nullif(p ->> 'location_id', '')::uuid;
  new_profile uuid;
  is_verified boolean := coalesce((p ->> 'verified')::boolean, false);
begin
  if target_org is null then
    insert into public.organizations (name, slug, kind, city, created_by, public_name, phone_public, website, listed)
    values (
      p ->> 'org_name', p ->> 'org_slug', p ->> 'org_kind', coalesce(p ->> 'city', 'Hyderabad'), p_admin,
      p ->> 'org_name', nullif(p ->> 'phone_public', ''), nullif(p ->> 'website', ''), is_verified
    )
    returning id into target_org;
  elsif not exists (select 1 from public.organizations where id = target_org) then
    return jsonb_build_object('result', 'org_not_found');
  end if;

  if target_location is null then
    insert into public.practice_locations (org_id, name, address_line1, address_line2, locality, city, state, pincode, lat, lng)
    values (
      target_org, p ->> 'location_name', p ->> 'address_line1', nullif(p ->> 'address_line2', ''), p ->> 'locality',
      coalesce(p ->> 'city', 'Hyderabad'), coalesce(p ->> 'state', 'Telangana'), p ->> 'pincode',
      nullif(p ->> 'lat', '')::numeric, nullif(p ->> 'lng', '')::numeric
    )
    returning id into target_location;
  elsif not exists (select 1 from public.practice_locations where id = target_location and org_id = target_org) then
    return jsonb_build_object('result', 'location_not_found');
  end if;

  insert into public.provider_profiles (
    slug, display_name, provider_type, qualifications, bio, languages, years_experience,
    registration_council, registration_state, registration_number,
    verification_status, verified_by, verified_at, verification_note, listed, claimed, is_synthetic, created_by
  ) values (
    p ->> 'slug', p ->> 'display_name', p ->> 'provider_type', nullif(p ->> 'qualifications', ''), nullif(p ->> 'bio', ''),
    coalesce(array(select jsonb_array_elements_text(p -> 'languages')), '{}'),
    nullif(p ->> 'years_experience', '')::int,
    nullif(p ->> 'registration_council', ''), nullif(p ->> 'registration_state', ''), nullif(p ->> 'registration_number', ''),
    case when is_verified then 'verified' else 'unverified' end,
    case when is_verified then p_admin end,
    case when is_verified then now() end,
    case when is_verified then nullif(p ->> 'verification_note', '') end,
    is_verified, false, coalesce((p ->> 'is_synthetic')::boolean, false), p_admin
  ) returning id into new_profile;

  insert into public.provider_locations (provider_profile_id, location_id, org_id)
  values (new_profile, target_location, target_org);

  if is_verified then
    insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
    values ('system', p_admin, 'provider.verified', 'provider_profile', new_profile::text,
      jsonb_build_object('via', 'seed', 'council', p ->> 'registration_council', 'note', p ->> 'verification_note'));
  end if;

  return jsonb_build_object('result', 'created', 'profile_id', new_profile, 'org_id', target_org, 'location_id', target_location);
end;
$$;

-- FR-5 claim link: a new link revokes every outstanding one for the profile.
create or replace function public.create_provider_claim_token(
  p_profile uuid, p_hash text, p_expires timestamptz, p_creator uuid
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  prof public.provider_profiles%rowtype;
begin
  select * into prof from public.provider_profiles where id = p_profile for update;
  if not found then
    return 'not_found';
  end if;
  if prof.user_id is not null or prof.claimed then
    return 'claimed';
  end if;
  update public.provider_claim_tokens set revoked_at = now()
  where provider_profile_id = p_profile and used_at is null and revoked_at is null;
  insert into public.provider_claim_tokens (provider_profile_id, token_hash, expires_at, created_by)
  values (p_profile, p_hash, p_expires, p_creator);
  return 'created';
end;
$$;

-- FR-6 claim. Token and profile rows are locked, so a link can be used once even under concurrency.
create or replace function public.claim_provider_profile(p_hash text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok public.provider_claim_tokens%rowtype;
  prof public.provider_profiles%rowtype;
  current_role_name text;
  org record;
begin
  select * into tok from public.provider_claim_tokens where token_hash = p_hash for update;
  if not found or tok.used_at is not null or tok.revoked_at is not null or tok.expires_at <= now() then
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into prof from public.provider_profiles where id = tok.provider_profile_id for update;
  if prof.user_id is not null or prof.claimed then
    return jsonb_build_object('result', 'invalid');
  end if;

  select role into current_role_name from public.user_profiles where id = p_user for update;
  if current_role_name is null or current_role_name not in ('guardian', 'provider') then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if public.user_has_guardian_links(p_user) then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if exists (select 1 from public.provider_profiles where user_id = p_user) then
    return jsonb_build_object('result', 'has_profile');
  end if;

  update public.provider_profiles set user_id = p_user, claimed = true where id = prof.id;

  -- The claimant owns each seeded organisation that has no active owner yet; otherwise joins as member.
  for org in
    select distinct pl.org_id from public.provider_locations pl where pl.provider_profile_id = prof.id
  loop
    perform 1 from public.organizations where id = org.org_id for update;
    insert into public.org_members (org_id, user_id, org_role, status)
    values (
      org.org_id, p_user,
      case when exists (
        select 1 from public.org_members where org_id = org.org_id and org_role = 'owner' and status = 'active'
      ) then 'member' else 'owner' end,
      'active'
    )
    on conflict (org_id, user_id) do update set status = 'active', revoked_at = null;
  end loop;

  update public.user_profiles set role = 'provider' where id = p_user;
  update public.provider_claim_tokens set used_at = now(), used_by = p_user where id = tok.id;
  update public.provider_claim_tokens set revoked_at = now()
  where provider_profile_id = prof.id and id <> tok.id and used_at is null and revoked_at is null;

  return jsonb_build_object('result', 'claimed', 'profile_id', prof.id, 'slug', prof.slug);
end;
$$;

-- FR-3 submit for verification. Replaces an open submission, moves the profile to `pending` (unlisted).
-- Returns the replaced certificate path so the caller can delete the orphaned object.
create or replace function public.submit_provider_credentials(
  p_profile uuid, p_user uuid, p_council text, p_state text, p_number text, p_certificate text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  prof public.provider_profiles%rowtype;
  open_id uuid;
  old_certificate text;
  submission uuid;
begin
  select * into prof from public.provider_profiles where id = p_profile for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if prof.verification_status = 'suspended' then
    return jsonb_build_object('result', 'suspended');
  end if;

  select id, certificate_path into open_id, old_certificate
  from public.credential_submissions where provider_profile_id = p_profile and status = 'submitted' for update;

  if open_id is not null then
    update public.credential_submissions
    set council = p_council, state = p_state, registration_number = p_number, certificate_path = p_certificate,
        submitted_by = p_user, created_at = now()
    where id = open_id;
    submission := open_id;
  else
    insert into public.credential_submissions (provider_profile_id, council, state, registration_number, certificate_path, submitted_by)
    values (p_profile, p_council, p_state, p_number, p_certificate, p_user)
    returning id into submission;
  end if;

  update public.provider_profiles
  set registration_council = p_council, registration_state = p_state, registration_number = p_number,
      verification_status = 'pending', listed = false
  where id = p_profile;

  return jsonb_build_object(
    'result', 'submitted', 'submission_id', submission,
    'replaced_certificate', case when old_certificate is distinct from p_certificate then old_certificate end
  );
end;
$$;

-- FR-4 approve/reject. Strict audit: the audit row is part of the same transaction.
create or replace function public.review_credential_submission(
  p_submission uuid, p_admin uuid, p_action text, p_note text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sub public.credential_submissions%rowtype;
  profile_status text;
  note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into sub from public.credential_submissions where id = p_submission for update;
  if not found or sub.status <> 'submitted' then
    return jsonb_build_object('result', 'not_found');
  end if;
  select verification_status into profile_status from public.provider_profiles
  where id = sub.provider_profile_id for update;
  if profile_status = 'suspended' and p_action = 'approve' then
    return jsonb_build_object('result', 'suspended');
  end if;

  if p_action = 'approve' then
    if sub.council = 'OTHER' and note is null then
      return jsonb_build_object('result', 'note_required');
    end if;
    update public.credential_submissions
    set status = 'approved', reviewer_id = p_admin, reviewer_note = note, reviewed_at = now()
    where id = sub.id;
    update public.provider_profiles
    set registration_council = sub.council, registration_state = sub.state, registration_number = sub.registration_number,
        verification_status = 'verified', verified_by = p_admin, verified_at = now(), verification_note = note
    where id = sub.provider_profile_id;
    insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
    values ('system', p_admin, 'provider.verified', 'provider_profile', sub.provider_profile_id::text,
      jsonb_build_object('submission_id', sub.id, 'council', sub.council, 'note', note));
    return jsonb_build_object('result', 'approved', 'profile_id', sub.provider_profile_id);
  elsif p_action = 'reject' then
    if note is null then
      return jsonb_build_object('result', 'note_required');
    end if;
    update public.credential_submissions
    set status = 'rejected', reviewer_id = p_admin, reviewer_note = note, reviewed_at = now()
    where id = sub.id;
    update public.provider_profiles set verification_status = 'rejected'
    where id = sub.provider_profile_id and verification_status = 'pending';
    insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
    values ('system', p_admin, 'provider.rejected', 'provider_profile', sub.provider_profile_id::text,
      jsonb_build_object('submission_id', sub.id, 'council', sub.council, 'note', note));
    return jsonb_build_object('result', 'rejected', 'profile_id', sub.provider_profile_id);
  end if;
  return jsonb_build_object('result', 'invalid_action');
end;
$$;

-- FR-4 suspend a verified profile (unlists it). Strict audit as above.
create or replace function public.suspend_provider_profile(p_profile uuid, p_admin uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  note text := nullif(btrim(coalesce(p_note, '')), '');
  cur_status text;
begin
  select verification_status into cur_status from public.provider_profiles where id = p_profile for update;
  if cur_status is null then
    return 'not_found';
  end if;
  if cur_status <> 'verified' then
    return 'not_verified';
  end if;
  if note is null then
    return 'note_required';
  end if;
  update public.provider_profiles set verification_status = 'suspended', listed = false where id = p_profile;
  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('system', p_admin, 'provider.suspended', 'provider_profile', p_profile::text, jsonb_build_object('note', note));
  return 'suspended';
end;
$$;

revoke all on function public.provider_profiles_requeue() from public, anon, authenticated;
revoke all on function public.user_has_guardian_links(uuid) from public, anon, authenticated;
revoke all on function public.register_provider(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.seed_provider_profile(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.create_provider_claim_token(uuid, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.claim_provider_profile(text, uuid) from public, anon, authenticated;
revoke all on function public.submit_provider_credentials(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.review_credential_submission(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.suspend_provider_profile(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.user_has_guardian_links(uuid) to service_role;
grant execute on function public.register_provider(uuid, text, text, text, text, text) to service_role;
grant execute on function public.seed_provider_profile(uuid, jsonb) to service_role;
grant execute on function public.create_provider_claim_token(uuid, text, timestamptz, uuid) to service_role;
grant execute on function public.claim_provider_profile(text, uuid) to service_role;
grant execute on function public.submit_provider_credentials(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.review_credential_submission(uuid, uuid, text, text) to service_role;
grant execute on function public.suspend_provider_profile(uuid, uuid, text) to service_role;
grant execute on function public.provider_prescriber_rule(text, text, text) to authenticated, service_role;
grant execute on function public.provider_can_prescribe(uuid) to authenticated, service_role;
