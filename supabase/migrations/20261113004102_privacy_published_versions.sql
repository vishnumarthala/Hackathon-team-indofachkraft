-- 041 x 024: erasure of published clinical documents. `published_versions` (024) is append-only; rows with a case go
-- with the case (allowed by 024's trigger). Rows without a case could never be removed, so an approved `everything`
-- deletion request (FR-8) gets one narrow exception: `privacy_delete_published_versions(child)` sets the
-- transaction-local flag `dnm.privacy_maintenance` (same flag as the consent-log redaction) and deletes that child's
-- case-less rows. Everything else in 024's rule is unchanged.

create or replace function public.published_versions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The one allowed delete: the case cascade (the case row is already gone).
  if tg_op = 'DELETE' and old.case_id is not null
     and not exists (select 1 from public.cases where id = old.case_id) then
    return old;
  end if;
  -- 041: erasure of case-less rows inside privacy_delete_published_versions().
  if tg_op = 'DELETE' and tg_level = 'ROW' and current_setting('dnm.privacy_maintenance', true) = 'on' then
    return old;
  end if;
  -- The one allowed update: child_id follows its case when a guardian merges a placeholder child into their
  -- own child (020 claim_child re-points cases.child_id; trigger cases_child_follow). Nothing else may change.
  if tg_op = 'UPDATE' and old.case_id is not null
     and new.child_id is distinct from old.child_id
     and new.child_id = (select c.child_id from public.cases c where c.id = old.case_id)
     and (to_jsonb(new) - 'child_id') = (to_jsonb(old) - 'child_id') then
    return new;
  end if;
  raise exception 'published_versions is append-only' using errcode = '42501';
end;
$$;

create or replace function public.privacy_delete_published_versions(p_child uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform set_config('dnm.privacy_maintenance', 'on', true);
  delete from public.published_versions where child_id = p_child and case_id is null;
  get diagnostics n = row_count;
  perform set_config('dnm.privacy_maintenance', 'off', true);
  return n;
end;
$$;

revoke all on function public.privacy_delete_published_versions(uuid) from public, anon, authenticated;
grant execute on function public.privacy_delete_published_versions(uuid) to service_role;
