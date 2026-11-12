-- 029: PostGIS "near me" directory.
-- Additive only: the PostGIS extension, a trigger-maintained geography column on practice_locations (backfilled
-- from the existing lat/lng), two defaulted consultation-mode flags on provider_profiles, and the read-only
-- search function behind GET /api/public/providers and /find.

create extension if not exists postgis with schema extensions;

-- ---------- practice_locations.geog ----------
-- Always derived from lat/lng (WGS 84) by the trigger below; null while the address could not be geocoded,
-- and null-geo locations are never searchable (FR-4).
alter table public.practice_locations add column geog extensions.geography(Point, 4326);

create or replace function public.practice_locations_set_geog()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lat is null or new.lng is null then
    new.geog := null;
  else
    new.geog := extensions.st_setsrid(extensions.st_makepoint(new.lng::float8, new.lat::float8), 4326)::extensions.geography;
  end if;
  return new;
end;
$$;

create trigger practice_locations_set_geog
before insert or update on public.practice_locations
for each row execute procedure public.practice_locations_set_geog();

-- Backfill: the trigger computes geog for every existing location that already has coordinates.
update public.practice_locations set lat = lat where lat is not null and lng is not null;

create index practice_locations_geog_idx on public.practice_locations using gist (geog);

-- ---------- consultation modes ----------
-- Set by the provider (profile editor) or a platform admin (seeding) for now; 030 derives them from active services.
alter table public.provider_profiles
  add column offers_video boolean not null default false,
  add column offers_in_clinic boolean not null default true;

-- ---------- search ----------
-- FR-2: verified + listed profiles near a point, one row per profile (its nearest geocoded location within the
-- radius), ordered by distance then name. Mode `video` also returns video-only providers (no in-clinic visits)
-- whatever their distance, after the nearby ones, ordered by name (distance_km null). `centre` in p_types
-- matches profiles practising at a centre. Demo (is_synthetic) profiles are included unless
-- p_include_synthetic is false (the API passes SHOW_SYNTHETIC_LISTINGS). rating_* stay null until 036.
-- Never reads or returns user ids, emails, registration numbers or verification notes.
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
    h.o_name, h.o_kind, h.o_slug, e.offers_video, e.offers_in_clinic, null::numeric, null::int, e.is_synthetic,
    h.loc_lat, h.loc_lng
  from hits h
  join eligible e on e.id = h.pid
  order by (h.dist is null), h.dist, e.display_name, e.id
  limit greatest(1, least(100, coalesce(p_limit, 20)))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.practice_locations_set_geog() from public, anon, authenticated;
revoke all on function public.search_providers(float8, float8, int, text[], text, text, int, int, boolean) from public, anon, authenticated;
grant execute on function public.search_providers(float8, float8, int, text[], text, text, int, int, boolean) to service_role;
