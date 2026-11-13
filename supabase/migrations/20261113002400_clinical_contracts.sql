-- Ticket 024 Part 1: shared clinical contracts (design rules 8 and 9 of specs/grill/doctornearme-mvp.md).
-- 1. clinical_instruments: the instrument registry (ISAA first). facts.instrument becomes a foreign key to it
--    (expand: FK `not valid` -> validate -> drop the old check). Definitions mirror schemas/*.json
--    (tests/clinical-contracts.test.ts fails when they drift).
-- 2. published_versions: the one authoritative, append-only published representation of a clinical document
--    (reports now; IEP plans, home programs, prescriptions and assessments later). `content_md` is authoritative;
--    `reports.content` (jsonb) is only the AI draft input. `publish_version(jsonb)` is the only writer.
-- 3. A final report publishes itself in the same transaction (trigger), and every existing final report is
--    backfilled with version 1. No change to the ISAA extraction/scoring/report behaviour.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Instrument registry

create table if not exists public.clinical_instruments (
  key text primary key check (key ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  version text not null check (char_length(version) between 1 and 20),
  kind text not null check (kind in ('provider_rated', 'guardian_questionnaire', 'case_sheet')),
  title text not null check (char_length(title) between 1 and 120),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.clinical_instruments is
  '024: instrument registry. definition mirrors schemas/<instrument>.json; lib/clinical/instruments.ts is the typed view.';

insert into public.clinical_instruments (key, version, kind, title, definition) values
  ('ISAA', '1', 'provider_rated', 'Indian Scale for Assessment of Autism (ISAA)', $json${"instrument":"ISAA","scale":[{"value":1,"label":"Rarely","range":"up to 20%"},{"value":2,"label":"Sometimes","range":"21-40%"},{"value":3,"label":"Frequently","range":"41-60%"},{"value":4,"label":"Mostly","range":"61-80%"},{"value":5,"label":"Always","range":"81-100%"}],"domains":[{"id":"social","name":"Social relationship and reciprocity","items":[1,2,3,4,5,6,7,8,9]},{"id":"emotional","name":"Emotional responsiveness","items":[10,11,12,13,14]},{"id":"speech","name":"Speech-language and communication","items":[15,16,17,18,19,20,21,22,23]},{"id":"behaviour","name":"Behaviour patterns","items":[24,25,26,27,28,29,30]},{"id":"sensory","name":"Sensory aspects","items":[31,32,33,34,35,36]},{"id":"cognitive","name":"Cognitive component","items":[37,38,39,40]}],"items":[{"id":1,"domain":"social","text":"Has poor eye contact"},{"id":2,"domain":"social","text":"Lacks social smile"},{"id":3,"domain":"social","text":"Remains aloof"},{"id":4,"domain":"social","text":"Does not reach out to others"},{"id":5,"domain":"social","text":"Unable to relate to people"},{"id":6,"domain":"social","text":"Unable to respond to social/environmental cues"},{"id":7,"domain":"social","text":"Engages in solitary and repetitive play activities"},{"id":8,"domain":"social","text":"Unable to take turns in social interaction"},{"id":9,"domain":"social","text":"Does not maintain peer relationships"},{"id":10,"domain":"emotional","text":"Shows inappropriate emotional response"},{"id":11,"domain":"emotional","text":"Shows exaggerated emotions"},{"id":12,"domain":"emotional","text":"Engages in self-stimulating emotions"},{"id":13,"domain":"emotional","text":"Lacks fear of danger"},{"id":14,"domain":"emotional","text":"Gets excited or agitated for no apparent reason"},{"id":15,"domain":"speech","text":"Acquired speech and lost it"},{"id":16,"domain":"speech","text":"Has difficulty in using non-verbal language or gestures to communicate"},{"id":17,"domain":"speech","text":"Engages in stereotyped and repetitive use of language"},{"id":18,"domain":"speech","text":"Engages in echolalic speech"},{"id":19,"domain":"speech","text":"Produces infantile squeals/unusual noises"},{"id":20,"domain":"speech","text":"Unable to initiate or sustain conversation with others"},{"id":21,"domain":"speech","text":"Uses jargon or meaningless words"},{"id":22,"domain":"speech","text":"Uses pronoun reversals"},{"id":23,"domain":"speech","text":"Unable to grasp the pragmatics of communication (real meaning)"},{"id":24,"domain":"behaviour","text":"Engages in stereotyped and repetitive motor mannerisms"},{"id":25,"domain":"behaviour","text":"Shows attachment to inanimate objects"},{"id":26,"domain":"behaviour","text":"Shows hyperactivity/restlessness"},{"id":27,"domain":"behaviour","text":"Exhibits aggressive behaviour"},{"id":28,"domain":"behaviour","text":"Throws temper tantrums"},{"id":29,"domain":"behaviour","text":"Engages in self-injurious behaviour"},{"id":30,"domain":"behaviour","text":"Insists on sameness"},{"id":31,"domain":"sensory","text":"Unusually sensitive to sensory stimuli"},{"id":32,"domain":"sensory","text":"Stares into space for long periods of time"},{"id":33,"domain":"sensory","text":"Has difficulty in tracking objects"},{"id":34,"domain":"sensory","text":"Has unusual vision"},{"id":35,"domain":"sensory","text":"Insensitive to pain"},{"id":36,"domain":"sensory","text":"Responds to objects/people unusually by smelling, touching or tasting"},{"id":37,"domain":"cognitive","text":"Inconsistent attention and concentration"},{"id":38,"domain":"cognitive","text":"Shows delay in responding"},{"id":39,"domain":"cognitive","text":"Has unusual memory of some kind"},{"id":40,"domain":"cognitive","text":"Has 'savant' ability"}],"bands":[{"id":"no_autism","min":40,"max":69,"label":"Below cut-off (under 70)"},{"id":"mild","min":70,"max":106,"label":"Mild (70-106)"},{"id":"moderate","min":107,"max":153,"label":"Moderate (107-153)"},{"id":"severe","min":154,"max":200,"label":"Severe (154-200)"}],"red_flag_items":{"15":"lost_speech","29":"self_injury"}}$json$::jsonb),
  ('CASE_SHEET', '1', 'case_sheet', 'Intake case sheet', $json${"fields":[{"id":"consent_given","type":"boolean","label":"Consent given","description":"Parent agreed to talk to an AI assistant and to recording"},{"id":"child_age_months","type":"integer","label":"Age (months)","description":"Child's age in months"},{"id":"main_concern","type":"string","label":"Main concern","description":"Parent's main concern in their own words"},{"id":"speech_status","type":"string","label":"Speech now","description":"Current words/sentences the child uses"},{"id":"lost_speech","type":"boolean","label":"Lost speech","description":"Child had words or skills and lost them"},{"id":"lost_speech_details","type":"string","label":"When speech was lost","description":"When and what was lost"},{"id":"eye_contact","type":"string","label":"Eye contact","description":"How the child looks at people"},{"id":"response_to_name","type":"string","label":"Response to name","description":"Whether the child turns when called"},{"id":"play_and_peers","type":"string","label":"Play and other children","description":"How the child plays, alone or with others"},{"id":"repetitive_behaviours","type":"string","label":"Repetitive behaviours","description":"Lining up, hand flapping, repeated phrases"},{"id":"sensory","type":"string","label":"Sensory reactions","description":"Reactions to sounds, textures, lights"},{"id":"self_injury","type":"boolean","label":"Self-injury","description":"Child hurts themself (head hitting, biting)"},{"id":"routines_and_tantrums","type":"string","label":"Routines and tantrums","description":"Reactions to changes in routine"},{"id":"sleep_and_eating","type":"string","label":"Sleep and eating","description":"Sleep and eating patterns"},{"id":"family_history","type":"string","label":"Family history","description":"Relevant family history the parent mentions"}]}$json$::jsonb),
  ('ISAA_PARENT_CHECKIN', '1', 'guardian_questionnaire', 'Parent developmental check-in', $json${"instrument":"ISAA_PARENT_CHECKIN","version":"1","title":"Parent developmental check-in","status":"draft_pending_clinical_review","derived_from":"ISAA","disclaimer":"This is a developmental check-in, not a diagnosis.","answer_scale":["never","sometimes","often","always"],"answer_labels":{"never":"Never","sometimes":"Sometimes","often":"Often","always":"Always"},"age_bands":[{"id":"18-35m","min_months":18,"max_months":35},{"id":"36-71m","min_months":36,"max_months":71},{"id":"72-215m","min_months":72,"max_months":215}],"domains":[{"id":"social","name":"Social relationship and reciprocity"},{"id":"emotional","name":"Emotional responsiveness"},{"id":"speech","name":"Speech-language and communication"},{"id":"behaviour","name":"Behaviour patterns"},{"id":"sensory","name":"Sensory aspects"},{"id":"cognitive","name":"Cognitive component"}],"questions":[{"id":"q1","domain":"social","text_en":"Does your child look at your face or eyes when you talk or play together?","answer_scale":["never","sometimes","often","always"],"reverse":true,"isaa_items":[1],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q2","domain":"social","text_en":"Does your child smile back when you smile at them?","answer_scale":["never","sometimes","often","always"],"reverse":true,"isaa_items":[2],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q3","domain":"social","text_en":"Does your child prefer to play alone, even when other children are around?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[3,7,9],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q4","domain":"emotional","text_en":"Does your child get very upset or very excited for no clear reason?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[10,11,14],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q5","domain":"emotional","text_en":"Does your child seem unaware of danger, for example running towards traffic?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[13],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q6","domain":"speech","text_en":"Does your child point or use gestures to show you what they want?","answer_scale":["never","sometimes","often","always"],"reverse":true,"isaa_items":[16],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q7","domain":"speech","text_en":"Does your child repeat words or phrases they heard instead of answering you?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[17,18],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q8","domain":"speech","text_en":"Does your child take turns with you in simple back-and-forth talk, sounds or games?","answer_scale":["never","sometimes","often","always"],"reverse":true,"isaa_items":[8,20],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q9","domain":"behaviour","text_en":"Does your child flap their hands, rock, spin or repeat the same body movements?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[24],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q10","domain":"behaviour","text_en":"Does your child get very upset when a routine or something around them changes?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[30],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q11","domain":"behaviour","text_en":"Does your child have strong tantrums or hit other people?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[27,28],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q12","domain":"sensory","text_en":"Does your child cover their ears or get upset with everyday sounds, lights or touch?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[31],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q13","domain":"sensory","text_en":"Does your child smell, lick or touch objects or people in an unusual way?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[36],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q14","domain":"cognitive","text_en":"Does your child find it hard to stay with one activity for a few minutes?","answer_scale":["never","sometimes","often","always"],"reverse":false,"isaa_items":[37],"age_bands":["18-35m","36-71m","72-215m"]},{"id":"q15","domain":"cognitive","text_en":"Does your child turn to look at you when you call their name?","answer_scale":["never","sometimes","often","always"],"reverse":true,"isaa_items":[6,38],"age_bands":["18-35m","36-71m","72-215m"]}],"red_flag_answer_scale":["no","yes"],"red_flags":[{"id":"rf_skill_regression","code":"skill_regression","text_en":"Has your child stopped using words or skills that they used to have?"},{"id":"rf_self_injury","code":"self_injury","text_en":"Does your child hurt themselves on purpose, for example by hitting their head or biting themselves?"},{"id":"rf_seizure","code":"seizure","text_en":"Has your child had a fit (seizure), or episodes of jerking movements or not responding?"},{"id":"rf_breathing","code":"breathing","text_en":"Does your child have trouble breathing, or turn blue around the lips?"},{"id":"rf_not_eating_drinking","code":"not_eating_drinking","text_en":"Has your child stopped eating or drinking, or are they losing weight?"},{"id":"rf_safety_concern","code":"safety_concern","text_en":"Are you worried about your child's safety right now, or that someone may be hurting them?"}],"scoring":{"points":{"never":0,"sometimes":1,"often":2,"always":3},"reverse_points":{"never":3,"sometimes":2,"often":1,"always":0},"max_total":45,"bands":[{"id":"no_strong_signs","min":0,"max":9},{"id":"discuss_with_professional","min":10,"max":19},{"id":"see_professional_soon","min":20,"max":45}],"any_red_flag_band":"see_professional_soon"},"result_copy":{"no_strong_signs":"Your answers do not show strong signs of a developmental concern right now. If you are still worried, talk to your child's doctor or therapist. This is a developmental check-in, not a diagnosis.","discuss_with_professional":"Some of your answers suggest it would help to talk about your child's development with a professional. This is a developmental check-in, not a diagnosis.","see_professional_soon":"Your answers suggest your child should see a developmental professional soon. This is a developmental check-in, not a diagnosis."},"urgent_copy":"Please contact your child's doctor now. In an emergency call 108 (ambulance) or 112."}$json$::jsonb)
on conflict (key) do update
  set version = excluded.version, kind = excluded.kind, title = excluded.title,
      definition = excluded.definition, updated_at = now();

-- facts.instrument: check constraint ('ISAA','CASE_SHEET') -> foreign key to the registry.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'facts_instrument_fkey' and conrelid = 'public.facts'::regclass
  ) then
    alter table public.facts
      add constraint facts_instrument_fkey foreign key (instrument)
      references public.clinical_instruments(key) not valid;
  end if;
end $$;
alter table public.facts validate constraint facts_instrument_fkey;
alter table public.facts drop constraint if exists facts_instrument_check;

alter table public.clinical_instruments enable row level security;
revoke all on public.clinical_instruments from anon, authenticated;
grant select on public.clinical_instruments to anon, authenticated;
drop policy if exists "Instrument definitions are public" on public.clinical_instruments;
create policy "Instrument definitions are public" on public.clinical_instruments
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------------------------------------
-- 2. Published versions (rule 9)

comment on column public.reports.content is
  '024: AI draft input only (structured model output). The authoritative text is content_md; once final it is published to published_versions.';

create table if not exists public.published_versions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('report', 'iep_plan', 'home_program', 'prescription', 'assessment')),
  entity_id uuid not null,
  version int not null check (version >= 1),
  child_id uuid not null references public.children(id),
  -- Removed only together with its case (data deletion, ticket 041); see the append-only trigger below.
  case_id uuid references public.cases(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  content_md text not null check (char_length(btrim(content_md)) between 1 and 200000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  visible_to_guardian boolean not null default false,
  published_by uuid, -- provenance only (no FK: the row must not change when an account is deleted)
  published_at timestamptz not null default now(),
  unique (entity_type, entity_id, version)
);
create index if not exists published_versions_child_idx on public.published_versions (child_id, entity_type, org_id);
create index if not exists published_versions_case_idx on public.published_versions (case_id);

comment on table public.published_versions is
  '024: append-only published clinical documents. content_md is authoritative; content_hash = sha256(content_md). Written only by publish_version().';

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

drop trigger if exists published_versions_no_update on public.published_versions;
create trigger published_versions_no_update before update or delete on public.published_versions
for each row execute function public.published_versions_append_only();
drop trigger if exists published_versions_no_truncate on public.published_versions;
create trigger published_versions_no_truncate before truncate on public.published_versions
for each statement execute function public.published_versions_append_only();

-- The only writer. Input: { entity_type, entity_id, content_md, visible_to_guardian?, case_id?, child_id?,
-- org_id?, published_by? }. With a case, child and org come from (and must match) the case. published_by
-- defaults to the transaction setting app.actor_user_id. Versions are 1, 2, 3, ... per entity (serialised by
-- an advisory lock). Returns the new row.
create or replace function public.publish_version(p jsonb)
returns public.published_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := p->>'entity_type';
  v_entity uuid := nullif(p->>'entity_id', '')::uuid;
  v_case uuid := nullif(p->>'case_id', '')::uuid;
  v_child uuid := nullif(p->>'child_id', '')::uuid;
  v_org uuid := nullif(p->>'org_id', '')::uuid;
  v_md text := p->>'content_md';
  v_visible boolean := coalesce((p->>'visible_to_guardian')::boolean, false);
  v_by uuid := coalesce(nullif(p->>'published_by', '')::uuid, nullif(current_setting('app.actor_user_id', true), '')::uuid);
  v_case_org uuid;
  v_case_child uuid;
  v_version int;
  v_row public.published_versions;
begin
  if v_type is null or v_entity is null then
    raise exception 'entity_type and entity_id are required' using errcode = '22023';
  end if;
  if v_md is null or btrim(v_md) = '' then
    raise exception 'content_md is required' using errcode = '22023';
  end if;
  if v_case is not null then
    select c.org_id, c.child_id into v_case_org, v_case_child from public.cases c where c.id = v_case;
    if not found then
      raise exception 'case not found' using errcode = '23503';
    end if;
    if (v_org is not null and v_org <> v_case_org) or (v_child is not null and v_child <> v_case_child) then
      raise exception 'org_id/child_id do not match the case' using errcode = '22023';
    end if;
    v_org := v_case_org;
    v_child := v_case_child;
  end if;
  if v_child is null or v_org is null then
    raise exception 'child_id and org_id are required without a case' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('published_versions:' || v_type || ':' || v_entity::text, 0));
  select coalesce(max(pv.version), 0) + 1 into v_version
  from public.published_versions pv where pv.entity_type = v_type and pv.entity_id = v_entity;

  insert into public.published_versions
    (entity_type, entity_id, version, child_id, case_id, org_id, content_md, content_hash, visible_to_guardian, published_by)
  values
    (v_type, v_entity, v_version, v_child, v_case, v_org, v_md, encode(sha256(convert_to(v_md, 'UTF8')), 'hex'),
     v_visible, v_by)
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.publish_version(jsonb) from public, anon, authenticated;
grant execute on function public.publish_version(jsonb) to service_role;

-- Case-bound rows follow their case's current child (see the append-only trigger). 024's assessments
-- migration extends this function to assessments.
create or replace function public.cases_child_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.published_versions set child_id = new.child_id
  where case_id = new.id and child_id is distinct from new.child_id;
  return null;
end;
$$;
revoke all on function public.cases_child_follow() from public, anon, authenticated;

drop trigger if exists cases_child_follow on public.cases;
create trigger cases_child_follow after update of child_id on public.cases
for each row when (old.child_id is distinct from new.child_id) execute function public.cases_child_follow();

-- ---------------------------------------------------------------------------------------------------------
-- 3. Reports publish when they become final (same transaction as the status change)

-- Guardian visibility default per report kind (lib/clinical/reports.ts REPORT_KINDS[kind].audience):
-- parent_summary -> visible; assessment and pre_session_brief -> provider only.
create or replace function public.reports_publish_final()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'final'
     and (tg_op = 'INSERT' or old.status is distinct from 'final' or old.content_md is distinct from new.content_md) then
    perform public.publish_version(jsonb_build_object(
      'entity_type', 'report',
      'entity_id', new.id,
      'case_id', new.case_id,
      'content_md', new.content_md,
      'visible_to_guardian', new.kind = 'parent_summary'
    ));
  end if;
  return null;
end;
$$;
revoke all on function public.reports_publish_final() from public, anon, authenticated;

drop trigger if exists reports_publish_final on public.reports;
create trigger reports_publish_final after insert or update of status, content_md on public.reports
for each row execute function public.reports_publish_final();

-- Backfill: one published version for every existing final report. Idempotent (reports that already have a
-- version are skipped); returns the number of reports published.
create or replace function public.backfill_published_reports()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select rep.id, rep.case_id, rep.kind, rep.content_md
    from public.reports rep
    where rep.status = 'final'
      and not exists (
        select 1 from public.published_versions pv where pv.entity_type = 'report' and pv.entity_id = rep.id
      )
    order by rep.updated_at, rep.id
  loop
    perform public.publish_version(jsonb_build_object(
      'entity_type', 'report', 'entity_id', r.id, 'case_id', r.case_id, 'content_md', r.content_md,
      'visible_to_guardian', r.kind = 'parent_summary'
    ));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.backfill_published_reports() from public, anon, authenticated;
grant execute on function public.backfill_published_reports() to service_role;

select public.backfill_published_reports();

-- RLS (browser reads only; the server uses the service role and lib/authz.ts gates).
alter table public.published_versions enable row level security;
revoke all on public.published_versions from anon, authenticated;
revoke insert, update, delete, truncate on public.published_versions from service_role;
grant select on public.published_versions to authenticated, service_role;

drop policy if exists "Guardians read versions shared with them" on public.published_versions;
create policy "Guardians read versions shared with them" on public.published_versions
  for select to authenticated using (visible_to_guardian and public.is_child_guardian(child_id));
drop policy if exists "Care team reads published versions" on public.published_versions;
create policy "Care team reads published versions" on public.published_versions
  for select to authenticated using (case_id is not null and public.can_access_case(case_id));
