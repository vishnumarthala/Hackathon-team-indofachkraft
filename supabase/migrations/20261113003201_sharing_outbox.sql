-- 032 x 022: a guardian's sharing grant emits its `sharing.granted` outbox event in the granting transaction
-- (create_sharing_grant inserts the row, this trigger enqueues). Additive: one trigger function + trigger.
-- Recipients (grantee org owners/admins) are resolved and re-checked at fan-out time (lib/notify/topics.ts).

create or replace function public.sharing_grant_outbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.outbox_enqueue('sharing.granted', 'sharing_grant', new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'grant_id', new.id,
      'child_id', new.child_id,
      'source_org_id', new.source_org_id,
      'grantee_org_id', new.grantee_org_id,
      -- The grantee org's case for the child: the notification links to its `Shared with us` tab.
      'grantee_case_id', (select c.id from public.cases c
                          where c.child_id = new.child_id and c.org_id = new.grantee_org_id
                          order by c.created_at, c.id limit 1))),
    'sharing.granted:' || new.id::text, now());
  return null;
end;
$$;

drop trigger if exists sharing_grants_outbox on public.sharing_grants;
create trigger sharing_grants_outbox
after insert on public.sharing_grants
for each row execute function public.sharing_grant_outbox();

revoke all on function public.sharing_grant_outbox() from public, anon, authenticated;
