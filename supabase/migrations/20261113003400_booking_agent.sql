-- Ticket 034: voice booking agent (web widget on /find). One row per voice booking session.
--
-- No personal data: the agent never collects names, phone numbers or dates of birth, and this table only holds
-- SHA-256 hashes, counters and the id of the hold the agent placed. Tool payloads and transcripts are not stored.
--   * `token_hash`         - SHA-256 of the per-conversation `booking_session` token the ElevenLabs agent sends with
--                            every server tool call (with the shared `X-Agent-Secret` header).
--   * `owner_session_hash` - the browser's anonymous booking session (030 `dnm_booking` cookie, hashed the same way as
--                            `appointments.hold_owner_session`), so the 030 confirm flow attaches the hold after sign-in.
--   * `tool_calls`         - FR-3: max 20 tool calls per session (incremented atomically before each call).
-- Sessions accept tool calls for 30 minutes (`expires_at`) unless ended earlier (`ended_at`: the parent ended the
-- call or a red flag stopped it). Expired rows are purged when new sessions start (1 day after expiry).
-- Server-only: RLS on, no policies, no grants for anon/authenticated (the app uses the service role).

create table public.booking_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  owner_session_hash text not null check (owner_session_hash ~ '^[0-9a-f]{64}$'),
  demo boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  ended_at timestamptz,
  tool_calls integer not null default 0 check (tool_calls >= 0),
  hold_appointment_id uuid references public.appointments(id) on delete set null,
  constraint booking_agent_sessions_expiry check (expires_at > created_at)
);

comment on table public.booking_agent_sessions is
  '034: voice booking agent sessions (hashes and counters only, no personal data). Purged 1 day after expiry.';

create index booking_agent_sessions_expires_idx on public.booking_agent_sessions (expires_at);

alter table public.booking_agent_sessions enable row level security;
revoke all on public.booking_agent_sessions from anon, authenticated;
