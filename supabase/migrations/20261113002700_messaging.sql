-- Ticket 027: secure messaging between a child's guardians and the care team of one organisation's case.
-- Case-scoped threads, messages (optionally with a 023 document attached) and per-user read markers.
--
-- Access (one rule, used by the server through `thread_access_level` and by RLS / Realtime through
-- `can_access_thread`): a user reaches a thread while they are an active guardian of the thread's (live) child,
-- or can access the thread's case under 022's rule (`case_access_level`: active owner/admin of the org, or an
-- active member with an active assignment). Revoking the guardian link, removing the assignment or revoking the
-- org membership ends access on the next request and for the next Realtime event (RLS is evaluated per change).
--
-- Writes go through the security-definer functions below (service role only), each one transaction with its
-- audit row (strict) and, for new messages, the `message.created` outbox event (032). Browsers only read, through
-- RLS; `messages` is in the `supabase_realtime` publication for live delivery.
--
-- plpgsql functions reference objects created by later-numbered migrations (provider_profiles: 028,
-- outbox_enqueue / outbox_cancel: 032); plpgsql resolves them at call time.

-- =====================================================================================================
-- tables
-- =====================================================================================================

create table if not exists public.message_threads (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 120 and char_length(btrim(subject)) >= 1),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null
);
create index if not exists message_threads_case_idx on public.message_threads (case_id, last_message_at desc);
create index if not exists message_threads_child_idx on public.message_threads (child_id, last_message_at desc);
create index if not exists message_threads_org_idx on public.message_threads (org_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.message_threads(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  sender_kind text not null check (sender_kind in ('guardian', 'provider')),
  body text not null check (char_length(body) between 1 and 4000 and char_length(btrim(body)) >= 1),
  document_id uuid references public.documents(id) on delete set null,
  client_id uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint messages_sender_client_uq unique (sender_id, client_id)
);
create index if not exists messages_thread_created_idx on public.messages (thread_id, created_at desc, id desc);
create index if not exists messages_sender_created_idx on public.messages (sender_id, created_at desc);

create table if not exists public.thread_reads (
  thread_id uuid not null references public.message_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- The thread's org/child follow its case (020's claim flow can re-point a case to another child record).
create or replace function public.cases_sync_message_threads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.message_threads
  set org_id = new.org_id, child_id = new.child_id
  where case_id = new.id and (org_id is distinct from new.org_id or child_id is distinct from new.child_id);
  return null;
end;
$$;
revoke all on function public.cases_sync_message_threads() from public, anon, authenticated;

drop trigger if exists cases_sync_message_threads on public.cases;
create trigger cases_sync_message_threads
after update of org_id, child_id on public.cases
for each row execute function public.cases_sync_message_threads();

-- =====================================================================================================
-- access rule (FR-1). One definition used by lib/messaging/access.ts, the list functions, RLS and Realtime.
-- =====================================================================================================

-- 'guardian' = active guardian link to the thread's live child; 'manage' / 'assigned' = 022 case access to the
-- thread's case (active membership included); null = no access.
create or replace function public.thread_access_level(p_user uuid, p_thread uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.guardian_links gl
      join public.children ch on ch.id = gl.child_id and ch.deleted_at is null
      where gl.child_id = t.child_id and gl.user_id = p_user and gl.status = 'active'
    ) then 'guardian'
    else public.case_access_level(p_user, t.case_id)
  end
  from public.message_threads t
  where t.id = p_thread and p_user is not null;
$$;

-- RLS / Realtime helper for the signed-in user.
create or replace function public.can_access_thread(thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.thread_access_level((select auth.uid()), thread_id) is not null, false);
$$;

-- Everyone who can currently read a case's threads: the child's active guardians and every active member of the
-- case's org with case access (owners/admins and the assigned care team).
create or replace function public.case_thread_participants(p_case uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gl.user_id
  from public.cases c
  join public.children ch on ch.id = c.child_id and ch.deleted_at is null
  join public.guardian_links gl on gl.child_id = c.child_id and gl.status = 'active'
  where c.id = p_case
  union
  select m.user_id
  from public.cases c
  join public.org_members m on m.org_id = c.org_id and m.status = 'active'
  where c.id = p_case and public.case_access_level(m.user_id, c.id) is not null;
$$;

-- FR-2: a document may be attached only when it is a ready document of the case's child that every current
-- participant can read under 023's rule (`document_access`), e.g. not a provider upload hidden from the parent and
-- not a family upload the guardian has not shared with the organisation.
create or replace function public.case_document_attachable(p_case uuid, p_doc uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.documents d join public.cases c on c.id = p_case
      where d.id = p_doc and d.status = 'ready' and d.child_id = c.child_id
    )
    and not exists (
      select 1 from public.case_thread_participants(p_case) u(user_id)
      where public.document_access(u.user_id, p_doc) is null
    );
$$;

revoke all on function public.thread_access_level(uuid, uuid) from public, anon, authenticated;
revoke all on function public.case_thread_participants(uuid) from public, anon, authenticated;
revoke all on function public.case_document_attachable(uuid, uuid) from public, anon, authenticated;
revoke all on function public.can_access_thread(uuid) from public;
grant execute on function public.thread_access_level(uuid, uuid) to service_role;
grant execute on function public.case_thread_participants(uuid) to service_role;
grant execute on function public.case_document_attachable(uuid, uuid) to service_role;
grant execute on function public.can_access_thread(uuid) to authenticated, service_role;

-- =====================================================================================================
-- RLS (NFR-1): the browser's only path to these rows. No insert/update/delete for anon/authenticated.
-- =====================================================================================================

alter table public.message_threads enable row level security;
alter table public.messages enable row level security;
alter table public.thread_reads enable row level security;
revoke all on public.message_threads, public.messages, public.thread_reads from anon, authenticated;
grant select on public.message_threads, public.messages, public.thread_reads to authenticated;

drop policy if exists "Participants read their threads" on public.message_threads;
create policy "Participants read their threads" on public.message_threads
for select to authenticated using (public.can_access_thread(id));

drop policy if exists "Participants read thread messages" on public.messages;
create policy "Participants read thread messages" on public.messages
for select to authenticated using (public.can_access_thread(thread_id));

-- Own read markers only (no per-message read receipts: out of scope), and only while the thread is reachable.
drop policy if exists "Participants read their own read markers" on public.thread_reads;
create policy "Participants read their own read markers" on public.thread_reads
for select to authenticated using (user_id = (select auth.uid()) and public.can_access_thread(thread_id));

-- FR-5: live delivery. Realtime evaluates the select policy above for every subscriber and change.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;

-- =====================================================================================================
-- reads (service role only; callers have passed the access gate or filter by it here)
-- =====================================================================================================

-- FR-2 `GET /api/threads`: threads p_user can access, optionally of one case or child, newest first, with the
-- number of messages from others since the user's read marker.
create or replace function public.list_message_threads(p_user uuid, p_case uuid default null, p_child uuid default null)
returns table (
  id uuid, subject text, case_id uuid, child_id uuid, org_id uuid, org_name text, child_name text, case_label text,
  created_at timestamptz, last_message_at timestamptz, archived_at timestamptz, unread integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select t.id from public.message_threads t
    join public.guardian_links gl on gl.child_id = t.child_id and gl.user_id = p_user and gl.status = 'active'
    join public.children ch on ch.id = t.child_id and ch.deleted_at is null
    union
    select t.id from public.message_threads t
    join public.org_members m on m.org_id = t.org_id and m.user_id = p_user and m.status = 'active'
    where public.case_access_level(p_user, t.case_id) is not null
  )
  select t.id, t.subject, t.case_id, t.child_id, t.org_id, o.name, ch.display_name, c.child_alias,
         t.created_at, t.last_message_at, t.archived_at,
         (select count(*)::int from public.messages m
          where m.thread_id = t.id and m.deleted_at is null and m.sender_id is distinct from p_user
            and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz))
  from public.message_threads t
  join mine on mine.id = t.id
  join public.organizations o on o.id = t.org_id
  join public.children ch on ch.id = t.child_id
  join public.cases c on c.id = t.case_id
  left join public.thread_reads r on r.thread_id = t.id and r.user_id = p_user
  where (p_case is null or t.case_id = p_case)
    and (p_child is null or t.child_id = p_child)
  order by t.last_message_at desc, t.id;
$$;

-- FR-2 `GET /api/threads/:id/messages`: one page (newest first; the API reverses it) with sender display data:
-- name (provider profile name, else profile display name) and, for providers, the care-team discipline label of
-- the thread's case and the 028 provider type. `p_message` returns just that message of the thread.
create or replace function public.thread_messages(
  p_thread uuid, p_before timestamptz default null, p_limit integer default 50, p_message uuid default null
)
returns table (
  id uuid, thread_id uuid, sender_id uuid, sender_kind text, sender_name text, discipline_label text,
  provider_type text, body text, document_id uuid, created_at timestamptz, deleted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
    select m.id, m.thread_id, m.sender_id, m.sender_kind,
           coalesce(pp.display_name, up.display_name),
           (select a.discipline_label from public.case_assignments a
            where a.case_id = t.case_id and a.user_id = m.sender_id and a.removed_at is null
            order by a.assigned_at desc limit 1),
           pp.provider_type,
           m.body, m.document_id, m.created_at, m.deleted_at
    from public.messages m
    join public.message_threads t on t.id = m.thread_id
    left join public.user_profiles up on up.id = m.sender_id
    left join public.provider_profiles pp on pp.user_id = m.sender_id and m.sender_kind = 'provider'
    where m.thread_id = p_thread and (p_before is null or m.created_at < p_before)
      and (p_message is null or m.id = p_message)
    order by m.created_at desc, m.id desc
    limit greatest(1, least(coalesce(p_limit, 50), 101));
end;
$$;

-- FR-3: who gets a `message.created` notification, decided at fan-out time: the child's active guardians, the
-- case's assigned care team and anyone who started or wrote in the thread, minus the sender, minus anyone who
-- lost access, minus anyone whose read marker is at or after the message. Nobody for a deleted message.
create or replace function public.message_notification_recipients(p_message uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with msg as (
    select m.id, m.thread_id, m.sender_id, m.created_at, t.case_id, t.child_id, t.created_by
    from public.messages m join public.message_threads t on t.id = m.thread_id
    where m.id = p_message and m.deleted_at is null
  ),
  candidates as (
    select gl.user_id from msg join public.guardian_links gl on gl.child_id = msg.child_id and gl.status = 'active'
    union
    select a.user_id from msg join public.case_assignments a on a.case_id = msg.case_id and a.removed_at is null
    union
    select x.sender_id from msg join public.messages x on x.thread_id = msg.thread_id where x.sender_id is not null
    union
    select msg.created_by from msg where msg.created_by is not null
  )
  select c.user_id
  from candidates c cross join msg
  where c.user_id is distinct from msg.sender_id
    and public.thread_access_level(c.user_id, msg.thread_id) is not null
    and not exists (
      select 1 from public.thread_reads r
      where r.thread_id = msg.thread_id and r.user_id = c.user_id and r.last_read_at >= msg.created_at
    );
$$;

revoke all on function public.list_message_threads(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.thread_messages(uuid, timestamptz, integer, uuid) from public, anon, authenticated;
revoke all on function public.message_notification_recipients(uuid) from public, anon, authenticated;
grant execute on function public.list_message_threads(uuid, uuid, uuid) to service_role;
grant execute on function public.thread_messages(uuid, timestamptz, integer, uuid) to service_role;
grant execute on function public.message_notification_recipients(uuid) to service_role;

-- =====================================================================================================
-- writes (service role only; each is one transaction). Results are returned as `{ result: <code>, ... }` and
-- mapped to HTTP statuses by lib/messaging/store.ts.
-- =====================================================================================================

-- Shared by create/send: message insert + thread bump + the sender's read marker + outbox event. The callers write
-- the `message.sent` audit row in the same transaction.
create or replace function public.insert_thread_message(
  p_thread public.message_threads, p_user uuid, p_kind text, p_body text, p_client_id uuid, p_document uuid
) returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
begin
  insert into public.messages (thread_id, sender_id, sender_kind, body, document_id, client_id)
  values (p_thread.id, p_user, p_kind, p_body, p_document, p_client_id)
  returning * into m;
  update public.message_threads set last_message_at = m.created_at where id = p_thread.id;
  insert into public.thread_reads (thread_id, user_id, last_read_at) values (p_thread.id, p_user, m.created_at)
  on conflict (thread_id, user_id) do update set last_read_at = greatest(public.thread_reads.last_read_at, excluded.last_read_at);
  -- FR-3: delivered in 2 minutes, to participants who have not read the thread by then (re-checked at fan-out).
  perform public.outbox_enqueue('message.created', 'thread', p_thread.id, jsonb_build_object('message_id', m.id),
                                'message:' || m.id, now() + interval '2 minutes');
  return m;
end;
$$;

-- 30 messages per user per 5 minutes (FR-2). Callers hold the per-user advisory lock.
create or replace function public.message_rate_limited(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) >= 30 from public.messages where sender_id = p_user and created_at > now() - interval '5 minutes';
$$;

-- FR-2 `POST /api/threads`. Results: created | existing | not_found | no_guardian | rate_limited |
-- document_not_attachable | client_id_conflict.
create or replace function public.create_message_thread(
  p_case uuid, p_user uuid, p_subject text, p_body text, p_client_id uuid, p_document uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.cases%rowtype;
  t public.message_threads%rowtype;
  m public.messages%rowtype;
  v_kind text;
begin
  -- Serialises one user's sends: idempotency and the rate limit see each other's rows.
  perform pg_advisory_xact_lock(hashtextextended('messages:' || p_user::text, 0));
  select * into c from public.cases where id = p_case;
  if not found or p_user is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if exists (
    select 1 from public.guardian_links gl join public.children ch on ch.id = gl.child_id and ch.deleted_at is null
    where gl.child_id = c.child_id and gl.user_id = p_user and gl.status = 'active'
  ) then
    v_kind := 'guardian';
  elsif public.case_access_level(p_user, c.id) is not null then
    v_kind := 'provider';
  else
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into m from public.messages where sender_id = p_user and client_id = p_client_id;
  if found then
    select * into t from public.message_threads where id = m.thread_id;
    if t.case_id is distinct from c.id then
      return jsonb_build_object('result', 'client_id_conflict');
    end if;
    return jsonb_build_object('result', 'existing', 'thread', to_jsonb(t), 'message', to_jsonb(m));
  end if;

  if not exists (
    select 1 from public.guardian_links gl join public.children ch on ch.id = gl.child_id and ch.deleted_at is null
    where gl.child_id = c.child_id and gl.status = 'active'
  ) then
    return jsonb_build_object('result', 'no_guardian');
  end if;
  if public.message_rate_limited(p_user) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  if p_document is not null and not public.case_document_attachable(c.id, p_document) then
    return jsonb_build_object('result', 'document_not_attachable');
  end if;

  insert into public.message_threads (case_id, org_id, child_id, subject, created_by)
  values (c.id, c.org_id, c.child_id, btrim(p_subject), p_user)
  returning * into t;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (c.id, case when v_kind = 'guardian' then 'parent' else 'therapist' end, p_user,
          'thread.created', 'message_thread', t.id::text,
          jsonb_build_object('org_id', c.org_id, 'child_id', c.child_id));
  m := public.insert_thread_message(t, p_user, v_kind, p_body, p_client_id, p_document);
  -- Strict audit in the same transaction; ids only, never the body (NFR-3).
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (t.case_id, case when m.sender_kind = 'guardian' then 'parent' else 'therapist' end, p_user,
          'message.sent', 'message', m.id::text, jsonb_build_object('thread_id', t.id, 'document_id', m.document_id));
  select * into t from public.message_threads where id = t.id;
  return jsonb_build_object('result', 'created', 'thread', to_jsonb(t), 'message', to_jsonb(m));
end;
$$;

-- FR-2 `POST /api/threads/:id/messages`. Results: created | existing | not_found | archived | rate_limited |
-- document_not_attachable | client_id_conflict.
create or replace function public.send_thread_message(
  p_thread uuid, p_user uuid, p_body text, p_client_id uuid, p_document uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.message_threads%rowtype;
  m public.messages%rowtype;
  v_level text;
begin
  perform pg_advisory_xact_lock(hashtextextended('messages:' || p_user::text, 0));
  -- Concurrent sends to one thread (any senders) and archive queue on the row; `for share` would deadlock with the
  -- `last_message_at` update in insert_thread_message.
  select * into t from public.message_threads where id = p_thread for no key update;
  v_level := public.thread_access_level(p_user, p_thread);
  if t.id is null or v_level is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select * into m from public.messages where sender_id = p_user and client_id = p_client_id;
  if found then
    if m.thread_id <> t.id then
      return jsonb_build_object('result', 'client_id_conflict');
    end if;
    return jsonb_build_object('result', 'existing', 'message', to_jsonb(m));
  end if;

  if t.archived_at is not null then
    return jsonb_build_object('result', 'archived');
  end if;
  if public.message_rate_limited(p_user) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  if p_document is not null and not public.case_document_attachable(t.case_id, p_document) then
    return jsonb_build_object('result', 'document_not_attachable');
  end if;

  m := public.insert_thread_message(t, p_user, case when v_level = 'guardian' then 'guardian' else 'provider' end,
                                    p_body, p_client_id, p_document);
  -- Strict audit in the same transaction; ids only, never the body (NFR-3).
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (t.case_id, case when m.sender_kind = 'guardian' then 'parent' else 'therapist' end, p_user,
          'message.sent', 'message', m.id::text, jsonb_build_object('thread_id', t.id, 'document_id', m.document_id));
  return jsonb_build_object('result', 'created', 'message', to_jsonb(m));
end;
$$;

-- FR-2 `DELETE /api/messages/:id`: own message, within 15 minutes, thread not archived. The body is replaced for
-- everyone (and the attachment link dropped); the pending notification is cancelled.
-- Results: deleted | not_found | forbidden | too_late | archived.
create or replace function public.delete_thread_message(p_message uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
  t public.message_threads%rowtype;
begin
  select * into m from public.messages where id = p_message for update;
  if not found or public.thread_access_level(p_user, m.thread_id) is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  select * into t from public.message_threads where id = m.thread_id;
  if m.sender_id is distinct from p_user then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if m.deleted_at is not null then
    return jsonb_build_object('result', 'deleted', 'message', to_jsonb(m));
  end if;
  if t.archived_at is not null then
    return jsonb_build_object('result', 'archived');
  end if;
  if m.created_at < now() - interval '15 minutes' then
    return jsonb_build_object('result', 'too_late');
  end if;
  update public.messages set deleted_at = now(), body = 'This message was deleted.', document_id = null
  where id = p_message
  returning * into m;
  perform public.outbox_cancel('message:' || m.id);
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (t.case_id, case when m.sender_kind = 'guardian' then 'parent' else 'therapist' end, p_user,
          'message.deleted', 'message', m.id::text, jsonb_build_object('thread_id', t.id));
  return jsonb_build_object('result', 'deleted', 'message', to_jsonb(m));
end;
$$;

-- FR-2 `POST /api/threads/:id/read`. Results: read | not_found.
create or replace function public.mark_thread_read(p_thread uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if public.thread_access_level(p_user, p_thread) is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  insert into public.thread_reads (thread_id, user_id, last_read_at) values (p_thread, p_user, clock_timestamp())
  on conflict (thread_id, user_id) do update set last_read_at = greatest(public.thread_reads.last_read_at, excluded.last_read_at)
  returning last_read_at into v_at;
  return jsonb_build_object('result', 'read', 'last_read_at', v_at);
end;
$$;

-- FR-6 `POST /api/threads/:id/archive`: owners/admins of the case's org. Results: archived | not_found | forbidden.
create or replace function public.archive_message_thread(p_thread uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.message_threads%rowtype;
  v_level text;
begin
  select * into t from public.message_threads where id = p_thread for update;
  v_level := public.thread_access_level(p_user, p_thread);
  if t.id is null or v_level is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if public.case_access_level(p_user, t.case_id) is distinct from 'manage' then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if t.archived_at is null then
    update public.message_threads set archived_at = now(), archived_by = p_user where id = p_thread returning * into t;
    insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
    values (t.case_id, 'therapist', p_user, 'thread.archived', 'message_thread', t.id::text, '{}'::jsonb);
  end if;
  return jsonb_build_object('result', 'archived', 'thread', to_jsonb(t));
end;
$$;

revoke all on function public.insert_thread_message(public.message_threads, uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.message_rate_limited(uuid) from public, anon, authenticated;
revoke all on function public.create_message_thread(uuid, uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.send_thread_message(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_thread_message(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_thread_read(uuid, uuid) from public, anon, authenticated;
revoke all on function public.archive_message_thread(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_message_thread(uuid, uuid, text, text, uuid, uuid) to service_role;
grant execute on function public.send_thread_message(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.delete_thread_message(uuid, uuid) to service_role;
grant execute on function public.mark_thread_read(uuid, uuid) to service_role;
grant execute on function public.archive_message_thread(uuid, uuid) to service_role;
