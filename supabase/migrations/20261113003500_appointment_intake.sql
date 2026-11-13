-- 035: appointment-scoped pre-consult intake (design rules 6 and 11).
-- A confirmed appointment selects or creates its organisation's case for the child and assigns the provider
-- (`appointment_link_case`, idempotent by appointment). Services with an intake kind get one appointment-bound
-- intake attempt (`appointment_issue_intake`): only the SHA-256 of the link token is stored, the link expires at the
-- appointment start, is revoked when the appointment is cancelled or consent is withdrawn and moves with a
-- reschedule. Recordings and briefs carry the appointment. Additive only (expand; legacy rows keep null).

-- ---------------------------------------------------------------------------------------------------------
-- 1. recordings / reports: appointment scope, generic brief kind

-- 038 adds recordings.appointment_id without an FK (appointments did not exist on its branch). This migration sorts
-- before 038's, so it adds the column itself when missing (038 uses `add column if not exists`) and drops dangling
-- ids before adding the FK.
alter table public.recordings add column if not exists appointment_id uuid;
create index if not exists recordings_appointment_idx on public.recordings (appointment_id) where appointment_id is not null;
update public.recordings r set appointment_id = null
where r.appointment_id is not null and not exists (select 1 from public.appointments a where a.id = r.appointment_id);
alter table public.recordings drop constraint if exists recordings_appointment_id_fkey;
alter table public.recordings
  add constraint recordings_appointment_id_fkey foreign key (appointment_id) references public.appointments(id) on delete set null;

alter table public.reports add column if not exists appointment_id uuid references public.appointments(id) on delete set null;
create index if not exists reports_appointment_idx on public.reports (appointment_id) where appointment_id is not null;

-- reports.kind gets `generic_intake_brief` (024 reserved it). The step extends whatever list the check holds right now
-- instead of restating it, so kinds added by other tickets survive. A fresh `db reset` runs 038's migration (which
-- restates the list) after this one, so 20261113013500_appointment_intake_report_kind.sql repeats the same step after
-- every 00:xx migration (results.md, Deviations). Generic intake recordings keep the default template and are told
-- apart through their intake attempt (lib/queries/intake.ts).
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

-- ---------------------------------------------------------------------------------------------------------
-- 2. intake attempts

create table if not exists public.intake_attempts (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  -- sha256 (hex) of the 43-character link token; the token itself is never stored (lib/intake/attempts.ts).
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  agent_kind text not null check (agent_kind in ('child_dev', 'generic')),
  status text not null default 'issued' check (status in ('issued', 'started', 'completed', 'expired', 'revoked')),
  expires_at timestamptz not null,
  conversation_id text unique check (char_length(conversation_id) between 1 and 200),
  started_at timestamptz,
  completed_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('appointment_cancelled', 'appointment_expired', 'appointment_no_show', 'consent_withdrawn')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_attempts_completed check (status <> 'completed' or (conversation_id is not null and completed_at is not null)),
  constraint intake_attempts_revoked check (status <> 'revoked' or revoked_at is not null)
);
-- One active attempt per appointment (out of scope: several attempts at once).
create unique index if not exists intake_attempts_active_uq
  on public.intake_attempts (appointment_id) where status in ('issued', 'started');
create index if not exists intake_attempts_appointment_idx on public.intake_attempts (appointment_id, created_at desc);
create index if not exists intake_attempts_case_idx on public.intake_attempts (case_id);

comment on table public.intake_attempts is
  '035: appointment-bound pre-consult intake links (hash only). Completed attempts point at their ElevenLabs conversation.';

alter table public.intake_attempts enable row level security;
revoke all on public.intake_attempts from anon, authenticated;
grant select on public.intake_attempts to authenticated;
grant select, insert, update, delete on public.intake_attempts to service_role;
drop policy if exists "Care team reads intake attempts" on public.intake_attempts;
create policy "Care team reads intake attempts" on public.intake_attempts
  for select to authenticated using (public.can_access_case(case_id));

-- ---------------------------------------------------------------------------------------------------------
-- 3. appointment -> case (FR-2, rule 11). Idempotent by appointment: re-running returns the linked case.

create or replace function public.appointment_link_case(p_appointment uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_child public.children;
  v_provider_user uuid;
  v_provider_name text;
  v_case uuid;
  v_created boolean := false;
  v_member boolean := false;
  v_assigned text := 'skipped';
  v_guardian_name text;
  v_locale text;
begin
  select * into a from public.appointments where id = p_appointment for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if a.status not in ('confirmed', 'completed') or a.child_id is null then
    return jsonb_build_object('result', 'not_applicable', 'case_id', a.case_id);
  end if;

  select p.user_id, p.display_name into v_provider_user, v_provider_name
  from public.provider_profiles p where p.id = a.provider_profile_id;
  v_member := v_provider_user is not null and exists (
    select 1 from public.org_members m where m.org_id = a.org_id and m.user_id = v_provider_user and m.status = 'active'
  );

  v_case := a.case_id;
  if v_case is null then
    -- One case per (org, child): serialise concurrent links of different appointments of the same child.
    perform pg_advisory_xact_lock(hashtextextended('appointment_case:' || a.org_id || ':' || a.child_id, 0));
    -- Cases have no closed state yet: every case of the child in this org is open; the newest wins.
    select c.id into v_case from public.cases c
    where c.org_id = a.org_id and c.child_id = a.child_id
    order by c.created_at desc limit 1;
    if v_case is null then
      select * into v_child from public.children where id = a.child_id;
      select left(nullif(btrim(u.display_name), ''), 60), u.preferred_locale into v_guardian_name, v_locale
      from public.user_profiles u where u.id = a.guardian_user_id;
      insert into public.cases (org_id, child_id, child_alias, parent_alias, language, therapist_name, created_by, status)
      values (
        a.org_id, a.child_id, left(coalesce(nullif(btrim(v_child.display_name), ''), 'Child'), 60),
        coalesce(v_guardian_name, 'Parent'),
        case when v_locale in ('en', 'hi', 'te') then v_locale else 'en' end,
        left(coalesce(a.service_snapshot ->> 'provider_name', v_provider_name, 'Provider'), 120),
        -- The provider (an active member) becomes the lead through 022's cases_assign_care_team trigger.
        case when v_member then v_provider_user end,
        'booked'
      ) returning id into v_case;
      v_created := true;
    end if;
    update public.appointments set case_id = v_case, updated_at = now() where id = a.id;
  end if;

  -- 022: the appointment's provider joins the care team (lead when the case has none).
  if v_member then
    if exists (select 1 from public.case_assignments where case_id = v_case and user_id = v_provider_user and removed_at is null) then
      v_assigned := 'existing';
    else
      insert into public.case_assignments (case_id, user_id, care_role)
      values (v_case, v_provider_user, case when exists (
        select 1 from public.case_assignments where case_id = v_case and care_role = 'lead' and removed_at is null
      ) then 'member' else 'lead' end);
      v_assigned := 'added';
    end if;
  end if;

  if a.case_id is null then
    insert into public.audit_events (case_id, actor, action, entity, entity_id, details)
    values (v_case, 'system', 'appointment.case_linked', 'appointment', a.id::text,
            jsonb_build_object('appointment_id', a.id, 'case_created', v_created, 'provider_assignment', v_assigned));
  end if;
  return jsonb_build_object('result', case when a.case_id is null then 'linked' else 'existing' end,
                            'case_id', v_case, 'case_created', v_created, 'provider_assignment', v_assigned);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. intake attempt (FR-3). The caller (lib/intake/attempts.ts) proposes the id and the token hash (the token is an
-- HMAC of the id, so it can be re-derived for the guardian without being stored). Results:
--   issued | existing (the active attempt) | completed | consent_needed | not_applicable | not_found

create or replace function public.appointment_issue_intake(p_appointment uuid, p_attempt uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
  v_kind text;
  v_existing public.intake_attempts;
  v_consent boolean;
begin
  select * into a from public.appointments where id = p_appointment for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  v_kind := coalesce(a.service_snapshot ->> 'intake_kind', 'none');
  if v_kind not in ('child_dev', 'generic') or a.status <> 'confirmed' or a.case_id is null or a.child_id is null
     or lower(a.slot) <= now() then
    return jsonb_build_object('result', 'not_applicable', 'agent_kind', v_kind);
  end if;

  select * into v_existing from public.intake_attempts
  where appointment_id = a.id and status in ('issued', 'started') order by created_at desc limit 1;
  if found then
    if v_existing.expires_at > now() then
      return jsonb_build_object('result', 'existing', 'attempt_id', v_existing.id, 'agent_kind', v_existing.agent_kind);
    end if;
    update public.intake_attempts set status = 'expired', updated_at = now() where id = v_existing.id;
  end if;
  if exists (select 1 from public.intake_attempts where appointment_id = a.id and status = 'completed') then
    return jsonb_build_object('result', 'completed', 'agent_kind', v_kind);
  end if;

  -- 020: the link is only issued with ai_intake_call consent (re-checked again at start and completion).
  select coalesce(s.granted, false) and c.deleted_at is null into v_consent
  from public.children c
  left join public.child_consent_state s on s.child_id = c.id and s.feature = 'ai_intake_call'
  where c.id = a.child_id;
  if not coalesce(v_consent, false) then
    return jsonb_build_object('result', 'consent_needed', 'agent_kind', v_kind);
  end if;

  insert into public.intake_attempts (id, appointment_id, case_id, token_hash, agent_kind, status, expires_at)
  values (p_attempt, a.id, a.case_id, p_token_hash, v_kind, 'issued', lower(a.slot));
  insert into public.audit_events (case_id, actor, action, entity, entity_id, details)
  values (a.case_id, 'system', 'intake.attempt_issued', 'intake_attempt', p_attempt::text,
          jsonb_build_object('appointment_id', a.id, 'agent_kind', v_kind, 'expires_at', lower(a.slot)));
  return jsonb_build_object('result', 'issued', 'attempt_id', p_attempt, 'agent_kind', v_kind);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. lifecycle (FR-4): cancelling revokes the link, rescheduling moves it, consent withdrawal revokes it.

create or replace function public.appointments_intake_status_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.status in ('cancelled', 'expired', 'no_show')
     and not (new.status = 'cancelled' and coalesce(new.cancel_reason, '') = 'rescheduled') then
    update public.intake_attempts
    set status = 'revoked', revoked_at = now(), updated_at = now(),
        revoked_reason = case new.status when 'cancelled' then 'appointment_cancelled'
                                         when 'expired' then 'appointment_expired' else 'appointment_no_show' end
    where appointment_id = new.id and status in ('issued', 'started');
  end if;
  return null;
end;
$$;

drop trigger if exists appointments_intake_status_changed on public.appointments;
create trigger appointments_intake_status_changed after update of status on public.appointments
for each row execute function public.appointments_intake_status_changed();

-- booking_reschedule cancels the old appointment (reason `rescheduled`) and inserts the new one in the same
-- sub-transaction: the active attempt follows, with the new start as its expiry (the token does not change).
create or replace function public.appointments_intake_rescheduled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.rescheduled_from is not null then
    update public.intake_attempts
    set appointment_id = new.id, expires_at = lower(new.slot), updated_at = now()
    where appointment_id = new.rescheduled_from and status in ('issued', 'started');
  end if;
  return null;
end;
$$;

drop trigger if exists appointments_intake_rescheduled on public.appointments;
create trigger appointments_intake_rescheduled after insert on public.appointments
for each row execute function public.appointments_intake_rescheduled();

-- 020 FR-9 for appointment links, plus the `consent.granted` consumer event (lib/notify/consumers.ts) when a grant
-- can issue a link for an upcoming appointment.
create or replace function public.consent_records_appointment_intake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.feature <> 'ai_intake_call' then
    return null;
  end if;
  if new.action = 'withdrawn' then
    update public.intake_attempts
    set status = 'revoked', revoked_at = now(), revoked_reason = 'consent_withdrawn', updated_at = now()
    where status in ('issued', 'started') and case_id in (select id from public.cases where child_id = new.child_id);
  elsif exists (
    select 1 from public.appointments a
    where a.child_id = new.child_id and a.status = 'confirmed' and lower(a.slot) > now()
      and coalesce(a.service_snapshot ->> 'intake_kind', 'none') in ('child_dev', 'generic')
      and not exists (select 1 from public.intake_attempts t
                      where t.appointment_id = a.id and t.status in ('issued', 'started', 'completed'))
  ) then
    perform public.outbox_enqueue('consent.granted', 'child', new.child_id,
      jsonb_build_object('child_id', new.child_id, 'feature', new.feature), 'consent:' || new.id || ':granted', now());
  end if;
  return null;
end;
$$;

drop trigger if exists consent_records_appointment_intake on public.consent_records;
create trigger consent_records_appointment_intake after insert on public.consent_records
for each row execute function public.consent_records_appointment_intake();

-- ---------------------------------------------------------------------------------------------------------
-- 6. grants: the server (service role) only

revoke all on function public.appointment_link_case(uuid) from public, anon, authenticated;
revoke all on function public.appointment_issue_intake(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.appointments_intake_status_changed() from public, anon, authenticated;
revoke all on function public.appointments_intake_rescheduled() from public, anon, authenticated;
revoke all on function public.consent_records_appointment_intake() from public, anon, authenticated;
grant execute on function public.appointment_link_case(uuid) to service_role;
grant execute on function public.appointment_issue_intake(uuid, uuid, text) to service_role;
