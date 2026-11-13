-- Ticket 023: document vault. A private, per-child document store: guardians upload prior reports, school
-- letters and prescriptions; providers attach documents to a case and choose whether the guardian sees them.
-- Additive only: a private bucket, two tables, access/list functions and security-definer write functions
-- (each one transaction with its audit row: strict, an audit failure saves nothing).
-- Who may read a document is defined once here (`document_access`) and used by every route, list and RLS.
-- FR-9: `document.shared_with_guardian` is enqueued with `public.outbox_enqueue` (ticket 032, migration
-- 20261113003200, applied later; plpgsql resolves it at call time) inside the same transaction as the change.

-- ---------- storage ----------
-- Private: no public URLs. Objects are reached only through 300 s signed URLs minted by the server after
-- `document_access` passed (GET /api/documents/:id/download). The bucket also enforces 20 MB and the types.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png', 'image/heic'])
on conflict (id) do nothing;

-- ---------- tables ----------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  case_id uuid references public.cases(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploader_kind text not null check (uploader_kind in ('guardian', 'provider')),
  category text not null check (category in
    ('prior_report', 'prescription', 'school', 'medical', 'assessment', 'consent_form', 'other')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  file_name text not null check (char_length(file_name) between 1 and 200),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  storage_path text not null unique check (char_length(storage_path) between 1 and 200),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'ready', 'deleted')),
  visible_to_guardian boolean not null default true,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  -- Guardian uploads belong to the child only; provider uploads to one case of one org.
  constraint documents_owner_check check (
    (uploader_kind = 'guardian' and case_id is null and org_id is null and visible_to_guardian)
    or (uploader_kind = 'provider' and case_id is not null and org_id is not null)
  ),
  constraint documents_deleted_check check ((status = 'deleted') = (deleted_at is not null))
);
create index if not exists documents_child_idx on public.documents (child_id, created_at desc) where status = 'ready';
create index if not exists documents_case_idx on public.documents (case_id, created_at desc) where status = 'ready';
create index if not exists documents_org_idx on public.documents (org_id, child_id) where status = 'ready';
create index if not exists documents_pending_idx on public.documents (created_at) where status = 'pending';

-- Per-document shares of guardian uploads with a treating organisation (read only, revocable).
create table if not exists public.document_org_shares (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  shared_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);
create unique index if not exists document_org_shares_active_uq
  on public.document_org_shares (document_id, org_id) where revoked_at is null;
create index if not exists document_org_shares_org_idx on public.document_org_shares (org_id) where revoked_at is null;

-- =====================================================================================================
-- access rule (FR-4). One definition used by lib/documents/access.ts, the list functions and RLS.
-- =====================================================================================================

-- For a `ready` document, how p_user may read it, or null (-> 404):
--   guardian  : active link to the (live) child, and the document is a guardian upload or visible_to_guardian
--   case      : provider upload, and p_user can access its case (022 case_access_level)
--   org_share : guardian upload shared with an org in which p_user can access a case of the child, while the
--               guardian who shared it is still linked to the child (fail closed, like 022 grants)
--   grant     : provider upload, and p_user's org holds a `documents` sharing grant from the document's org
-- Flags: can_delete (uploader, or owner/admin of the org for provider uploads; never via share/grant),
-- can_edit (provider with case access: visible_to_guardian), can_share (guardian, guardian uploads only).
create or replace function public.document_access(p_user uuid, p_doc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_grant uuid;
  v_manage boolean;
begin
  select * into d from public.documents where id = p_doc and status = 'ready';
  if not found or p_user is null then
    return null;
  end if;

  if exists (
    select 1 from public.guardian_links gl join public.children ch on ch.id = gl.child_id
    where gl.child_id = d.child_id and gl.user_id = p_user and gl.status = 'active' and ch.deleted_at is null
  ) and (d.uploader_kind = 'guardian' or d.visible_to_guardian) then
    return jsonb_build_object(
      'path', 'guardian',
      'can_delete', d.uploader_kind = 'guardian' and d.uploaded_by = p_user,
      'can_edit', false,
      'can_share', d.uploader_kind = 'guardian');
  end if;

  if d.uploader_kind = 'provider' then
    if public.case_access_level(p_user, d.case_id) is not null then
      v_manage := exists (
        select 1 from public.org_members m
        where m.org_id = d.org_id and m.user_id = p_user and m.status = 'active' and m.org_role in ('owner', 'admin'));
      return jsonb_build_object(
        'path', 'case',
        'can_delete', d.uploaded_by = p_user or v_manage,
        'can_edit', true,
        'can_share', false);
    end if;
    select g.grant_id into v_grant
    from public.active_sharing_grants(p_user, d.child_id, 'documents', null) g
    where g.source_org_id = d.org_id
    limit 1;
    if v_grant is not null then
      return jsonb_build_object('path', 'grant', 'grant_id', v_grant,
                                'can_delete', false, 'can_edit', false, 'can_share', false);
    end if;
    return null;
  end if;

  if exists (
    select 1 from public.document_org_shares s
    join public.guardian_links gl on gl.child_id = d.child_id and gl.user_id = s.shared_by and gl.status = 'active'
    join public.cases c on c.child_id = d.child_id and c.org_id = s.org_id
    where s.document_id = d.id and s.revoked_at is null
      and public.case_access_level(p_user, c.id) is not null
  ) then
    return jsonb_build_object('path', 'org_share', 'can_delete', false, 'can_edit', false, 'can_share', false);
  end if;
  return null;
end;
$$;

-- RLS helper for the signed-in user.
create or replace function public.can_read_document(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.document_access((select auth.uid()), target) is not null;
$$;

-- Organisations a guardian upload is currently shared with (sharing guardian still linked).
create or replace function public.document_active_share_orgs(p_doc uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.org_id
  from public.document_org_shares s
  join public.documents d on d.id = s.document_id
  join public.guardian_links gl on gl.child_id = d.child_id and gl.user_id = s.shared_by and gl.status = 'active'
  where s.document_id = p_doc and s.revoked_at is null;
$$;

-- FR-8: what the case workspace `Documents` tab lists for p_case: the case's own (ready) uploads and the
-- guardian uploads of the child currently shared with the case's org. The caller has passed requireCaseAccess.
create or replace function public.case_documents(p_case uuid)
returns setof public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.*
  from public.documents d
  join public.cases c on c.id = p_case
  where d.status = 'ready'
    and (
      (d.uploader_kind = 'provider' and d.case_id = p_case)
      or (
        d.uploader_kind = 'guardian' and d.child_id = c.child_id
        and exists (
          select 1 from public.document_org_shares s
          join public.guardian_links gl on gl.child_id = d.child_id and gl.user_id = s.shared_by and gl.status = 'active'
          where s.document_id = d.id and s.org_id = c.org_id and s.revoked_at is null
        )
      )
    )
  order by d.created_at desc;
$$;

revoke all on function public.document_access(uuid, uuid) from public, anon, authenticated;
revoke all on function public.document_active_share_orgs(uuid) from public, anon, authenticated;
revoke all on function public.case_documents(uuid) from public, anon, authenticated;
revoke all on function public.can_read_document(uuid) from public;
grant execute on function public.document_access(uuid, uuid) to service_role;
grant execute on function public.document_active_share_orgs(uuid) to service_role;
grant execute on function public.case_documents(uuid) to service_role;
grant execute on function public.can_read_document(uuid) to authenticated;

-- ---------- RLS (browser reads only; the server uses the service role and the gates above) ----------
alter table public.documents enable row level security;
alter table public.document_org_shares enable row level security;
revoke insert, update, delete, truncate on public.documents from anon, authenticated;
revoke insert, update, delete, truncate on public.document_org_shares from anon, authenticated;

drop policy if exists "Readers of a document read its row" on public.documents;
create policy "Readers of a document read its row" on public.documents
for select to authenticated using ((select public.can_read_document(id)));

drop policy if exists "Guardians read shares of their children's documents" on public.document_org_shares;
create policy "Guardians read shares of their children's documents" on public.document_org_shares
for select to authenticated using (
  exists (
    select 1 from public.documents d
    join public.guardian_links gl on gl.child_id = d.child_id and gl.user_id = (select auth.uid()) and gl.status = 'active'
    where d.id = document_id
  )
);

-- =====================================================================================================
-- writes (service role only; each is one transaction). Errors are raised as 'documents:<code>' and mapped
-- to HTTP statuses by lib/documents/*.ts.
-- =====================================================================================================

-- FR-3 step 1. p: { id, child_id, case_id?, org_id?, uploaded_by, uploader_kind, category, title, file_name,
-- mime_type, size_bytes, storage_path, visible_to_guardian, share_with_org_ids?: uuid[] }.
-- The caller has checked the uploader's access; this re-checks the shapes that span tables.
create or replace function public.create_document(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_org uuid;
  v_kind text := p ->> 'uploader_kind';
  v_child uuid := (p ->> 'child_id')::uuid;
  v_user uuid := (p ->> 'uploaded_by')::uuid;
begin
  if v_kind = 'guardian' then
    if not exists (
      select 1 from public.guardian_links gl join public.children ch on ch.id = gl.child_id
      where gl.child_id = v_child and gl.user_id = v_user and gl.status = 'active' and ch.deleted_at is null
    ) then
      raise exception 'documents:child_not_found';
    end if;
    for v_org in select distinct (jsonb_array_elements_text(coalesce(p -> 'share_with_org_ids', '[]'::jsonb)))::uuid loop
      if not exists (select 1 from public.cases where child_id = v_child and org_id = v_org) then
        raise exception 'documents:no_case';
      end if;
    end loop;
  elsif v_kind = 'provider' then
    if not exists (
      select 1 from public.cases
      where id = (p ->> 'case_id')::uuid and org_id = (p ->> 'org_id')::uuid and child_id = v_child
    ) then
      raise exception 'documents:case_not_found';
    end if;
  else
    raise exception 'documents:invalid';
  end if;

  insert into public.documents (id, child_id, case_id, org_id, uploaded_by, uploader_kind, category, title, file_name,
                                mime_type, size_bytes, storage_path, visible_to_guardian)
  values (
    (p ->> 'id')::uuid, v_child,
    case when v_kind = 'provider' then (p ->> 'case_id')::uuid end,
    case when v_kind = 'provider' then (p ->> 'org_id')::uuid end,
    v_user, v_kind, p ->> 'category', btrim(p ->> 'title'), p ->> 'file_name', p ->> 'mime_type',
    (p ->> 'size_bytes')::bigint, p ->> 'storage_path',
    case when v_kind = 'guardian' then true else coalesce((p ->> 'visible_to_guardian')::boolean, true) end
  )
  returning * into d;

  if v_kind = 'guardian' then
    insert into public.document_org_shares (document_id, org_id, shared_by)
    select distinct d.id, (o)::uuid, v_user
    from jsonb_array_elements_text(coalesce(p -> 'share_with_org_ids', '[]'::jsonb)) o;
  end if;
  return to_jsonb(d);
end;
$$;

-- FR-9: tell the child's guardians that a provider document became visible to them. Ids only (no title, no
-- clinical content, no child name). One event per document (dedup key): hiding and showing it again does not
-- notify twice. Recipients are re-checked at fan-out (lib/notify/topics.ts: active guardians, document still
-- ready and visible). Called only from the transactions below.
create or replace function public.document_notify_guardians(d public.documents)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.outbox_enqueue(
    'document.shared_with_guardian', 'document', d.id,
    jsonb_build_object('document_id', d.id, 'child_id', d.child_id),
    'document:' || d.id::text || ':shared_with_guardian', now());
end;
$$;

-- FR-3 step 2: pending -> ready with the verified size and checksum; audit `document.uploaded` (strict).
create or replace function public.complete_document(p_doc uuid, p_user uuid, p_size bigint, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_event bigint;
begin
  update public.documents
  set status = 'ready', size_bytes = p_size, sha256 = p_sha256, completed_at = now()
  where id = p_doc and status = 'pending' and uploaded_by = p_user
  returning * into d;
  if not found then
    return null;
  end if;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (d.case_id, case when d.uploader_kind = 'guardian' then 'parent' else 'therapist' end, p_user,
          'document.uploaded', 'document', d.id::text,
          jsonb_build_object('child_id', d.child_id, 'org_id', d.org_id, 'uploader_kind', d.uploader_kind,
                             'category', d.category, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes,
                             'visible_to_guardian', d.visible_to_guardian,
                             'shared_with_org_ids', coalesce((
                               select jsonb_agg(s.org_id) from public.document_org_shares s
                               where s.document_id = d.id and s.revoked_at is null), '[]'::jsonb)));
  if d.uploader_kind = 'provider' and d.visible_to_guardian then
    v_event := public.document_notify_guardians(d);
  end if;
  return to_jsonb(d) || jsonb_build_object('outbox_event_id', v_event);
end;
$$;

-- FR-2: the stored bytes do not match the declared type (or the size is wrong): pending -> deleted.
create or replace function public.reject_document(p_doc uuid, p_user uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
begin
  update public.documents set status = 'deleted', deleted_at = now(), deleted_by = p_user
  where id = p_doc and status = 'pending' and uploaded_by = p_user
  returning * into d;
  if not found then
    return false;
  end if;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (d.case_id, case when d.uploader_kind = 'guardian' then 'parent' else 'therapist' end, p_user,
          'document.rejected', 'document', d.id::text,
          jsonb_build_object('child_id', d.child_id, 'reason', p_reason, 'mime_type', d.mime_type));
  return true;
end;
$$;

-- FR-6: soft delete after the server checked `can_delete`; re-checked here under a row lock.
-- Results: deleted (+ storage_path) | not_found | forbidden.
create or replace function public.delete_document(p_doc uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_access jsonb;
begin
  perform 1 from public.documents where id = p_doc for update;
  v_access := public.document_access(p_user, p_doc);
  if v_access is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not (v_access ->> 'can_delete')::boolean then
    return jsonb_build_object('result', 'forbidden');
  end if;
  update public.documents set status = 'deleted', deleted_at = now(), deleted_by = p_user
  where id = p_doc
  returning * into d;
  update public.document_org_shares set revoked_at = now(), revoked_by = p_user
  where document_id = p_doc and revoked_at is null;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (d.case_id, case when v_access ->> 'path' = 'guardian' then 'parent' else 'therapist' end, p_user,
          'document.deleted', 'document', d.id::text,
          jsonb_build_object('child_id', d.child_id, 'org_id', d.org_id, 'uploader_kind', d.uploader_kind));
  return jsonb_build_object('result', 'deleted', 'storage_path', d.storage_path);
end;
$$;

-- E-2: a provider with case access changes `visible_to_guardian`. Results: updated (+ document, changed) |
-- not_found | forbidden.
create or replace function public.set_document_visibility(p_doc uuid, p_user uuid, p_visible boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_access jsonb;
  v_before boolean;
  v_event bigint;
begin
  select visible_to_guardian into v_before from public.documents where id = p_doc for update;
  v_access := public.document_access(p_user, p_doc);
  if v_access is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not (v_access ->> 'can_edit')::boolean then
    return jsonb_build_object('result', 'forbidden');
  end if;
  update public.documents set visible_to_guardian = p_visible where id = p_doc returning * into d;
  if v_before is distinct from p_visible then
    insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
    values (d.case_id, 'therapist', p_user, 'document.visibility_changed', 'document', d.id::text,
            jsonb_build_object('child_id', d.child_id, 'visible_to_guardian', p_visible));
    if p_visible then
      v_event := public.document_notify_guardians(d);
    end if;
  end if;
  return jsonb_build_object('result', 'updated', 'changed', v_before is distinct from p_visible, 'document', to_jsonb(d),
                            'outbox_event_id', v_event);
end;
$$;

-- FR-7: a linked guardian shares a guardian upload with a treating org / stops sharing it.
-- Results: shared | unchanged | not_found | forbidden | no_case  /  revoked | not_found | forbidden.
create or replace function public.share_document(p_doc uuid, p_org uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_access jsonb;
  v_share uuid;
begin
  select * into d from public.documents where id = p_doc for update;
  v_access := public.document_access(p_user, p_doc);
  if v_access is null or v_access ->> 'path' <> 'guardian' then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not (v_access ->> 'can_share')::boolean then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if not exists (select 1 from public.cases where child_id = d.child_id and org_id = p_org) then
    return jsonb_build_object('result', 'no_case');
  end if;
  -- An earlier share by a guardian who has since left the child no longer counts: replace it.
  update public.document_org_shares s set revoked_at = now(), revoked_by = p_user
  where s.document_id = p_doc and s.org_id = p_org and s.revoked_at is null
    and not exists (
      select 1 from public.guardian_links gl
      where gl.child_id = d.child_id and gl.user_id = s.shared_by and gl.status = 'active');
  if exists (select 1 from public.document_org_shares where document_id = p_doc and org_id = p_org and revoked_at is null) then
    return jsonb_build_object('result', 'unchanged');
  end if;
  insert into public.document_org_shares (document_id, org_id, shared_by) values (p_doc, p_org, p_user)
  returning id into v_share;
  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('parent', p_user, 'document.shared', 'document', p_doc::text,
          jsonb_build_object('child_id', d.child_id, 'org_id', p_org, 'share_id', v_share));
  return jsonb_build_object('result', 'shared');
end;
$$;

create or replace function public.unshare_document(p_doc uuid, p_org uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_access jsonb;
begin
  select * into d from public.documents where id = p_doc for update;
  v_access := public.document_access(p_user, p_doc);
  if v_access is null or v_access ->> 'path' <> 'guardian' then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not (v_access ->> 'can_share')::boolean then
    return jsonb_build_object('result', 'forbidden');
  end if;
  update public.document_org_shares set revoked_at = now(), revoked_by = p_user
  where document_id = p_doc and org_id = p_org and revoked_at is null;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('parent', p_user, 'document.share_revoked', 'document', p_doc::text,
          jsonb_build_object('child_id', d.child_id, 'org_id', p_org));
  return jsonb_build_object('result', 'revoked');
end;
$$;

-- FR-5 (D-4, strict): the download is recorded before a signed URL is minted; if this fails, no URL.
-- Re-checks access in the same statement so a revoked grant cannot slip between check and log.
create or replace function public.log_document_download(p_doc uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.documents%rowtype;
  v_access jsonb;
begin
  v_access := public.document_access(p_user, p_doc);
  if v_access is null then
    return null;
  end if;
  select * into d from public.documents where id = p_doc;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (d.case_id, case when v_access ->> 'path' = 'guardian' then 'parent' else 'therapist' end,
          p_user, 'document.downloaded', 'document', d.id::text,
          jsonb_build_object('child_id', d.child_id, 'org_id', d.org_id, 'access', v_access ->> 'path',
                             'grant_id', v_access ->> 'grant_id'));
  return jsonb_build_object('storage_path', d.storage_path, 'file_name', d.file_name, 'access', v_access);
end;
$$;

revoke all on function public.document_notify_guardians(public.documents) from public, anon, authenticated;
revoke all on function public.create_document(jsonb) from public, anon, authenticated;
revoke all on function public.complete_document(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.reject_document(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_document(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_document_visibility(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.share_document(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.unshare_document(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.log_document_download(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_document(jsonb) to service_role;
grant execute on function public.complete_document(uuid, uuid, bigint, text) to service_role;
grant execute on function public.reject_document(uuid, uuid, text) to service_role;
grant execute on function public.delete_document(uuid, uuid) to service_role;
grant execute on function public.set_document_visibility(uuid, uuid, boolean) to service_role;
grant execute on function public.share_document(uuid, uuid, uuid) to service_role;
grant execute on function public.unshare_document(uuid, uuid, uuid) to service_role;
grant execute on function public.log_document_download(uuid, uuid) to service_role;
