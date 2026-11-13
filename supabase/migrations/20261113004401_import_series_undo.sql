-- 044 extra scope (047 + 043 integration). 047 stored imported timetables as `pending` because weekly series (043)
-- were not deployed yet. Now that they are, the import creates the series (lib/import/store.ts -> 043 createSeries) and
-- this migration lets 047's undo remove the series created by that import together with their future, untouched
-- sessions. Every other safety check of the undo stays as it was (anything added to an imported child or case since
-- the import still blocks it).
--
-- A series created by the import counts as the import's own (like the care-team assignment and the unused claim code)
-- only while nobody has touched it:
--   * still `active`, never paused, not continued by a "this and future" change (no series replaces it), no resolved
--     conflict (unresolved conflicts were found by the import itself and go with the series);
--   * each of its appointments is `confirmed`, unmarked, in the future and still at the series time on its date (not
--     moved, cancelled, completed or marked by the attendance register, 044);
--   * no other row references the series or its appointments (payments, recordings, reports, ratings, intake links,
--     prescriptions, ...: read from the catalogue, so tables added later are covered too). The appointments' own state
--     history (`appointment_events`) does not count.
-- Otherwise the row is reported in `blocked_rows` and nothing is deleted.

-- `child_import_rows.series_id` had no FK (043 might not have been deployed); it is only read here.
--
-- Naming: this file sorts before 047's migration (20261113004700_child_import.sql), which creates `undo_child_import`
-- with `create or replace`; redefining that name here would be overwritten on a fresh database. So the new version is
-- `undo_child_import_with_series` (lib/import/store.ts calls it) and the body is compiled when first called, after
-- 047's tables exist. 047's `undo_child_import` stays as it was (unused; it refuses any import that has a series, so it
-- is never less safe).

set check_function_bodies = off;

create or replace function public.undo_child_import_with_series(p_import uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.child_imports%rowtype;
  fk record;
  v_rows int[];
  v_blocked int[] := '{}';
  v_cases uuid[];
  v_children uuid[];
  v_series uuid[];
  v_appts uuid[];
  v_series_count int := 0;
  v_sessions int := 0;
  r record;
begin
  select * into imp from public.child_imports where id = p_import for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not exists (
    select 1 from public.org_members
    where org_id = imp.org_id and user_id = p_actor and status = 'active' and org_role in ('owner', 'admin')
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;
  if imp.undone_at is not null then
    return jsonb_build_object('result', 'already_undone');
  end if;
  if now() > imp.undo_until then
    return jsonb_build_object('result', 'expired');
  end if;
  -- Same per-organisation lock as the import and `schedule pending timetables` (lib/import/store.ts).
  perform pg_advisory_xact_lock(hashtextextended('child_import:' || imp.org_id::text, 0));

  -- The import's own series (043), locked like every other series writer (series lock, then 030's provider lock).
  -- Advisory locks, so they are taken before the row locks below in the same order as series_materialize.
  select coalesce(array_agg(distinct s.id), '{}') into v_series
  from public.child_import_rows ir join public.appointment_series s on s.id = ir.series_id
  where ir.import_id = p_import and ir.timetable_status = 'scheduled' and s.org_id = imp.org_id
    and s.child_id = ir.child_id;
  for r in select s.id, s.provider_profile_id from public.appointment_series s where s.id = any (v_series) order by s.id loop
    perform public.series_lock(r.id);
  end loop;
  for r in select distinct s.provider_profile_id from public.appointment_series s where s.id = any (v_series)
           order by s.provider_profile_id loop
    perform public.booking_lock_provider(r.provider_profile_id);
  end loop;
  -- Serialise against claims and new records on these cases while we check and delete (after the series locks: the
  -- materializer takes those first and then needs the case rows for its inserts).
  perform 1 from public.cases c join public.child_import_rows ir on ir.case_id = c.id
  where ir.import_id = p_import for update of c;
  select coalesce(array_agg(a.id), '{}') into v_appts from public.appointments a where a.series_id = any (v_series);

  -- (1) Series touched since the import.
  select array_agg(distinct ir.row_number) into v_rows
  from public.child_import_rows ir join public.appointment_series s on s.id = ir.series_id
  where ir.import_id = p_import and s.id = any (v_series) and (
    s.status <> 'active' or s.paused_from is not null
    or exists (select 1 from public.series_conflicts c where c.series_id = s.id and c.resolved_at is not null)
    or exists (
      select 1 from public.appointments a
      where a.series_id = s.id and not (
        a.status = 'confirmed' and a.attendance is null and a.series_occurrence_date is not null
        and lower(a.slot) > now()
        and lower(a.slot) = public.series_occurrence_start(a.series_occurrence_date, s.start_time, s.time_zone)
      )
    )
  );
  v_blocked := v_blocked || coalesce(v_rows, '{}');

  -- (2) Anything else pointing at those series or their sessions.
  for fk in
    select con.conrelid::regclass as tbl, att.attname as col, con.confrelid::regclass as ref
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and cardinality(con.conkey) = 1
      and con.confrelid in ('public.appointments'::regclass, 'public.appointment_series'::regclass)
      and con.conrelid <> 'public.appointment_events'::regclass
      and not (con.conrelid = 'public.appointments'::regclass and att.attname = 'series_id')
      and not (con.conrelid = 'public.series_conflicts'::regclass and att.attname = 'series_id')
  loop
    if fk.ref = 'public.appointments'::regclass then
      execute format(
        'select array_agg(distinct ir.row_number) from %s t '
        'join public.appointments a on a.id = t.%I '
        'join public.child_import_rows ir on ir.series_id = a.series_id '
        'where ir.import_id = $1 and a.id = any ($2)', fk.tbl, fk.col)
      into v_rows using p_import, v_appts;
    else
      execute format(
        'select array_agg(distinct ir.row_number) from %s t '
        'join public.child_import_rows ir on ir.series_id = t.%I '
        'where ir.import_id = $1 and ir.series_id = any ($2)', fk.tbl, fk.col)
      into v_rows using p_import, v_series;
    end if;
    v_blocked := v_blocked || coalesce(v_rows, '{}');
  end loop;

  -- (3) 047's checks: any row in any table with a foreign key to an imported case or child. The import's own rows
  -- (assignments, unused codes, import rows) and, new in 044, its untouched series and their sessions do not count.
  for fk in
    select con.conrelid::regclass as tbl, att.attname as col, con.confrelid::regclass as ref
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and cardinality(con.conkey) = 1
      and con.confrelid in ('public.cases'::regclass, 'public.children'::regclass)
      and con.conrelid not in ('public.case_assignments'::regclass, 'public.child_import_rows'::regclass)
  loop
    if fk.tbl = 'public.child_claim_codes'::regclass then
      -- Unused codes are the import's own; a used code means a guardian claimed the child.
      select array_agg(distinct ir.row_number) into v_rows
      from public.child_claim_codes t
      join public.child_import_rows ir on (fk.ref = 'public.cases'::regclass and ir.case_id = t.case_id)
                                       or (fk.ref = 'public.children'::regclass and ir.child_id = t.child_id)
      where ir.import_id = p_import and t.used_at is not null;
    elsif fk.tbl = 'public.cases'::regclass then
      -- Another case for an imported child (e.g. merged or created by booking).
      execute format(
        'select array_agg(distinct ir.row_number) from public.cases t join public.child_import_rows ir on ir.child_id = t.%I '
        'where ir.import_id = $1 and t.id <> ir.case_id', fk.col)
      into v_rows using p_import;
    elsif fk.tbl = 'public.appointment_series'::regclass then
      execute format(
        'select array_agg(distinct ir.row_number) from public.appointment_series t '
        'join public.child_import_rows ir on %s '
        'where ir.import_id = $1 and t.id <> all ($2)',
        case when fk.ref = 'public.cases'::regclass then format('ir.case_id = t.%I', fk.col)
             else format('ir.child_id = t.%I', fk.col) end)
      into v_rows using p_import, v_series;
    elsif fk.tbl = 'public.appointments'::regclass then
      -- The series' sessions were checked in (1); any other appointment of the child or case blocks.
      execute format(
        'select array_agg(distinct ir.row_number) from public.appointments t '
        'join public.child_import_rows ir on %s '
        'where ir.import_id = $1 and t.id <> all ($2)',
        case when fk.ref = 'public.cases'::regclass then format('ir.case_id = t.%I', fk.col)
             else format('ir.child_id = t.%I', fk.col) end)
      into v_rows using p_import, v_appts;
    elsif fk.ref = 'public.cases'::regclass then
      execute format(
        'select array_agg(distinct ir.row_number) from %s t join public.child_import_rows ir on ir.case_id = t.%I '
        'where ir.import_id = $1', fk.tbl, fk.col)
      into v_rows using p_import;
    else
      execute format(
        'select array_agg(distinct ir.row_number) from %s t join public.child_import_rows ir on ir.child_id = t.%I '
        'where ir.import_id = $1', fk.tbl, fk.col)
      into v_rows using p_import;
    end if;
    v_blocked := v_blocked || coalesce(v_rows, '{}');
  end loop;

  -- A shared intake link counts as something added to the case.
  select v_blocked || coalesce(array_agg(ir.row_number), '{}') into v_blocked
  from public.child_import_rows ir join public.cases c on c.id = ir.case_id
  where ir.import_id = p_import and c.intake_token is not null;

  if cardinality(v_blocked) > 0 then
    return jsonb_build_object('result', 'blocked',
      'blocked_rows', (select to_jsonb(array_agg(distinct x order by x)) from unnest(v_blocked) x));
  end if;

  -- The series' untouched future sessions: withdraw their unsent jobs (reminders, Meet links), then delete them
  -- (their state history goes with them) and the series (open conflicts cascade). Nobody is messaged: imported
  -- children have no family account linked (a link would have blocked the undo above).
  for r in select a.id from public.appointments a where a.id = any (v_appts) loop
    perform public.outbox_cancel('appt:' || r.id || ':');
    perform public.outbox_cancel('meet:' || r.id || ':');
  end loop;
  delete from public.appointments where id = any (v_appts);
  get diagnostics v_sessions = row_count;
  delete from public.appointment_series where id = any (v_series);
  get diagnostics v_series_count = row_count;

  select array_agg(case_id), array_agg(child_id) into v_cases, v_children
  from public.child_import_rows where import_id = p_import;

  -- Cases cascade to their assignments, claim codes and import rows; then the (now unreferenced) children go.
  delete from public.cases where id = any (coalesce(v_cases, '{}'));
  delete from public.children where id = any (coalesce(v_children, '{}'));
  update public.child_imports set undone_at = now(), undone_by = p_actor where id = p_import;

  return jsonb_build_object('result', 'undone', 'org_id', imp.org_id,
                            'cases', coalesce(cardinality(v_cases), 0), 'children', coalesce(cardinality(v_children), 0),
                            'series', v_series_count, 'sessions', v_sessions);
end;
$$;

revoke all on function public.undo_child_import_with_series(uuid, uuid) from public, anon, authenticated;
grant execute on function public.undo_child_import_with_series(uuid, uuid) to service_role;

reset check_function_bodies;
