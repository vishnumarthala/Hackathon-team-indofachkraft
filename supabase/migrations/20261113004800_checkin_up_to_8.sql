-- Ticket 048: parent check-in for children up to 8.
--
-- 1. Instrument registry (024): M-CHAT-R/F (`MCHAT_RF`) is registered with the published scoring and the optional
--    Follow-Up. Its item wording is a PLACEHOLDER until the licence for commercial digital use is confirmed; the app
--    only uses it when MCHAT_LICENSED=true. New column `licence_ref` holds the licence reference of a licensed
--    instrument (null = no licence recorded; ISAA-derived and in-house instruments need none).
-- 2. screen_sessions (033): new age bands `18-30m`, `31-71m`, `6-8y` (the old bands stay valid so stored check-ins
--    keep their values, FR-1), the instrument used (fixed at the start, so flipping the flag never changes an open
--    check-in), and the parent's worries (`concerns`, codes only, FR-5 / rule 6). Expand only: both new columns have
--    constant defaults, so existing rows are backfilled by the add itself.
-- 3. screen_answers_valid(): also accepts M-CHAT-R/F items (`mchat_N`: yes/no) and Follow-Up items (`mchatfu_N`:
--    pass/fail). Still no free text.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Registry

alter table public.clinical_instruments
  add column if not exists licence_ref text check (licence_ref is null or char_length(licence_ref) between 1 and 300);

comment on column public.clinical_instruments.licence_ref is
  '048: licence reference (agreement id / letter date) for a licensed third-party instrument; null = none recorded.';

insert into public.clinical_instruments (key, version, kind, title, definition, licence_ref) values
  ('MCHAT_RF', '1', 'guardian_questionnaire', 'M-CHAT-R/F (Modified Checklist for Autism in Toddlers, Revised, with Follow-Up)', $json${"instrument":"MCHAT_RF","version":"1","title":"M-CHAT-R/F (Modified Checklist for Autism in Toddlers, Revised, with Follow-Up)","status":"placeholder_text_pending_licence","licence":{"status":"unverified","reference":null,"copyright":"(c) 2009 Diana Robins, Deborah Fein and Marianne Barton","contact":"https://mchatscreen.com","note":"Free for clinical, research and educational use; use in a commercial digital product needs written permission from the authors. Keep MCHAT_LICENSED=false and the placeholder item text until the licence reference is recorded here and in clinical_instruments.licence_ref. Use only official translations."},"age_months":{"min":16,"max":30},"answer_scale":["yes","no"],"items":[{"id":"mchat_1","number":1,"text_en":"[Placeholder] M-CHAT-R/F item 1: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_2","number":2,"text_en":"[Placeholder] M-CHAT-R/F item 2: the licensed English wording is added here once the licence is confirmed.","risk_answer":"yes"},{"id":"mchat_3","number":3,"text_en":"[Placeholder] M-CHAT-R/F item 3: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_4","number":4,"text_en":"[Placeholder] M-CHAT-R/F item 4: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_5","number":5,"text_en":"[Placeholder] M-CHAT-R/F item 5: the licensed English wording is added here once the licence is confirmed.","risk_answer":"yes"},{"id":"mchat_6","number":6,"text_en":"[Placeholder] M-CHAT-R/F item 6: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_7","number":7,"text_en":"[Placeholder] M-CHAT-R/F item 7: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_8","number":8,"text_en":"[Placeholder] M-CHAT-R/F item 8: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_9","number":9,"text_en":"[Placeholder] M-CHAT-R/F item 9: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_10","number":10,"text_en":"[Placeholder] M-CHAT-R/F item 10: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_11","number":11,"text_en":"[Placeholder] M-CHAT-R/F item 11: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_12","number":12,"text_en":"[Placeholder] M-CHAT-R/F item 12: the licensed English wording is added here once the licence is confirmed.","risk_answer":"yes"},{"id":"mchat_13","number":13,"text_en":"[Placeholder] M-CHAT-R/F item 13: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_14","number":14,"text_en":"[Placeholder] M-CHAT-R/F item 14: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_15","number":15,"text_en":"[Placeholder] M-CHAT-R/F item 15: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_16","number":16,"text_en":"[Placeholder] M-CHAT-R/F item 16: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_17","number":17,"text_en":"[Placeholder] M-CHAT-R/F item 17: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_18","number":18,"text_en":"[Placeholder] M-CHAT-R/F item 18: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_19","number":19,"text_en":"[Placeholder] M-CHAT-R/F item 19: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"},{"id":"mchat_20","number":20,"text_en":"[Placeholder] M-CHAT-R/F item 20: the licensed English wording is added here once the licence is confirmed.","risk_answer":"no"}],"scoring":{"rule":"One point per item answered with its risk answer: 'yes' for items 2, 5 and 12, 'no' for all other items.","max_total":20,"bands":[{"id":"low","min":0,"max":2},{"id":"moderate","min":3,"max":7},{"id":"high","min":8,"max":20}],"follow_up_for":"moderate","rescreen_under_months":24},"follow_up":{"optional":true,"administered_for":"moderate","description":"Only the items that scored a point are followed up. An item still showing the concern after its follow-up questions counts as a fail.","answer_scale":["pass","fail"],"items":[{"id":"mchatfu_1","item":"mchat_1","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 1: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 1 remain after the follow-up questions?"},{"id":"mchatfu_2","item":"mchat_2","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 2: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 2 remain after the follow-up questions?"},{"id":"mchatfu_3","item":"mchat_3","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 3: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 3 remain after the follow-up questions?"},{"id":"mchatfu_4","item":"mchat_4","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 4: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 4 remain after the follow-up questions?"},{"id":"mchatfu_5","item":"mchat_5","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 5: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 5 remain after the follow-up questions?"},{"id":"mchatfu_6","item":"mchat_6","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 6: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 6 remain after the follow-up questions?"},{"id":"mchatfu_7","item":"mchat_7","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 7: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 7 remain after the follow-up questions?"},{"id":"mchatfu_8","item":"mchat_8","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 8: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 8 remain after the follow-up questions?"},{"id":"mchatfu_9","item":"mchat_9","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 9: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 9 remain after the follow-up questions?"},{"id":"mchatfu_10","item":"mchat_10","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 10: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 10 remain after the follow-up questions?"},{"id":"mchatfu_11","item":"mchat_11","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 11: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 11 remain after the follow-up questions?"},{"id":"mchatfu_12","item":"mchat_12","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 12: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 12 remain after the follow-up questions?"},{"id":"mchatfu_13","item":"mchat_13","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 13: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 13 remain after the follow-up questions?"},{"id":"mchatfu_14","item":"mchat_14","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 14: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 14 remain after the follow-up questions?"},{"id":"mchatfu_15","item":"mchat_15","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 15: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 15 remain after the follow-up questions?"},{"id":"mchatfu_16","item":"mchat_16","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 16: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 16 remain after the follow-up questions?"},{"id":"mchatfu_17","item":"mchat_17","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 17: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 17 remain after the follow-up questions?"},{"id":"mchatfu_18","item":"mchat_18","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 18: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 18 remain after the follow-up questions?"},{"id":"mchatfu_19","item":"mchat_19","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 19: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 19 remain after the follow-up questions?"},{"id":"mchatfu_20","item":"mchat_20","text_en":"[Placeholder] M-CHAT-R/F Follow-Up for item 20: the licensed interview steps are added here once the licence is confirmed. Does the concern from item 20 remain after the follow-up questions?"}],"positive_min":2},"result_copy":{"low":"Your answers do not show strong signs of a developmental concern right now. If your child is younger than 2, do this check-in again after their second birthday. This is a developmental check-in, not a diagnosis.","moderate":"Some of your answers are worth a closer look. A few follow-up questions can help, and a professional can check your child's development. This is a developmental check-in, not a diagnosis.","high":"Your answers suggest your child should see a developmental professional soon for an evaluation. This is a developmental check-in, not a diagnosis.","follow_up_negative":"After the follow-up questions, your answers do not show strong signs of a developmental concern right now. Keep watching your child's development and talk to your child's doctor at regular check-ups. This is a developmental check-in, not a diagnosis.","follow_up_positive":"After the follow-up questions, your answers suggest your child should see a developmental professional for an evaluation. This is a developmental check-in, not a diagnosis."}}$json$, null)
on conflict (key) do update
  set version = excluded.version, kind = excluded.kind, title = excluded.title,
      definition = excluded.definition, updated_at = now();

-- ---------------------------------------------------------------------------------------------------------
-- 2. screen_sessions

alter table public.screen_sessions drop constraint if exists screen_sessions_age_band_check;
alter table public.screen_sessions add constraint screen_sessions_age_band_check
  check (age_band in ('18-30m', '31-71m', '6-8y', '18-36m', '3-5y', '6-9y', '10y+'));

alter table public.screen_sessions
  add column if not exists instrument text not null default 'ISAA_PARENT_CHECKIN'
    references public.clinical_instruments(key),
  add column if not exists concerns text[] not null default '{}';

alter table public.screen_sessions drop constraint if exists screen_sessions_instrument_check;
alter table public.screen_sessions add constraint screen_sessions_instrument_check
  check (instrument in ('ISAA_PARENT_CHECKIN', 'MCHAT_RF'));
-- M-CHAT-R/F is a toddler instrument: only the 18-30 month band uses it.
alter table public.screen_sessions drop constraint if exists screen_sessions_mchat_band;
alter table public.screen_sessions add constraint screen_sessions_mchat_band
  check (instrument <> 'MCHAT_RF' or age_band = '18-30m');
alter table public.screen_sessions drop constraint if exists screen_sessions_concerns_check;
alter table public.screen_sessions add constraint screen_sessions_concerns_check
  check (
    concerns <@ array['speech', 'social', 'movement', 'senses', 'behaviour', 'learning']::text[]
    and cardinality(concerns) <= 6
  );

comment on column public.screen_sessions.instrument is
  '048: instrument of this check-in (ISAA_PARENT_CHECKIN, or MCHAT_RF for 18-30 months when licensed).';
comment on column public.screen_sessions.concerns is
  '048 FR-5: "What worries you most?" codes (no free text, no identifiers).';

-- ---------------------------------------------------------------------------------------------------------
-- 3. Answer validation (same signature; the check constraint keeps using it)

create or replace function public.screen_answers_valid(a jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(a) = 'object'
    and not exists (
      select 1 from jsonb_each(a) e
      where jsonb_typeof(e.value) <> 'string'
         or not (
           (e.key ~ '^(q[0-9]{1,3}|rf_[a-z_]{1,40})$'
             and (e.value #>> '{}') in ('never', 'sometimes', 'often', 'always', 'no', 'yes'))
           or (e.key ~ '^mchat_[0-9]{1,2}$' and (e.value #>> '{}') in ('yes', 'no'))
           or (e.key ~ '^mchatfu_[0-9]{1,2}$' and (e.value #>> '{}') in ('pass', 'fail'))
         )
    );
$$;

revoke all on function public.screen_answers_valid(jsonb) from public, anon, authenticated;
grant execute on function public.screen_answers_valid(jsonb) to service_role;
