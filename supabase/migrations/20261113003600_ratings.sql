-- 036: verified-booking ratings. Additive only: a `ratings` table (one per completed appointment, written by the
-- booking guardian), the public summary view over published ratings, the rate-prompt outbox event (2 h after
-- completion, enqueued by a trigger in the completing transaction) and 029's `search_providers` filling
-- `rating_avg` / `rating_count`. The booking state machine (030) is unchanged. See docs/ratings.md.

-- ---------- table ----------
create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  provider_profile_id uuid not null references public.provider_profiles(id) on delete cascade,
  -- NFR-2: deleted with the guardian's account.
  guardian_user_id uuid not null references auth.users(id) on delete cascade,
  stars int not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(comment) between 1 and 500),
  status text not null default 'published' check (status in ('published', 'hidden', 'pending_review')),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  moderated_by uuid references auth.users(id) on delete set null,
  moderated_at timestamptz,
  moderation_note text check (char_length(moderation_note) <= 500),
  -- Why a rating is (or was last) waiting for review: the comment matched the abuse list, or the provider reported it.
  review_reason text check (review_reason in ('abuse_screen', 'provider_report')),
  reported_by uuid references auth.users(id) on delete set null,
  reported_at timestamptz,
  report_reason text check (char_length(report_reason) <= 500)
);
create index ratings_profile_published_idx on public.ratings (provider_profile_id, created_at desc) where status = 'published';
create index ratings_pending_idx on public.ratings (created_at) where status = 'pending_review';
create index ratings_guardian_idx on public.ratings (guardian_user_id);

-- When the appointment was completed (030 keeps the time in its append-only history).
create or replace function public.appointment_completed_at(p_appointment uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select max(e.created_at) from public.appointment_events e where e.appointment_id = p_appointment and e.to_status = 'completed'),
    (select a.updated_at from public.appointments a where a.id = p_appointment and a.status = 'completed')
  );
$$;

-- Defence in depth (the API checks eligibility first, D-1): a rating always belongs to a completed appointment, its
-- booking guardian and its provider; those links never change afterwards.
create or replace function public.ratings_check_appointment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.appointment_id <> old.appointment_id or new.provider_profile_id <> old.provider_profile_id
       or new.guardian_user_id <> old.guardian_user_id then
      raise exception 'rating_links_immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  if not exists (
    select 1 from public.appointments a
    where a.id = new.appointment_id and a.status = 'completed'
      and a.guardian_user_id = new.guardian_user_id and a.provider_profile_id = new.provider_profile_id
  ) then
    raise exception 'rating_not_eligible' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ratings_check_appointment before insert or update on public.ratings
for each row execute procedure public.ratings_check_appointment();

-- ---------- public summary (FR-1): published ratings only ----------
create view public.provider_rating_summary as
select r.provider_profile_id,
       round(avg(r.stars)::numeric, 1)::numeric(2, 1) as rating_avg,
       count(*)::int as rating_count
from public.ratings r
where r.status = 'published'
group by r.provider_profile_id;

-- ---------- RLS: guardians may read their own ratings; everything else goes through the server ----------
alter table public.ratings enable row level security;
revoke all on public.ratings from public, anon, authenticated;
grant select on public.ratings to authenticated;
grant select, insert, update, delete on public.ratings to service_role;
create policy "Guardians read their own ratings" on public.ratings
for select to authenticated using (guardian_user_id = (select auth.uid()));

revoke all on public.provider_rating_summary from public, anon, authenticated;
grant select on public.provider_rating_summary to service_role;

-- ---------- FR-2 rate prompt: 2 h after completion, in the completing transaction ----------
create or replace function public.ratings_enqueue_prompt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' and new.guardian_user_id is not null then
    perform public.outbox_enqueue(
      'appointment.rate_prompt', 'appointment', new.id,
      jsonb_build_object(
        'appointment_id', new.id,
        'provider_name', left(coalesce(nullif(new.service_snapshot ->> 'provider_name', ''),
          (select p.display_name from public.provider_profiles p where p.id = new.provider_profile_id), 'your provider'), 120)),
      'appt:' || new.id || ':rate_prompt',
      now() + interval '2 hours');
  end if;
  return null;
end;
$$;

create trigger appointments_rate_prompt after update of status on public.appointments
for each row when (new.status = 'completed' and old.status is distinct from new.status)
execute procedure public.ratings_enqueue_prompt();

-- ---------- 029 search_providers: rating columns from the summary ----------
-- rating_avg is returned only from 3 published ratings (D-2 display threshold, applied here too so no consumer can
-- show a small-sample average); rating_count is always the number of published ratings (0 when none).
create or replace function public.search_providers(
  p_lat float8,
  p_lng float8,
  p_radius_km int default 10,
  p_types text[] default null,
  p_language text default null,
  p_mode text default 'any',
  p_limit int default 20,
  p_offset int default 0,
  p_include_synthetic boolean default true
)
returns table (
  profile_id uuid,
  slug text,
  display_name text,
  provider_type text,
  languages text[],
  location_id uuid,
  locality text,
  distance_km float8,
  org_public_name text,
  org_kind text,
  org_slug text,
  offers_video boolean,
  offers_in_clinic boolean,
  rating_avg numeric,
  rating_count int,
  is_synthetic boolean,
  lat float8,
  lng float8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  radius_m float8;
  any_type boolean := p_types is null or cardinality(p_types) = 0;
  v_mode text := coalesce(p_mode, 'any');
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'search_providers: invalid coordinates' using errcode = '22023';
  end if;
  if v_mode not in ('in_clinic', 'video', 'any') then
    raise exception 'search_providers: invalid mode %', v_mode using errcode = '22023';
  end if;
  radius_m := greatest(1, least(50, coalesce(p_radius_km, 10))) * 1000.0;

  return query
  with origin as (
    select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography as g
  ),
  eligible as (
    select p.id, p.slug, p.display_name, p.provider_type, p.languages, p.offers_video, p.offers_in_clinic, p.is_synthetic
    from public.provider_profiles p
    where p.verification_status = 'verified'
      and p.listed
      and (p_include_synthetic or not p.is_synthetic)
      and (p_language is null or p_language = any (p.languages))
      and case v_mode
        when 'in_clinic' then p.offers_in_clinic
        when 'video' then p.offers_video
        else p.offers_in_clinic or p.offers_video
      end
  ),
  near as (
    select distinct on (e.id)
      e.id as pid, l.id as lid, l.locality as loc_locality, l.lat::float8 as loc_lat, l.lng::float8 as loc_lng,
      coalesce(o.public_name, o.name) as o_name, o.kind as o_kind, case when o.listed then o.slug end as o_slug,
      extensions.st_distance(l.geog, origin.g) / 1000.0 as dist
    from origin
    join public.practice_locations l on extensions.st_dwithin(l.geog, origin.g, radius_m)
    join public.provider_locations pl on pl.location_id = l.id
    join public.organizations o on o.id = l.org_id
    join eligible e on e.id = pl.provider_profile_id
    where any_type or e.provider_type = any (p_types) or ('centre' = any (p_types) and o.kind = 'centre')
    order by e.id, dist, l.id
  ),
  remote as (
    select e.id as pid, loc.lid, loc.loc_locality, null::float8 as loc_lat, null::float8 as loc_lng,
      loc.o_name, loc.o_kind, loc.o_slug, null::float8 as dist
    from eligible e
    left join lateral (
      select l.id as lid, l.locality as loc_locality, coalesce(o.public_name, o.name) as o_name, o.kind as o_kind,
        case when o.listed then o.slug end as o_slug
      from public.provider_locations pl
      join public.practice_locations l on l.id = pl.location_id
      join public.organizations o on o.id = l.org_id
      where pl.provider_profile_id = e.id
      order by (o.kind = 'centre') desc, l.name, l.id
      limit 1
    ) loc on true
    where v_mode = 'video'
      and not e.offers_in_clinic
      and not exists (select 1 from near n where n.pid = e.id)
      and (any_type or e.provider_type = any (p_types) or ('centre' = any (p_types) and loc.o_kind = 'centre'))
  ),
  hits as (
    select * from near
    union all
    select * from remote
  )
  select e.id, e.slug, e.display_name, e.provider_type, e.languages, h.lid, h.loc_locality, round(h.dist::numeric, 2)::float8,
    h.o_name, h.o_kind, h.o_slug, e.offers_video, e.offers_in_clinic,
    case when coalesce(s.rating_count, 0) >= 3 then s.rating_avg::numeric end, coalesce(s.rating_count, 0)::int,
    e.is_synthetic, h.loc_lat, h.loc_lng
  from hits h
  join eligible e on e.id = h.pid
  left join public.provider_rating_summary s on s.provider_profile_id = e.id
  order by (h.dist is null), h.dist, e.display_name, e.id
  limit greatest(1, least(100, coalesce(p_limit, 20)))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

-- ---------- grants: the server (service role) only ----------
revoke all on function public.appointment_completed_at(uuid) from public, anon, authenticated;
revoke all on function public.ratings_check_appointment() from public, anon, authenticated;
revoke all on function public.ratings_enqueue_prompt() from public, anon, authenticated;
revoke all on function public.search_providers(float8, float8, int, text[], text, text, int, int, boolean) from public, anon, authenticated;
grant execute on function public.appointment_completed_at(uuid) to service_role;
grant execute on function public.search_providers(float8, float8, int, text[], text, text, int, int, boolean) to service_role;
