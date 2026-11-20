-- Ticket 055 follow-up: in the free pilot (PAYMENTS_ENABLED not "true") the outbox worker leaves payment, fee and payout
-- work untouched instead of consuming it. Before, a worker with payments off marked such events done (no recipients) and
-- such notifications skipped, so a payment message could be dropped by whichever process happened to run the worker.
-- Now the claim functions take optional skip lists (topics for events, templates for notifications): the free-pilot
-- worker never claims them, a worker with payments on delivers them as before, and payment messages left over from
-- before the switch wait until payments are on again. Callers that pass nothing behave exactly as before.
-- The old signatures are dropped first: a defaulted extra argument would make two-argument calls ambiguous.

drop function if exists public.outbox_has_due_work();
drop function if exists public.outbox_claim_events(integer, bigint[]);
drop function if exists public.notifications_claim(integer, integer, bigint[], integer);

create function public.outbox_has_due_work(p_skip_topics text[] default null, p_skip_templates text[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.outbox_events
           where status = 'pending' and deliver_after <= now() and (p_skip_topics is null or topic <> all(p_skip_topics))
         )
      or exists (
           select 1 from public.notifications
           where status in ('pending', 'failed') and next_attempt_at <= now()
             and (p_skip_templates is null or template <> all(p_skip_templates))
         )
      or exists (
           select 1 from public.notifications
           where status = 'sending' and locked_until < now() and (p_skip_templates is null or template <> all(p_skip_templates))
         );
$$;

create function public.outbox_claim_events(p_batch integer, p_event_ids bigint[] default null, p_skip_topics text[] default null)
returns setof public.outbox_events
language sql
security definer
set search_path = ''
as $$
  select * from public.outbox_events
  where status = 'pending' and deliver_after <= now() and (p_event_ids is null or id = any(p_event_ids))
    and (p_skip_topics is null or topic <> all(p_skip_topics))
  order by deliver_after, id
  limit greatest(1, least(p_batch, 500))
  for update skip locked;
$$;

create function public.notifications_claim(
  p_batch integer,
  p_lease_seconds integer,
  p_event_ids bigint[] default null,
  p_max_attempts integer default 6,
  p_skip_templates text[] default null
) returns setof public.notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  with exhausted as (
    update public.notifications
    set status = 'dead', locked_until = null, last_error = 'lease_expired', last_attempt_at = now()
    where status = 'sending' and locked_until < now() and attempts >= p_max_attempts
      and (p_skip_templates is null or template <> all(p_skip_templates))
    returning id, channel, template, recipient_user_id
  )
  insert into public.audit_events (actor, action, entity, entity_id, details)
  select 'system', 'notification.dead', 'notification', x.id::text,
         jsonb_build_object('channel', x.channel, 'template', x.template, 'error', 'lease_expired')
  from exhausted x;

  return query
  with due as (
    select id from public.notifications
    where channel <> 'in_app'
      and (p_event_ids is null or event_id = any(p_event_ids))
      and (p_skip_templates is null or template <> all(p_skip_templates))
      and (
        (status in ('pending', 'failed') and next_attempt_at <= now())
        or (status = 'sending' and locked_until < now())
      )
    order by next_attempt_at, id
    limit greatest(1, least(p_batch, 500))
    for update skip locked
  )
  update public.notifications n
  set status = 'sending',
      attempts = n.attempts + 1,
      -- Millisecond precision so the lease round-trips through JavaScript Dates (notification_complete compares it).
      locked_until = date_trunc('milliseconds', now() + make_interval(secs => greatest(10, least(p_lease_seconds, 3600)))),
      last_attempt_at = now()
  from due
  where n.id = due.id
  returning n.*;
end;
$$;

revoke all on function public.outbox_has_due_work(text[], text[]) from public, anon, authenticated;
revoke all on function public.outbox_claim_events(integer, bigint[], text[]) from public, anon, authenticated;
revoke all on function public.notifications_claim(integer, integer, bigint[], integer, text[]) from public, anon, authenticated;
grant execute on function public.outbox_has_due_work(text[], text[]) to service_role;
grant execute on function public.outbox_claim_events(integer, bigint[], text[]) to service_role;
grant execute on function public.notifications_claim(integer, integer, bigint[], integer, text[]) to service_role;
