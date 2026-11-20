-- Ticket 054: paediatrician referral kit (QR poster -> `/screen?ref=<slug>`).
--
-- screen_sessions (033) records which verified + listed provider's poster a check-in started from. The server
-- resolves the public profile slug itself (a client-supplied id is never trusted). It is the provider's id, not the
-- family's: no IP, no names, nothing that identifies the parent or the child. Providers only ever see an aggregate
-- count (last 30 days). Expand only: the column is nullable, so existing rows need no backfill. Unsaved check-ins are
-- still deleted after 30 days (lib/privacy/retention.ts); a deleted provider profile leaves the check-in unattributed.

alter table public.screen_sessions
  add column if not exists referred_by_profile_id uuid null
    references public.provider_profiles(id) on delete set null;

comment on column public.screen_sessions.referred_by_profile_id is
  '054: provider profile whose waiting-room poster (QR, /screen?ref=<slug>) started this check-in; null = no referral.';

create index if not exists screen_sessions_referred_by_idx on public.screen_sessions (referred_by_profile_id, created_at desc)
  where referred_by_profile_id is not null;
