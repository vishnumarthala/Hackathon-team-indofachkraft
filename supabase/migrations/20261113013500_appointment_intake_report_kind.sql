-- 035 (companion of 20261113003500_appointment_intake.sql): make sure reports.kind allows `generic_intake_brief`.
-- Migrations of later-numbered tickets (038 and up) restate the reports.kind list; on a fresh `db reset` they run
-- after 035's main migration. This file sorts after every 00:xx migration and extends the current list (it never
-- removes a kind), so the final schema has every ticket's kinds whatever the merge order. Idempotent.
do $$
declare
  v_def text;
  v_kinds text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
  where c.conrelid = 'public.reports'::regclass and c.conname = 'reports_kind_check';
  -- Both spellings Postgres prints: (ARRAY['a'::text, ...]) and ('{a,b}'::text[]).
  select coalesce(array_agg(distinct k), '{}') into v_kinds from (
    select m[1] as k from regexp_matches(coalesce(v_def, ''), '''([a-z_]+)''', 'g') as m
    union
    select unnest(string_to_array(m[1], ',')) from regexp_matches(coalesce(v_def, ''), '''\{([a-z_,]+)\}''', 'g') as m
  ) x;
  if not v_kinds @> array['generic_intake_brief'] then
    v_kinds := array(select distinct k from unnest(v_kinds || array['generic_intake_brief']) as k order by k);
    alter table public.reports drop constraint if exists reports_kind_check;
    execute format('alter table public.reports add constraint reports_kind_check check (kind in (%s))',
      (select string_agg(quote_literal(k), ', ') from unnest(v_kinds) as k));
  end if;
end;
$$;
