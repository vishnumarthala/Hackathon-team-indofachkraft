-- 020: children, guardian links and consent gating (design rules 1, 2 and 6).
-- Expand -> backfill -> enforce. Legacy cases get unclaimed `legacy_case` children: no guardian is inferred
-- from contact details and no consent is fabricated. Consent is versioned, per child and per feature, and
-- lives in an append-only log. All multi-step writes are security-definer functions (one transaction each,
-- strict audit: if the audit insert fails, nothing is written).

-- =====================================================================================================
-- expand
-- =====================================================================================================

create table if not exists public.children (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 60),
  date_of_birth date,
  sex text check (sex in ('female', 'male', 'other', 'undisclosed')),
  source text not null check (source in ('guardian', 'provider', 'legacy_case')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.guardian_links (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  relationship text not null check (relationship in ('mother', 'father', 'legal_guardian', 'other_family')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  verification_method text not null check (verification_method in ('self_registered', 'claim_code')),
  declared_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  unique (child_id, user_id)
);
create index if not exists guardian_links_user_idx on public.guardian_links (user_id) where status = 'active';

alter table public.cases add column if not exists child_id uuid references public.children(id);
alter table public.cases add column if not exists intake_token_expires_at timestamptz;
alter table public.cases add column if not exists intake_token_revoked_at timestamptz;
alter table public.referrals add column if not exists expires_at timestamptz;

create table if not exists public.consent_documents (
  id uuid primary key default gen_random_uuid(),
  feature text not null check (feature in (
    'ai_intake_call', 'session_recording', 'ai_transcription', 'ai_extraction',
    'ai_voice_note', 'referral_share', 'screen_result_save', 'ai_follow_up')),
  version int not null check (version >= 1),
  locale text not null check (locale in ('en', 'hi', 'te')),
  title text not null check (char_length(title) between 1 and 120),
  body_md text not null,
  processors jsonb not null default '[]'::jsonb check (jsonb_typeof(processors) = 'array'),
  published_at timestamptz not null default now(),
  unique (feature, version, locale)
);

create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  child_id uuid not null references public.children(id),
  feature text not null check (feature in (
    'ai_intake_call', 'session_recording', 'ai_transcription', 'ai_extraction',
    'ai_voice_note', 'referral_share', 'screen_result_save', 'ai_follow_up')),
  action text not null check (action in ('granted', 'withdrawn')),
  consent_document_id uuid references public.consent_documents(id),
  method text not null default 'digital' check (method in ('digital', 'paper')),
  guardian_user_id uuid,
  guardian_link_id uuid references public.guardian_links(id),
  attested_by uuid,
  paper_guardian_name text check (char_length(paper_guardian_name) between 1 and 100),
  paper_relationship text check (paper_relationship in ('mother', 'father', 'legal_guardian', 'other_family')),
  paper_signed_on date,
  paper_form_path text check (char_length(paper_form_path) between 1 and 300),
  paper_note text check (char_length(paper_note) <= 500),
  case_id uuid, -- provenance only (no FK: the log must survive case deletion)
  ip_hash text check (char_length(ip_hash) <= 128),
  user_agent text check (char_length(user_agent) <= 200),
  created_at timestamptz not null default now(),
  constraint consent_records_granted_document_check
    check (action <> 'granted' or consent_document_id is not null),
  constraint consent_records_method_fields_check check (
    (method = 'digital'
      and guardian_user_id is not null and guardian_link_id is not null
      and attested_by is null and paper_guardian_name is null and paper_form_path is null)
    or
    (method = 'paper'
      and guardian_user_id is null and guardian_link_id is null
      and attested_by is not null and paper_guardian_name is not null
      and (action = 'withdrawn' or (paper_relationship is not null and paper_signed_on is not null
                                    and paper_form_path is not null)))
  )
);
create index if not exists consent_records_child_idx on public.consent_records (child_id, feature, seq desc);

create table if not exists public.child_claim_codes (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists child_claim_codes_case_idx on public.child_claim_codes (case_id) where used_at is null;

-- FR-12 rate limit: failed claim attempts per user per hour.
create table if not exists public.child_claim_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists child_claim_attempts_user_idx on public.child_claim_attempts (user_id, created_at desc);

-- =====================================================================================================
-- backfill (idempotent: only cases without a child are touched)
-- =====================================================================================================

create or replace function public.backfill_case_children()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  new_child uuid;
  touched integer := 0;
begin
  for r in select id, child_alias, created_at from public.cases where child_id is null order by created_at for update loop
    insert into public.children (display_name, source, created_at)
    values (r.child_alias, 'legacy_case', r.created_at)
    returning id into new_child;
    update public.cases set child_id = new_child where id = r.id and child_id is null;
    touched := touched + 1;
  end loop;
  return touched;
end;
$$;
revoke all on function public.backfill_case_children() from public, anon, authenticated;

select public.backfill_case_children();

-- FR-6: existing links get a lifetime from now (intake 7 days, referral 30 days).
update public.cases
set intake_token_expires_at = now() + interval '7 days'
where intake_token is not null and intake_token_expires_at is null;

update public.referrals set expires_at = now() + interval '30 days' where expires_at is null;

-- =====================================================================================================
-- enforce
-- =====================================================================================================

alter table public.cases alter column child_id set not null;
create index if not exists cases_child_idx on public.cases (child_id);
alter table public.referrals alter column expires_at set default (now() + interval '30 days');
alter table public.referrals alter column expires_at set not null;

-- New cases created by providers without a child get an unclaimed `provider` child (rule 2: the child is
-- separate from the org-specific care episode). Never matched to a guardian by contact details.
create or replace function public.cases_assign_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.child_id is null then
    insert into public.children (display_name, source, created_by)
    values (new.child_alias, 'provider', new.created_by)
    returning id into new.child_id;
  end if;
  return new;
end;
$$;
revoke all on function public.cases_assign_child() from public, anon, authenticated;

drop trigger if exists cases_assign_child on public.cases;
create trigger cases_assign_child before insert on public.cases
for each row execute function public.cases_assign_child();

-- D-6: every intake token gets a 7-day lifetime unless the writer set one; a new token clears a revocation.
create or replace function public.cases_intake_token_lifetime()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.intake_token is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.intake_token_expires_at := coalesce(new.intake_token_expires_at, now() + interval '7 days');
  elsif new.intake_token is distinct from old.intake_token then
    if new.intake_token_expires_at is not distinct from old.intake_token_expires_at then
      new.intake_token_expires_at := now() + interval '7 days';
    end if;
    if new.intake_token_revoked_at is not distinct from old.intake_token_revoked_at then
      new.intake_token_revoked_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cases_intake_token_lifetime on public.cases;
create trigger cases_intake_token_lifetime before insert or update of intake_token on public.cases
for each row execute function public.cases_intake_token_lifetime();

-- FR-5: the consent log is append-only for every role (the trigger also stops the table owner).
create or replace function public.consent_records_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'consent_records is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists consent_records_no_update on public.consent_records;
create trigger consent_records_no_update before update or delete on public.consent_records
for each row execute function public.consent_records_append_only();
drop trigger if exists consent_records_no_truncate on public.consent_records;
create trigger consent_records_no_truncate before truncate on public.consent_records
for each statement execute function public.consent_records_append_only();

-- Current state = latest record per (child, feature). A digital grant counts only while the granting
-- guardian's link is active; a paper grant counts until withdrawn (FR-18a).
create or replace view public.child_consent_state
with (security_invoker = true) as
select distinct on (r.child_id, r.feature)
  r.child_id,
  r.feature,
  r.action,
  r.method,
  r.id as record_id,
  r.consent_document_id,
  r.guardian_user_id,
  r.guardian_link_id,
  r.attested_by,
  r.paper_guardian_name,
  r.paper_signed_on,
  r.case_id,
  r.created_at,
  (r.action = 'granted' and (r.method = 'paper' or gl.status = 'active')) as granted
from public.consent_records r
left join public.guardian_links gl on gl.id = r.guardian_link_id
order by r.child_id, r.feature, r.seq desc;

-- Private bucket for signed paper consent forms (FR-18a); read only through server-made signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('consent-forms', 'consent-forms', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- =====================================================================================================
-- RLS (NFR-2): guardians read their children's rows, org members read children of their cases.
-- No direct writes from anon/authenticated; the server writes through the functions below.
-- =====================================================================================================

create or replace function public.is_child_guardian(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.guardian_links
    where child_id = target and user_id = (select auth.uid()) and status = 'active'
  );
$$;

create or replace function public.can_read_child_via_org(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.cases c
    join public.org_members m on m.org_id = c.org_id
    where c.child_id = target and m.user_id = (select auth.uid()) and m.status = 'active'
  );
$$;

revoke all on function public.is_child_guardian(uuid) from public;
revoke all on function public.can_read_child_via_org(uuid) from public;
grant execute on function public.is_child_guardian(uuid) to authenticated;
grant execute on function public.can_read_child_via_org(uuid) to authenticated;

alter table public.children enable row level security;
alter table public.guardian_links enable row level security;
alter table public.consent_documents enable row level security;
alter table public.consent_records enable row level security;
alter table public.child_claim_codes enable row level security;
alter table public.child_claim_attempts enable row level security;

revoke all on public.children, public.guardian_links, public.consent_documents, public.consent_records,
  public.child_claim_codes, public.child_claim_attempts, public.child_consent_state from anon, authenticated;
revoke insert, update, delete, truncate on public.consent_records from service_role;
revoke insert, update, delete, truncate on public.consent_documents from service_role;

grant select on public.children, public.guardian_links, public.consent_records, public.child_claim_codes,
  public.child_consent_state to authenticated;
grant select on public.consent_documents to anon, authenticated;
grant select on public.consent_records, public.consent_documents, public.child_consent_state to service_role;

drop policy if exists "Guardians and care orgs read children" on public.children;
create policy "Guardians and care orgs read children" on public.children
for select to authenticated
using ((select public.is_child_guardian(id)) or (select public.can_read_child_via_org(id)));

drop policy if exists "Guardians read their links; care orgs see linked status" on public.guardian_links;
create policy "Guardians read their links; care orgs see linked status" on public.guardian_links
for select to authenticated
using (user_id = (select auth.uid()) or (select public.can_read_child_via_org(child_id)));

drop policy if exists "Published consent texts are public" on public.consent_documents;
create policy "Published consent texts are public" on public.consent_documents
for select to anon, authenticated using (true);

drop policy if exists "Guardians and care orgs read consent records" on public.consent_records;
create policy "Guardians and care orgs read consent records" on public.consent_records
for select to authenticated
using ((select public.is_child_guardian(child_id)) or (select public.can_read_child_via_org(child_id)));

drop policy if exists "Guardians and the case org read claim codes" on public.child_claim_codes;
create policy "Guardians and the case org read claim codes" on public.child_claim_codes
for select to authenticated
using (
  (select public.is_child_guardian(child_id))
  or exists (select 1 from public.cases c where c.id = case_id and (select public.is_org_member(c.org_id)))
);

-- =====================================================================================================
-- operations (service role only; each call is one transaction)
-- =====================================================================================================

-- FR-17 / FR-18c: one consent request = consent rows + side effects + audit row, all or nothing.
-- Errors are raised as 'consent:<code>' and mapped to HTTP statuses by lib/consent/records.ts.
create or replace function public.record_consent(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child uuid := (p ->> 'child_id')::uuid;
  v_action text := p ->> 'action';
  v_method text := coalesce(p ->> 'method', 'digital');
  v_features text[] := array(select jsonb_array_elements_text(coalesce(p -> 'features', '[]'::jsonb)));
  v_docs uuid[] := array(select (jsonb_array_elements_text(coalesce(p -> 'document_ids', '[]'::jsonb)))::uuid);
  v_locale text := coalesce(p ->> 'locale', 'en');
  v_user uuid := (p ->> 'guardian_user_id')::uuid;
  v_link uuid := (p ->> 'guardian_link_id')::uuid;
  v_attested uuid := (p ->> 'attested_by')::uuid;
  v_signed date := (p ->> 'paper_signed_on')::date;
  v_case uuid := (p ->> 'case_id')::uuid;
  v_feature text;
  v_doc uuid;
  v_doc_row public.consent_documents%rowtype;
  v_ids uuid[] := '{}';
  v_new uuid;
  v_audit_action text;
begin
  if v_action not in ('granted', 'withdrawn') or v_method not in ('digital', 'paper') then
    raise exception 'consent:invalid';
  end if;
  if coalesce(array_length(v_features, 1), 0) = 0 then
    raise exception 'consent:invalid';
  end if;
  perform 1 from public.children where id = v_child and deleted_at is null for update;
  if not found then
    raise exception 'consent:child_not_found';
  end if;

  if v_method = 'digital' then
    perform 1 from public.guardian_links
    where id = v_link and child_id = v_child and user_id = v_user and status = 'active'
    for share;
    if not found then
      raise exception 'consent:link_inactive';
    end if;
    if v_action = 'granted' and not exists (
      select 1 from public.user_profiles where id = v_user and phone_verified_at is not null
    ) then
      raise exception 'consent:phone_unverified';
    end if;
  else
    if v_attested is null then
      raise exception 'consent:invalid';
    end if;
    if v_signed is not null and v_signed > (now() at time zone 'Asia/Kolkata')::date then
      raise exception 'consent:future_date';
    end if;
  end if;

  foreach v_feature in array v_features loop
    v_doc := null;
    if v_action = 'granted' then
      select d.* into v_doc_row from public.consent_documents d
      where d.id = any(v_docs) and d.feature = v_feature
      order by d.version desc limit 1;
      if not found then
        raise exception 'consent:document_missing';
      end if;
      if v_doc_row.version < (
        select max(version) from public.consent_documents where feature = v_feature and locale = v_doc_row.locale
      ) then
        raise exception 'consent:outdated_document';
      end if;
      v_doc := v_doc_row.id;
    else
      select d.id into v_doc from public.consent_documents d
      where d.feature = v_feature and d.locale = v_locale
      order by d.version desc limit 1;
    end if;

    insert into public.consent_records (
      child_id, feature, action, consent_document_id, method, guardian_user_id, guardian_link_id, attested_by,
      paper_guardian_name, paper_relationship, paper_signed_on, paper_form_path, paper_note, case_id,
      ip_hash, user_agent
    ) values (
      v_child, v_feature, v_action, v_doc, v_method,
      case when v_method = 'digital' then v_user end,
      case when v_method = 'digital' then v_link end,
      case when v_method = 'paper' then v_attested end,
      case when v_method = 'paper' then p ->> 'paper_guardian_name' end,
      case when v_method = 'paper' then p ->> 'paper_relationship' end,
      case when v_method = 'paper' then v_signed end,
      case when v_method = 'paper' then p ->> 'paper_form_path' end,
      case when v_method = 'paper' then p ->> 'paper_note' end,
      v_case, p ->> 'ip_hash', left(p ->> 'user_agent', 200)
    ) returning id into v_new;
    v_ids := v_ids || v_new;

    -- FR-9: withdrawing closes the doors that feature opened (already-processed records stay; 041 deletes).
    if v_action = 'withdrawn' and v_feature = 'ai_intake_call' then
      update public.cases set intake_token_revoked_at = now()
      where child_id = v_child and intake_token is not null and intake_token_revoked_at is null;
    elsif v_action = 'withdrawn' and v_feature = 'referral_share' then
      update public.referrals set status = 'revoked'
      where status <> 'revoked' and case_id in (select id from public.cases where child_id = v_child);
    end if;
  end loop;

  v_audit_action := case
    when v_action = 'granted' and v_method = 'paper' then 'consent.paper_recorded'
    when v_action = 'granted' then 'consent.granted'
    else 'consent.withdrawn'
  end;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (
    case when v_case is not null and exists (select 1 from public.cases where id = v_case) then v_case end,
    case when v_method = 'paper' then 'therapist' else 'parent' end,
    coalesce(v_user, v_attested),
    v_audit_action,
    'child',
    v_child::text,
    jsonb_build_object('child_id', v_child, 'features', to_jsonb(v_features), 'method', v_method,
                       'record_ids', to_jsonb(v_ids), 'document_ids', to_jsonb(v_docs))
  );

  return jsonb_build_object('child_id', v_child, 'record_ids', to_jsonb(v_ids));
end;
$$;

-- FR-11: a guardian adds a child (child + active self-registered link + audit, one transaction).
create or replace function public.create_guardian_child(
  p_user uuid, p_display_name text, p_dob date, p_sex text, p_relationship text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child uuid;
begin
  insert into public.children (display_name, date_of_birth, sex, source, created_by)
  values (p_display_name, p_dob, p_sex, 'guardian', p_user)
  returning id into v_child;
  insert into public.guardian_links (child_id, user_id, relationship, status, verification_method, declared_at)
  values (v_child, p_user, p_relationship, 'active', 'self_registered', now());
  insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, details)
  values ('parent', p_user, 'child.created', 'child', v_child::text, jsonb_build_object('relationship', p_relationship));
  return v_child;
end;
$$;

-- FR-12: a new code for a case invalidates the case's older unused codes.
create or replace function public.create_child_claim_code(p_case uuid, p_hash text, p_created_by uuid, p_ttl interval)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child uuid;
  v_id uuid;
  v_expires timestamptz := now() + p_ttl;
begin
  select child_id into v_child from public.cases where id = p_case for update;
  if not found then
    raise exception 'consent:case_not_found';
  end if;
  update public.child_claim_codes set expires_at = now()
  where case_id = p_case and used_at is null and expires_at > now();
  insert into public.child_claim_codes (child_id, case_id, code_hash, expires_at, created_by)
  values (v_child, p_case, p_hash, v_expires, p_created_by)
  returning id into v_id;
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (p_case, 'therapist', p_created_by, 'child.claim_code_created', 'child', v_child::text,
          jsonb_build_object('code_id', v_id, 'expires_at', v_expires));
  return jsonb_build_object('id', v_id, 'child_id', v_child, 'expires_at', v_expires);
end;
$$;

-- FR-12: claim with a code. Results: claimed | invalid | rate_limited | conflict | not_your_child.
-- 5 failed attempts per user per hour -> rate_limited (checked before the code, so guessing stops).
create or replace function public.claim_child(
  p_hash text, p_user uuid, p_relationship text, p_existing_child uuid, p_max_failures int default 5
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.child_claim_codes%rowtype;
  v_case public.cases%rowtype;
  v_target uuid;
  v_merged boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('claim_child:' || p_user::text));
  if (select count(*) from public.child_claim_attempts
      where user_id = p_user and not succeeded and created_at > now() - interval '1 hour') >= p_max_failures then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  select * into v_code from public.child_claim_codes where code_hash = p_hash for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= now() then
    insert into public.child_claim_attempts (user_id, succeeded) values (p_user, false);
    return jsonb_build_object('result', 'invalid');
  end if;
  select * into v_case from public.cases where id = v_code.case_id for update;
  if not found then
    insert into public.child_claim_attempts (user_id, succeeded) values (p_user, false);
    return jsonb_build_object('result', 'invalid');
  end if;

  v_target := v_case.child_id;
  if p_existing_child is not null and p_existing_child <> v_case.child_id then
    if not exists (
      select 1 from public.guardian_links gl join public.children ch on ch.id = gl.child_id
      where gl.child_id = p_existing_child and gl.user_id = p_user and gl.status = 'active' and ch.deleted_at is null
    ) then
      return jsonb_build_object('result', 'not_your_child');
    end if;
    -- The placeholder may only be merged when nothing else hangs off it.
    if exists (select 1 from public.cases where child_id = v_case.child_id and id <> v_case.id)
       or exists (select 1 from public.guardian_links where child_id = v_case.child_id)
       or exists (select 1 from public.consent_records where child_id = v_case.child_id) then
      return jsonb_build_object('result', 'conflict');
    end if;
    update public.cases set child_id = p_existing_child where id = v_case.id;
    update public.child_claim_codes set child_id = p_existing_child where case_id = v_case.id;
    update public.children set deleted_at = now() where id = v_case.child_id and deleted_at is null;
    v_target := p_existing_child;
    v_merged := true;
  else
    insert into public.guardian_links (child_id, user_id, relationship, status, verification_method, declared_at)
    values (v_target, p_user, p_relationship, 'active', 'claim_code', now())
    on conflict (child_id, user_id) do update
      set status = 'active', revoked_at = null, revoked_by = null, relationship = excluded.relationship,
          verification_method = 'claim_code', declared_at = excluded.declared_at;
  end if;

  update public.child_claim_codes set used_at = now(), used_by = p_user where id = v_code.id;
  insert into public.child_claim_attempts (user_id, succeeded) values (p_user, true);
  insert into public.audit_events (case_id, actor, actor_user_id, action, entity, entity_id, details)
  values (v_case.id, 'parent', p_user, 'child.claimed', 'child', v_target::text,
          jsonb_build_object('code_id', v_code.id, 'merged', v_merged, 'placeholder_child_id',
                             case when v_merged then v_case.child_id end));
  return jsonb_build_object('result', 'claimed', 'child_id', v_target, 'case_id', v_case.id, 'merged', v_merged);
end;
$$;

revoke all on function public.record_consent(jsonb) from public, anon, authenticated;
revoke all on function public.create_guardian_child(uuid, text, date, text, text) from public, anon, authenticated;
revoke all on function public.create_child_claim_code(uuid, text, uuid, interval) from public, anon, authenticated;
revoke all on function public.claim_child(text, uuid, text, uuid, int) from public, anon, authenticated;
grant execute on function public.record_consent(jsonb) to service_role;
grant execute on function public.create_guardian_child(uuid, text, date, text, text) to service_role;
grant execute on function public.create_child_claim_code(uuid, text, uuid, interval) to service_role;
grant execute on function public.claim_child(text, uuid, text, uuid, int) to service_role;

-- =====================================================================================================
-- consent texts v1 (FR-4). Draft copy, flagged for legal review (plan section 6) before the real pilot.
-- =====================================================================================================

insert into public.consent_documents (feature, version, locale, title, body_md, processors) values
-- ai_intake_call
('ai_intake_call', 1, 'en', 'AI intake voice call',
$t$Before the first session, an AI voice assistant can talk with you about your child's development. The call is recorded and turned into text, and AI prepares a short summary for your child's therapist. The therapist checks everything. This is not a diagnosis.

**What is shared:** your answers in the call and your child's first name and age.

You can withdraw this permission at any time in the DoctorNearMe app or by telling the centre. Withdrawing stops new processing and cancels open call links; it does not delete records already made (ask the centre to delete them).$t$,
'[{"name":"ElevenLabs","purpose":"voice call and transcription","location":"USA"},{"name":"Google Gemini","purpose":"AI summary of the call","location":"outside India"}]'),
('ai_intake_call', 1, 'hi', 'एआई इनटेक वॉइस कॉल',
$t$पहले सत्र से पहले, एक एआई वॉइस सहायक आपसे आपके बच्चे के विकास के बारे में बात कर सकता है। कॉल रिकॉर्ड होती है और लिखित पाठ में बदली जाती है, और एआई आपके बच्चे के थेरेपिस्ट के लिए एक छोटा सारांश तैयार करता है। थेरेपिस्ट सब कुछ जाँचते हैं। यह निदान नहीं है।

**क्या साझा होता है:** कॉल में आपके जवाब और आपके बच्चे का पहला नाम और उम्र।

आप यह अनुमति कभी भी DoctorNearMe ऐप में या केंद्र को बताकर वापस ले सकते हैं। अनुमति वापस लेने से नई प्रोसेसिंग रुक जाती है और खुले कॉल लिंक रद्द हो जाते हैं; पहले से बने रिकॉर्ड नहीं मिटते (उन्हें मिटाने के लिए केंद्र से कहें)।$t$,
'[{"name":"ElevenLabs","purpose":"वॉइस कॉल और ट्रांसक्रिप्शन","location":"अमेरिका"},{"name":"Google Gemini","purpose":"कॉल का एआई सारांश","location":"भारत के बाहर"}]'),
('ai_intake_call', 1, 'te', 'AI ఇన్‌టేక్ వాయిస్ కాల్',
$t$మొదటి సెషన్‌కు ముందు, ఒక AI వాయిస్ అసిస్టెంట్ మీ బిడ్డ ఎదుగుదల గురించి మీతో మాట్లాడవచ్చు. కాల్ రికార్డ్ చేయబడి రాతగా మార్చబడుతుంది, మరియు AI మీ బిడ్డ థెరపిస్ట్ కోసం ఒక చిన్న సారాంశం తయారు చేస్తుంది. థెరపిస్ట్ అన్నీ తనిఖీ చేస్తారు. ఇది నిర్ధారణ కాదు.

**ఏమి పంచుకోబడుతుంది:** కాల్‌లో మీ సమాధానాలు, మీ బిడ్డ మొదటి పేరు మరియు వయస్సు.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో లేదా కేంద్రానికి చెప్పి ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త ప్రాసెసింగ్ ఆగిపోతుంది మరియు తెరిచి ఉన్న కాల్ లింక్‌లు రద్దవుతాయి; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు (తొలగించమని కేంద్రాన్ని అడగండి).$t$,
'[{"name":"ElevenLabs","purpose":"వాయిస్ కాల్ మరియు ట్రాన్స్‌క్రిప్షన్","location":"అమెరికా"},{"name":"Google Gemini","purpose":"కాల్ యొక్క AI సారాంశం","location":"భారతదేశం వెలుపల"}]'),
-- session_recording
('session_recording', 1, 'en', 'Recording therapy sessions',
$t$Your child's therapist may record the audio of a session at the centre so that observations are documented accurately. Recordings are stored securely and are available only to your child's care team at that centre.

You can withdraw this permission at any time in the DoctorNearMe app or by telling the centre. Withdrawing stops new recordings and deletes recordings that were not processed yet; it does not delete records already made (ask the centre to delete them).$t$,
'[{"name":"Supabase","purpose":"secure storage of recordings","location":"DoctorNearMe hosting region (see privacy policy)"}]'),
('session_recording', 1, 'hi', 'थेरेपी सत्रों की रिकॉर्डिंग',
$t$आपके बच्चे के थेरेपिस्ट केंद्र में सत्र की आवाज़ रिकॉर्ड कर सकते हैं ताकि अवलोकन सही ढंग से लिखे जा सकें। रिकॉर्डिंग सुरक्षित रूप से रखी जाती हैं और केवल उस केंद्र में आपके बच्चे की देखभाल टीम देख सकती है।

आप यह अनुमति कभी भी DoctorNearMe ऐप में या केंद्र को बताकर वापस ले सकते हैं। अनुमति वापस लेने से नई रिकॉर्डिंग रुक जाती है और जो रिकॉर्डिंग अभी प्रोसेस नहीं हुईं वे मिटा दी जाती हैं; पहले से बने रिकॉर्ड नहीं मिटते (उन्हें मिटाने के लिए केंद्र से कहें)।$t$,
'[{"name":"Supabase","purpose":"रिकॉर्डिंग का सुरक्षित भंडारण","location":"DoctorNearMe का होस्टिंग क्षेत्र (गोपनीयता नीति देखें)"}]'),
('session_recording', 1, 'te', 'థెరపీ సెషన్‌ల రికార్డింగ్',
$t$పరిశీలనలు సరిగ్గా నమోదు కావడానికి మీ బిడ్డ థెరపిస్ట్ కేంద్రంలో సెషన్ ఆడియోను రికార్డ్ చేయవచ్చు. రికార్డింగ్‌లు సురక్షితంగా భద్రపరచబడతాయి మరియు ఆ కేంద్రంలోని మీ బిడ్డ సంరక్షణ బృందానికి మాత్రమే అందుబాటులో ఉంటాయి.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో లేదా కేంద్రానికి చెప్పి ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త రికార్డింగ్‌లు ఆగిపోతాయి మరియు ఇంకా ప్రాసెస్ కాని రికార్డింగ్‌లు తొలగించబడతాయి; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు (తొలగించమని కేంద్రాన్ని అడగండి).$t$,
'[{"name":"Supabase","purpose":"రికార్డింగ్‌ల సురక్షిత నిల్వ","location":"DoctorNearMe హోస్టింగ్ ప్రాంతం (గోప్యతా విధానం చూడండి)"}]'),
-- ai_transcription
('ai_transcription', 1, 'en', 'AI transcription of recordings',
$t$Session recordings can be turned into written text by an AI speech-to-text service, so the therapist does not have to type notes during the session. The therapist reviews the text.

You can withdraw this permission at any time in the DoctorNearMe app or by telling the centre. Withdrawing stops new processing; it does not delete records already made (ask the centre to delete them).$t$,
'[{"name":"ElevenLabs","purpose":"speech to text","location":"USA"}]'),
('ai_transcription', 1, 'hi', 'रिकॉर्डिंग का एआई ट्रांसक्रिप्शन',
$t$सत्र की रिकॉर्डिंग को एक एआई स्पीच-टू-टेक्स्ट सेवा लिखित पाठ में बदल सकती है, ताकि थेरेपिस्ट को सत्र के दौरान नोट्स टाइप न करने पड़ें। थेरेपिस्ट पाठ की जाँच करते हैं।

आप यह अनुमति कभी भी DoctorNearMe ऐप में या केंद्र को बताकर वापस ले सकते हैं। अनुमति वापस लेने से नई प्रोसेसिंग रुक जाती है; पहले से बने रिकॉर्ड नहीं मिटते (उन्हें मिटाने के लिए केंद्र से कहें)।$t$,
'[{"name":"ElevenLabs","purpose":"आवाज़ से पाठ","location":"अमेरिका"}]'),
('ai_transcription', 1, 'te', 'రికార్డింగ్‌ల AI ట్రాన్స్‌క్రిప్షన్',
$t$సెషన్ రికార్డింగ్‌లను ఒక AI స్పీచ్-టు-టెక్స్ట్ సేవ రాతగా మార్చగలదు, కాబట్టి థెరపిస్ట్ సెషన్ సమయంలో నోట్స్ టైప్ చేయాల్సిన అవసరం ఉండదు. థెరపిస్ట్ ఆ రాతను సమీక్షిస్తారు.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో లేదా కేంద్రానికి చెప్పి ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త ప్రాసెసింగ్ ఆగిపోతుంది; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు (తొలగించమని కేంద్రాన్ని అడగండి).$t$,
'[{"name":"ElevenLabs","purpose":"మాట నుండి రాత","location":"అమెరికా"}]'),
-- ai_extraction
('ai_extraction', 1, 'en', 'AI analysis of transcripts',
$t$AI can read the session transcript and the intake answers, suggest observations for the developmental check (ISAA) and draft a report. Every suggestion links to the moment it came from, and the therapist confirms or changes it. This is not a diagnosis by AI.

You can withdraw this permission at any time in the DoctorNearMe app or by telling the centre. Withdrawing stops new processing; it does not delete records already made (ask the centre to delete them).$t$,
'[{"name":"Google Gemini","purpose":"AI analysis and report drafting","location":"outside India"}]'),
('ai_extraction', 1, 'hi', 'ट्रांसक्रिप्ट का एआई विश्लेषण',
$t$एआई सत्र का ट्रांसक्रिप्ट और इनटेक के जवाब पढ़कर विकास जाँच (ISAA) के लिए अवलोकन सुझा सकता है और रिपोर्ट का मसौदा बना सकता है। हर सुझाव उस पल से जुड़ा होता है जहाँ से वह आया, और थेरेपिस्ट उसकी पुष्टि करते हैं या उसे बदलते हैं। यह एआई द्वारा निदान नहीं है।

आप यह अनुमति कभी भी DoctorNearMe ऐप में या केंद्र को बताकर वापस ले सकते हैं। अनुमति वापस लेने से नई प्रोसेसिंग रुक जाती है; पहले से बने रिकॉर्ड नहीं मिटते (उन्हें मिटाने के लिए केंद्र से कहें)।$t$,
'[{"name":"Google Gemini","purpose":"एआई विश्लेषण और रिपोर्ट का मसौदा","location":"भारत के बाहर"}]'),
('ai_extraction', 1, 'te', 'ట్రాన్స్‌క్రిప్ట్‌ల AI విశ్లేషణ',
$t$AI సెషన్ ట్రాన్స్‌క్రిప్ట్ మరియు ఇన్‌టేక్ సమాధానాలను చదివి, ఎదుగుదల పరిశీలన (ISAA) కోసం పరిశీలనలను సూచించి, నివేదిక ముసాయిదాను తయారు చేయగలదు. ప్రతి సూచన అది వచ్చిన క్షణానికి లింక్ చేయబడుతుంది, మరియు థెరపిస్ట్ దాన్ని ధృవీకరిస్తారు లేదా మారుస్తారు. ఇది AI చేసే నిర్ధారణ కాదు.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో లేదా కేంద్రానికి చెప్పి ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త ప్రాసెసింగ్ ఆగిపోతుంది; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు (తొలగించమని కేంద్రాన్ని అడగండి).$t$,
'[{"name":"Google Gemini","purpose":"AI విశ్లేషణ మరియు నివేదిక ముసాయిదా","location":"భారతదేశం వెలుపల"}]'),
-- ai_voice_note
('ai_voice_note', 1, 'en', 'AI voice summary for parents',
$t$When the assessment report is final, AI can write a short summary in your language and read it aloud. The audio and text are sent to you by email.

You can withdraw this permission at any time in the DoctorNearMe app or by telling the centre. Withdrawing stops new processing; it does not delete records already made (ask the centre to delete them).$t$,
'[{"name":"Google Gemini","purpose":"writes the summary","location":"outside India"},{"name":"ElevenLabs","purpose":"reads the summary aloud","location":"USA"},{"name":"Resend","purpose":"email delivery","location":"USA"}]'),
('ai_voice_note', 1, 'hi', 'माता-पिता के लिए एआई वॉइस सारांश',
$t$जब मूल्यांकन रिपोर्ट अंतिम हो जाती है, तो एआई आपकी भाषा में एक छोटा सारांश लिखकर उसे पढ़कर सुना सकता है। ऑडियो और पाठ आपको ईमेल से भेजे जाते हैं।

आप यह अनुमति कभी भी DoctorNearMe ऐप में या केंद्र को बताकर वापस ले सकते हैं। अनुमति वापस लेने से नई प्रोसेसिंग रुक जाती है; पहले से बने रिकॉर्ड नहीं मिटते (उन्हें मिटाने के लिए केंद्र से कहें)।$t$,
'[{"name":"Google Gemini","purpose":"सारांश लिखता है","location":"भारत के बाहर"},{"name":"ElevenLabs","purpose":"सारांश पढ़कर सुनाता है","location":"अमेरिका"},{"name":"Resend","purpose":"ईमेल भेजना","location":"अमेरिका"}]'),
('ai_voice_note', 1, 'te', 'తల్లిదండ్రుల కోసం AI వాయిస్ సారాంశం',
$t$అంచనా నివేదిక తుది రూపం పొందిన తర్వాత, AI మీ భాషలో ఒక చిన్న సారాంశం రాసి దాన్ని చదివి వినిపించగలదు. ఆడియో మరియు రాత మీకు ఈమెయిల్ ద్వారా పంపబడతాయి.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో లేదా కేంద్రానికి చెప్పి ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త ప్రాసెసింగ్ ఆగిపోతుంది; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు (తొలగించమని కేంద్రాన్ని అడగండి).$t$,
'[{"name":"Google Gemini","purpose":"సారాంశం రాస్తుంది","location":"భారతదేశం వెలుపల"},{"name":"ElevenLabs","purpose":"సారాంశాన్ని చదివి వినిపిస్తుంది","location":"అమెరికా"},{"name":"Resend","purpose":"ఈమెయిల్ పంపడం","location":"అమెరికా"}]'),
-- referral_share
('referral_share', 1, 'en', 'Sharing with a specialist',
$t$Your child's therapist can share a referral packet (confirmed observations, short recorded moments and an AI summary) with a specialist through a private link that expires after 30 days. The specialist can ask questions that AI answers only from this packet.

You can withdraw this permission at any time in the DoctorNearMe app or by telling the centre. Withdrawing closes every shared link for your child; it does not delete records already made (ask the centre to delete them).$t$,
'[{"name":"Google Gemini","purpose":"referral summary and answers to the specialist","location":"outside India"},{"name":"Resend","purpose":"email delivery","location":"USA"}]'),
('referral_share', 1, 'hi', 'विशेषज्ञ के साथ साझा करना',
$t$आपके बच्चे के थेरेपिस्ट एक निजी लिंक से, जो 30 दिन बाद समाप्त हो जाता है, किसी विशेषज्ञ के साथ रेफ़रल पैकेट (पुष्टि किए गए अवलोकन, छोटे रिकॉर्ड किए गए पल और एक एआई सारांश) साझा कर सकते हैं। विशेषज्ञ सवाल पूछ सकते हैं जिनका जवाब एआई केवल इसी पैकेट से देता है।

आप यह अनुमति कभी भी DoctorNearMe ऐप में या केंद्र को बताकर वापस ले सकते हैं। अनुमति वापस लेने से आपके बच्चे के सभी साझा लिंक बंद हो जाते हैं; पहले से बने रिकॉर्ड नहीं मिटते (उन्हें मिटाने के लिए केंद्र से कहें)।$t$,
'[{"name":"Google Gemini","purpose":"रेफ़रल सारांश और विशेषज्ञ के सवालों के जवाब","location":"भारत के बाहर"},{"name":"Resend","purpose":"ईमेल भेजना","location":"अमेरिका"}]'),
('referral_share', 1, 'te', 'నిపుణుడితో పంచుకోవడం',
$t$మీ బిడ్డ థెరపిస్ట్ 30 రోజుల తర్వాత గడువు ముగిసే ఒక ప్రైవేట్ లింక్ ద్వారా ఒక నిపుణుడితో రెఫరల్ ప్యాకెట్‌ను (ధృవీకరించిన పరిశీలనలు, చిన్న రికార్డ్ చేసిన క్షణాలు మరియు ఒక AI సారాంశం) పంచుకోవచ్చు. నిపుణుడు ప్రశ్నలు అడగవచ్చు, వాటికి AI ఈ ప్యాకెట్ నుండి మాత్రమే సమాధానం ఇస్తుంది.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో లేదా కేంద్రానికి చెప్పి ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే మీ బిడ్డ యొక్క అన్ని పంచుకున్న లింక్‌లు మూసివేయబడతాయి; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు (తొలగించమని కేంద్రాన్ని అడగండి).$t$,
'[{"name":"Google Gemini","purpose":"రెఫరల్ సారాంశం మరియు నిపుణుడి ప్రశ్నలకు సమాధానాలు","location":"భారతదేశం వెలుపల"},{"name":"Resend","purpose":"ఈమెయిల్ పంపడం","location":"అమెరికా"}]'),
-- screen_result_save
('screen_result_save', 1, 'en', 'Saving a check-in result',
$t$If you complete a developmental check-in on DoctorNearMe, the result can be saved to your child's record so that a professional you choose can see it. The check-in is not a diagnosis.

You can withdraw this permission at any time in the DoctorNearMe app. Withdrawing stops new results being saved; it does not delete results already saved.$t$,
'[{"name":"Supabase","purpose":"secure storage of the result","location":"DoctorNearMe hosting region (see privacy policy)"}]'),
('screen_result_save', 1, 'hi', 'चेक-इन का परिणाम सहेजना',
$t$अगर आप DoctorNearMe पर विकास चेक-इन पूरा करते हैं, तो उसका परिणाम आपके बच्चे के रिकॉर्ड में सहेजा जा सकता है ताकि आपके चुने हुए विशेषज्ञ उसे देख सकें। चेक-इन निदान नहीं है।

आप यह अनुमति कभी भी DoctorNearMe ऐप में वापस ले सकते हैं। अनुमति वापस लेने से नए परिणाम सहेजे नहीं जाते; पहले से सहेजे परिणाम नहीं मिटते।$t$,
'[{"name":"Supabase","purpose":"परिणाम का सुरक्षित भंडारण","location":"DoctorNearMe का होस्टिंग क्षेत्र (गोपनीयता नीति देखें)"}]'),
('screen_result_save', 1, 'te', 'చెక్-ఇన్ ఫలితాన్ని సేవ్ చేయడం',
$t$మీరు DoctorNearMe లో ఎదుగుదల చెక్-ఇన్ పూర్తి చేస్తే, మీరు ఎంచుకున్న నిపుణుడు చూడగలిగేలా ఫలితం మీ బిడ్డ రికార్డులో సేవ్ చేయబడవచ్చు. చెక్-ఇన్ నిర్ధారణ కాదు.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త ఫలితాలు సేవ్ కావు; ఇప్పటికే సేవ్ అయిన ఫలితాలు తొలగించబడవు.$t$,
'[{"name":"Supabase","purpose":"ఫలితం యొక్క సురక్షిత నిల్వ","location":"DoctorNearMe హోస్టింగ్ ప్రాంతం (గోప్యతా విధానం చూడండి)"}]'),
-- ai_follow_up
('ai_follow_up', 1, 'en', 'AI follow-up assistant',
$t$An AI assistant can answer your questions about your child's published plan, report or prescription, using only those documents, and can ask you follow-up questions about progress. It does not replace your child's clinician.

You can withdraw this permission at any time in the DoctorNearMe app. Withdrawing stops new processing; it does not delete records already made.$t$,
'[{"name":"Google Gemini","purpose":"answers and follow-up questions","location":"outside India"},{"name":"ElevenLabs","purpose":"voice conversation","location":"USA"}]'),
('ai_follow_up', 1, 'hi', 'एआई फ़ॉलो-अप सहायक',
$t$एक एआई सहायक केवल आपके बच्चे की प्रकाशित योजना, रिपोर्ट या पर्चे के आधार पर आपके सवालों के जवाब दे सकता है और प्रगति के बारे में आगे के सवाल पूछ सकता है। यह आपके बच्चे के डॉक्टर या थेरेपिस्ट की जगह नहीं लेता।

आप यह अनुमति कभी भी DoctorNearMe ऐप में वापस ले सकते हैं। अनुमति वापस लेने से नई प्रोसेसिंग रुक जाती है; पहले से बने रिकॉर्ड नहीं मिटते।$t$,
'[{"name":"Google Gemini","purpose":"जवाब और आगे के सवाल","location":"भारत के बाहर"},{"name":"ElevenLabs","purpose":"आवाज़ में बातचीत","location":"अमेरिका"}]'),
('ai_follow_up', 1, 'te', 'AI ఫాలో-అప్ అసిస్టెంట్',
$t$ఒక AI అసిస్టెంట్ మీ బిడ్డ ప్రచురించిన ప్రణాళిక, నివేదిక లేదా ప్రిస్క్రిప్షన్ ఆధారంగా మాత్రమే మీ ప్రశ్నలకు సమాధానం ఇవ్వగలదు మరియు పురోగతి గురించి తదుపరి ప్రశ్నలు అడగగలదు. ఇది మీ బిడ్డ వైద్యుడు లేదా థెరపిస్ట్‌కు ప్రత్యామ్నాయం కాదు.

మీరు ఈ అనుమతిని ఎప్పుడైనా DoctorNearMe యాప్‌లో ఉపసంహరించుకోవచ్చు. ఉపసంహరించుకుంటే కొత్త ప్రాసెసింగ్ ఆగిపోతుంది; ఇప్పటికే ఉన్న రికార్డులు తొలగించబడవు.$t$,
'[{"name":"Google Gemini","purpose":"సమాధానాలు మరియు తదుపరి ప్రశ్నలు","location":"భారతదేశం వెలుపల"},{"name":"ElevenLabs","purpose":"వాయిస్ సంభాషణ","location":"అమెరికా"}]')
on conflict (feature, version, locale) do nothing;
