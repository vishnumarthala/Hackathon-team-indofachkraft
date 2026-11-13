-- Ticket 049: Telugu and Hindi for the voice agents.
-- The follow-up agent's voice session remembers its call language, so its server tool `answer_question` returns the
-- fixed answers (108/112, medicine, condition, not found) in that language and asks the agent to translate model
-- answers faithfully (lib/followup/tool.ts). Expand only: existing sessions are English (the default backfills them).
alter table public.followup_agent_sessions
  add column language text not null default 'en';

alter table public.followup_agent_sessions
  add constraint followup_agent_sessions_language_check check (language in ('en', 'hi', 'te'));

comment on column public.followup_agent_sessions.language is
  '049: call language of the voice session (en, hi, te), chosen at start from the viewer''s UI locale.';
