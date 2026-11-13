-- 047: import existing children from a spreadsheet (CSV).
-- Additive only (two new tables, two functions); no existing table changes, so there is nothing to backfill.
-- The uploaded file is never stored: an import keeps its sha256 hash and counts, and one row per created child
-- (ids, the spreadsheet row number, the optional notes and timetable). Consent is never imported (decision
-- record rules 1 and 6): imported children start with no consent records. Nothing is messaged (NFR-2).

-- =====================================================================================================
-- tables
-- =====================================================================================================

create table if not exists public.child_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  total_rows int not null check (total_rows between 0 and 500),
  imported_count int not null default 0 check (imported_count >= 0),
  skipped_count int not null default 0 check (skipped_count >= 0),
  failed_count int not null default 0 check (failed_count >= 0),
  timetable_pending_count int not null default 0 check (timetable_pending_count >= 0),
  series_created_count int not null default 0 check (series_created_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- FR-5: owner/admin can undo for 24 h.
  undo_until timestamptz not null default (now() + interval '24 hours'),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null
);
-- FR-3: one live import per file and organisation (idempotent by file hash). An undone import frees the hash.
create unique index if not exists child_imports_live_hash_uq on public.child_imports (org_id, file_hash) where undone_at is null;
create index if not exists child_imports_org_idx on public.child_imports (org_id, created_at desc);

create table if not exists public.child_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.child_imports(id) on delete cascade,
  -- Spreadsheet row number (the header is row 1), as shown in the preview's messages.
  row_number int not null check (row_number between 2 and 501),
  child_id uuid not null references public.children(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  therapist_user_id uuid references auth.users(id) on delete set null,
  notes text check (char_length(notes) between 1 and 500),
  -- Optional timetable columns: {"weekdays":[1,3,5],"time":"10:00","service_id":"...","service_name":"..."}.
  timetable jsonb check (timetable is null or jsonb_typeof(timetable) = 'object'),
  -- 'pending' = validated and kept until weekly series (ticket 043) can be created; 'scheduled' = a series exists.
  timetable_status text check (timetable_status in ('pending', 'scheduled')),
  series_id uuid, -- 043's appointment_series id (no FK: 043 may not be deployed yet)
  created_at timestamptz not null default now(),
  unique (import_id, row_number),
  constraint child_import_rows_timetable_pair_check check ((timetable is null) = (timetable_status is null))
);
create index if not exists child_import_rows_import_idx on public.child_import_rows (import_id, row_number);
create index if not exists child_import_rows_case_idx on public.child_import_rows (case_id);
create index if not exists child_import_rows_child_idx on public.child_import_rows (child_id);

-- Server-only tables (the server gates every route with lib/authz.ts + lib/orgs.ts); no client access.
alter table public.child_imports enable row level security;
alter table public.child_import_rows enable row level security;
revoke all on public.child_imports, public.child_import_rows from anon, authenticated;

-- =====================================================================================================
-- FR-3: create the children, cases, therapist assignments and claim codes of one import (one transaction,
-- called by lib/import/store.ts inside its `sql.begin`, which also writes the strict `children.imported` audit).
-- p_rows: [{row_number, display_name, date_of_birth, child_age_months, guardian_name, guardian_phone, language,
--           therapist_user_id, therapist_name, notes, code_hash, timetable}]
-- Returns [{row_number, child_id, case_id, code_id, expires_at}].
-- =====================================================================================================

create or replace function public.import_children_rows(
  p_import uuid, p_org uuid, p_actor uuid, p_rows jsonb, p_code_ttl interval
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_child uuid;
  v_case uuid;
  v_therapist uuid;
  v_code jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = p_actor and status = 'active' and org_role in ('owner', 'admin')
  ) then
    raise exception 'import:forbidden';
  end if;
  if not exists (select 1 from public.child_imports where id = p_import and org_id = p_org and undone_at is null) then
    raise exception 'import:not_found';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_therapist := nullif(r ->> 'therapist_user_id', '')::uuid;
    if v_therapist is not null and not exists (
      select 1 from public.org_members where org_id = p_org and user_id = v_therapist and status = 'active'
    ) then
      raise exception 'import:therapist_not_member';
    end if;

    -- Unclaimed child (rule 2): no guardian link and no consent; a guardian links it later with the claim code.
    insert into public.children (display_name, date_of_birth, source, created_by)
    values (r ->> 'display_name', (r ->> 'date_of_birth')::date, 'provider', p_actor)
    returning id into v_child;

    if v_therapist is not null then
      -- The therapist's assignment is inserted in the same statement as the case. 022's after-insert trigger
      -- (cases_assign_care_team) fires at the end of the statement, sees an active assignment and leaves the
      -- care team alone, so the therapist (not the importing owner/admin) is the case lead.
      with new_case as (
        insert into public.cases (org_id, child_id, child_alias, child_age_months, parent_alias, parent_phone, language,
                                  therapist_name, created_by, status)
        values (p_org, v_child, r ->> 'display_name', nullif(r ->> 'child_age_months', '')::int, r ->> 'guardian_name',
                nullif(r ->> 'guardian_phone', ''), r ->> 'language', r ->> 'therapist_name', p_actor, 'booked')
        returning id
      )
      insert into public.case_assignments (case_id, user_id, care_role, assigned_by)
      select id, v_therapist, 'lead', p_actor from new_case
      returning case_id into v_case;
    else
      -- Without a therapist the importing owner/admin becomes the lead (022's default for a new case).
      insert into public.cases (org_id, child_id, child_alias, child_age_months, parent_alias, parent_phone, language,
                                therapist_name, created_by, status)
      values (p_org, v_child, r ->> 'display_name', nullif(r ->> 'child_age_months', '')::int, r ->> 'guardian_name',
              nullif(r ->> 'guardian_phone', ''), r ->> 'language', r ->> 'therapist_name', p_actor, 'booked')
      returning id into v_case;
    end if;

    -- 020 FR-12 code (72 h, regenerable). Only the hash is stored.
    v_code := public.create_child_claim_code(v_case, r ->> 'code_hash', p_actor, p_code_ttl);

    insert into public.child_import_rows (import_id, row_number, child_id, case_id, therapist_user_id, notes, timetable,
                                          timetable_status)
    values (p_import, (r ->> 'row_number')::int, v_child, v_case, v_therapist, nullif(r ->> 'notes', ''),
            case when jsonb_typeof(r -> 'timetable') = 'object' then r -> 'timetable' end,
            case when jsonb_typeof(r -> 'timetable') = 'object' then 'pending' end);

    v_out := v_out || jsonb_build_object('row_number', (r ->> 'row_number')::int, 'child_id', v_child, 'case_id', v_case,
                                         'code_id', v_code ->> 'id', 'expires_at', v_code ->> 'expires_at');
  end loop;
  return v_out;
end;
$$;

-- =====================================================================================================
-- FR-5: undo within 24 h. All or nothing: refused when any imported child or case has gained anything since
-- (a session note, recording, report, document, appointment, guardian link, consent record, another case, an
-- issued intake link, ...). "Anything" = a row in any table with a foreign key to cases(id) or children(id), so
-- tables added by later tickets are covered without changing this function. The import's own rows (care team
-- assignments, unused claim codes, the import rows) do not count.
-- Results: undone | blocked (blocked_rows = spreadsheet row numbers) | expired | already_undone | not_found.
-- =====================================================================================================

create or replace function public.undo_child_import(p_import uuid, p_actor uuid)
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

  -- Serialise against claims and new records on these cases while we check and delete.
  perform 1 from public.cases c join public.child_import_rows ir on ir.case_id = c.id
  where ir.import_id = p_import for update of c;

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

  select array_agg(case_id), array_agg(child_id) into v_cases, v_children
  from public.child_import_rows where import_id = p_import;

  -- Cases cascade to their assignments, claim codes and import rows; then the (now unreferenced) children go.
  delete from public.cases where id = any (coalesce(v_cases, '{}'));
  delete from public.children where id = any (coalesce(v_children, '{}'));
  update public.child_imports set undone_at = now(), undone_by = p_actor where id = p_import;

  return jsonb_build_object('result', 'undone', 'org_id', imp.org_id,
                            'cases', coalesce(cardinality(v_cases), 0), 'children', coalesce(cardinality(v_children), 0));
end;
$$;

revoke all on function public.import_children_rows(uuid, uuid, uuid, jsonb, interval) from public, anon, authenticated;
revoke all on function public.undo_child_import(uuid, uuid) from public, anon, authenticated;
grant execute on function public.import_children_rows(uuid, uuid, uuid, jsonb, interval) to service_role;
grant execute on function public.undo_child_import(uuid, uuid) to service_role;
