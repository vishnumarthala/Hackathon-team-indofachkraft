-- 041 FR-6 - FR-9: retention, guardian export, deletion requests (incl. external processors).
-- Additive: new tables, two recordings columns (backfilled), a private `exports` bucket and service-role-only
-- functions. The 020 consent log stays append-only; the only new exception is `privacy_redact_consent_records`,
-- which strips free text (paper note, guardian name on paper, user agent) from an erased child's records.
-- See docs/privacy/retention.md and lib/privacy/registry.ts.

-- =====================================================================================================
-- recordings: when the audio was transcribed (retention clock) and when it was deleted
-- =====================================================================================================

alter table public.recordings add column if not exists transcribed_at timestamptz;
alter table public.recordings add column if not exists audio_deleted_at timestamptz;
-- FR-12: ops shows recordings stuck in transcribing/extracting for more than 30 minutes.
alter table public.recordings add column if not exists status_changed_at timestamptz;
update public.recordings set status_changed_at = created_at where status_changed_at is null;
alter table public.recordings alter column status_changed_at set default now();

-- Backfill: rows already past transcription start their 90 days from creation (best known time).
update public.recordings set transcribed_at = created_at
where transcribed_at is null and status in ('transcribed', 'extracting', 'extracted');

create or replace function public.recordings_transcribed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('transcribed', 'extracting', 'extracted') and new.transcribed_at is null then
    new.transcribed_at := now();
  end if;
  if tg_op = 'INSERT' then
    new.status_changed_at := coalesce(new.status_changed_at, now());
  elsif new.status is distinct from old.status and new.status_changed_at is not distinct from old.status_changed_at then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists recordings_transcribed_at on public.recordings;
create trigger recordings_transcribed_at before insert or update of status on public.recordings
for each row execute function public.recordings_transcribed_at();

create index if not exists recordings_audio_retention_idx on public.recordings (transcribed_at)
  where storage_path is not null and audio_deleted_at is null;
create index if not exists recordings_created_pending_idx on public.recordings (created_at) where status = 'created';
create index if not exists recordings_busy_idx on public.recordings (status_changed_at) where status in ('transcribing', 'extracting');

-- =====================================================================================================
-- exports (FR-7)
-- =====================================================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exports', 'exports', false, 524288000, array['application/zip'])
on conflict (id) do nothing;

create table if not exists public.privacy_exports (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'building', 'ready', 'failed', 'expired')),
  storage_path text check (char_length(storage_path) between 1 and 200),
  size_bytes bigint check (size_bytes >= 0),
  file_count int check (file_count >= 0),
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (char_length(last_error) <= 300),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  deleted_at timestamptz
);
create index if not exists privacy_exports_child_idx on public.privacy_exports (child_id, created_at desc);
create index if not exists privacy_exports_due_idx on public.privacy_exports (created_at) where status in ('queued', 'building');
create index if not exists privacy_exports_expiry_idx on public.privacy_exports (expires_at) where status = 'ready';
-- At most one export per child is queued or building (FR-7); the request route also checks it under a lock.
create unique index if not exists privacy_exports_one_running_uq on public.privacy_exports (child_id)
  where status in ('queued', 'building');

-- =====================================================================================================
-- deletion requests (FR-8)
-- =====================================================================================================

create table if not exists public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id),
  -- Plain uuids (no FK): the request is a legal record and must survive account deletion.
  requested_by uuid not null,
  scope text not null check (scope in ('all_ai_processing', 'everything')),
  reason text check (char_length(reason) <= 1000),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'in_progress', 'completed', 'failed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 1000),
  -- Resumable execution (NFR-1): completed step names, so a re-run skips them.
  steps jsonb not null default '{}'::jsonb check (jsonb_typeof(steps) = 'object'),
  attempts int not null default 0 check (attempts >= 0),
  last_error text check (char_length(last_error) <= 300),
  locked_until timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint deletion_requests_review_check check (
    status in ('requested') or reviewed_by is not null
  ),
  constraint deletion_requests_reject_note_check check (
    status <> 'rejected' or char_length(btrim(coalesce(review_note, ''))) >= 10
  )
);
create index if not exists deletion_requests_child_idx on public.deletion_requests (child_id, created_at desc);
create index if not exists deletion_requests_status_idx on public.deletion_requests (status, created_at);
-- One open request per child.
create unique index if not exists deletion_requests_open_uq on public.deletion_requests (child_id)
  where status in ('requested', 'approved', 'in_progress', 'failed');

create table if not exists public.processor_deletions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.deletion_requests(id) on delete cascade,
  processor text not null check (processor in ('elevenlabs', 'gemini', 'resend', 'whatsapp')),
  external_ref text not null check (char_length(external_ref) between 1 and 200),
  status text not null default 'pending'
    check (status in ('pending', 'deleted', 'not_found', 'failed', 'not_applicable')),
  response_code int,
  attempts int not null default 0 check (attempts >= 0),
  attempted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (request_id, processor, external_ref)
);
create index if not exists processor_deletions_failed_idx on public.processor_deletions (attempted_at)
  where status in ('pending', 'failed');

alter table public.privacy_exports enable row level security;
alter table public.deletion_requests enable row level security;
alter table public.processor_deletions enable row level security;
revoke all on public.privacy_exports, public.deletion_requests, public.processor_deletions from anon, authenticated;
grant select, insert, update, delete on public.privacy_exports, public.deletion_requests, public.processor_deletions
  to service_role;

-- =====================================================================================================
-- erasure helpers (service role only; called inside the erasure transaction by lib/privacy/deletion.ts)
-- =====================================================================================================

-- The consent log stays append-only, except that an erasure strips its free text (the legal record of who
-- consented to what, when, and to which document version is kept).
create or replace function public.consent_records_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and current_setting('dnm.privacy_maintenance', true) = 'on'
     and (new.id, new.seq, new.child_id, new.feature, new.action, new.consent_document_id, new.method,
          new.guardian_user_id, new.guardian_link_id, new.attested_by, new.paper_relationship, new.paper_signed_on,
          new.paper_form_path, new.case_id, new.ip_hash, new.created_at)
         is not distinct from
         (old.id, old.seq, old.child_id, old.feature, old.action, old.consent_document_id, old.method,
          old.guardian_user_id, old.guardian_link_id, old.attested_by, old.paper_relationship, old.paper_signed_on,
          old.paper_form_path, old.case_id, old.ip_hash, old.created_at) then
    return new;
  end if;
  raise exception 'consent_records is append-only' using errcode = '42501';
end;
$$;

create or replace function public.privacy_redact_consent_records(p_child uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform set_config('dnm.privacy_maintenance', 'on', true);
  update public.consent_records
  set paper_note = null,
      user_agent = null,
      paper_guardian_name = case when paper_guardian_name is null then null else 'Redacted' end
  where child_id = p_child
    and (paper_note is not null or user_agent is not null
         or (paper_guardian_name is not null and paper_guardian_name <> 'Redacted'));
  get diagnostics n = row_count;
  perform set_config('dnm.privacy_maintenance', 'off', true);
  return n;
end;
$$;

-- FR-8: withdraw every feature that is currently granted (digital or paper), on behalf of the requesting
-- guardian (their link id, whatever its status now). Appends records; never rewrites. Returns the count.
create or replace function public.privacy_withdraw_consents(p_child uuid, p_user uuid, p_features text[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link uuid;
  r record;
  n integer := 0;
begin
  select id into v_link from public.guardian_links where child_id = p_child and user_id = p_user;
  if v_link is null then
    raise exception 'privacy:no_link';
  end if;
  for r in
    select s.feature from public.child_consent_state s
    where s.child_id = p_child and s.action = 'granted'
      and (p_features is null or s.feature = any(p_features))
  loop
    insert into public.consent_records (child_id, feature, action, consent_document_id, method,
                                        guardian_user_id, guardian_link_id, user_agent)
    values (p_child, r.feature, 'withdrawn',
            (select d.id from public.consent_documents d where d.feature = r.feature and d.locale = 'en'
             order by d.version desc limit 1),
            'digital', p_user, v_link, 'privacy:deletion_request');
    n := n + 1;
  end loop;
  -- 020 FR-9 side effects of withdrawing ai_intake_call / referral_share (whether or not they were granted).
  if p_features is null or 'ai_intake_call' = any(p_features) then
    update public.cases set intake_token_revoked_at = now()
    where child_id = p_child and intake_token is not null and intake_token_revoked_at is null;
  end if;
  if p_features is null or 'referral_share' = any(p_features) then
    update public.referrals set status = 'revoked'
    where status <> 'revoked' and case_id in (select id from public.cases where child_id = p_child);
  end if;
  return n;
end;
$$;

revoke all on function public.recordings_transcribed_at() from public, anon, authenticated;
revoke all on function public.privacy_redact_consent_records(uuid) from public, anon, authenticated;
revoke all on function public.privacy_withdraw_consents(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.privacy_redact_consent_records(uuid) to service_role;
grant execute on function public.privacy_withdraw_consents(uuid, uuid, text[]) to service_role;
