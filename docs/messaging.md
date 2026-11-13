# Secure messaging (ticket 027)

Case-scoped conversations between a child's guardians and the care team of **one organisation's case**
(design rule 2). The browser reads messages directly (Supabase Realtime), so this is the first feature whose
**RLS policies are the browser's only path to the data** (rule 3). Every write goes through server routes.
Read this before changing who can see a conversation or before adding another Realtime feature.

## Model (`supabase/migrations/20261113002700_messaging.sql`)

| Object | What |
|---|---|
| `message_threads` | `case_id`, `org_id`, `child_id` (copied from the case; a trigger on `cases` keeps them in sync if 020's claim flow re-points the case), `subject` (1-120), `created_by`, `created_at`, `last_message_at`, `archived_at`, `archived_by` |
| `messages` | `thread_id`, `sender_id`, `sender_kind` (`guardian` \| `provider`, decided by the server), `body` (1-4000, not blank), `document_id` (023, nullable), `client_id` (`unique (sender_id, client_id)`), `created_at`, `deleted_at`. In the `supabase_realtime` publication |
| `thread_reads` | `(thread_id, user_id)` -> `last_read_at` (never moves backwards) |

## Who can see a conversation

One SQL rule, `thread_access_level(user, thread)`, used by the server (`lib/messaging/access.ts`), the list
functions and RLS/Realtime (`can_access_thread(thread_id)` = the rule for `auth.uid()`):

| Level | Who |
|---|---|
| `guardian` | active `guardian_links` row for the thread's (live) child |
| `manage` | active owner/admin of the case's organisation (022 `case_access_level`) |
| `assigned` | active member with an active assignment to the case (022) |
| none (404) | unassigned member, removed assignment, revoked membership, other organisations (also those treating the same child), other families, platform admins without membership |

The rule is evaluated on every request and for every Realtime change, so revoking a guardian link, removing
an assignment or revoking an org membership ends access on the next API call and the next Realtime event
(tested in `tests/messaging-rls.test.ts`).

## API (all English error bodies; the UI translates by status)

| Route | Gate | Body / query | Response |
|---|---|---|---|
| `GET /api/threads?case_id=\|child_id=` | signed in; `case_id` must be a case the caller can use (guardian: linked to its child; provider: case access), `child_id` (guardians) a linked child, else 404 | - | 200 `{ threads: [{ id, subject, org_name, last_message_at, unread, case_id, child_id, child_name, case_label (providers only), archived_at, created_at }] }` |
| `POST /api/threads` | same as above for `case_id` | `{ case_id, subject, body, client_id, document_id? }` | 201 `{ thread, message }`; same `client_id` again -> 200 with the existing ones; no parent linked to the child -> 422 `No parent account is linked to this child yet` |
| `GET /api/threads/:id/messages?before=<iso>&limit=50` | `requireThreadAccess` | `limit` 1-100 | 200 `{ messages, has_more }` oldest -> newest, `Cache-Control: no-store` |
| `POST /api/threads/:id/messages` | `requireThreadAccess` | `{ body, client_id, document_id? }` | 201 `{ message }`; repeated `client_id` -> 200 existing; archived -> 409; attachment not readable by every participant -> 422; `client_id` already used in another thread -> 409 |
| `POST /api/threads/:id/read` | `requireThreadAccess` | - | 200 `{ last_read_at }` |
| `POST /api/threads/:id/archive` | `requireThreadAccess`; owner/admin of the org (else 403) | - | 200 `{ thread }` (idempotent) |
| `DELETE /api/messages/:id` | `requireMessageAccess` | - | 200 `{ message }` (body `This message was deleted.` for everyone, attachment dropped, pending notification cancelled); not yours -> 403; older than 15 min or archived -> 409 |

Rate limit: 30 messages per sender per 5 minutes (thread creation included) -> 429
`You're sending messages too fast`. A per-user advisory lock serialises one user's sends, so idempotency and
the limit hold under concurrency; sends to one thread queue on the thread row (`for no key update`). A message view carries `sender_name` (provider profile name, else the
profile display name), `sender_kind`, `discipline_label` (active care-team label for the case) and
`provider_type` (028) for the role label (`Parent`, the discipline, else the translated profession, else
`Care team`), `own`, `can_delete`, and `document` (`{ id, available: true, title, file_name, mime_type,
url: /api/documents/<id>/download }`, or `{ id, available: false }` once the viewer can no longer read it).

Static scan in `tests/messaging-api.test.ts`: every handler under `app/api/threads/**` and
`app/api/messages/**` calls `requireThreadAccess` / `requireMessageAccess` / `requireMessagingUser` first.

## Writes, outbox and audit (one transaction each, service role only)

`create_message_thread`, `send_thread_message`, `delete_thread_message`, `mark_thread_read`,
`archive_message_thread` return `{ result: <code>, ... }` (mapped to statuses in `lib/messaging/store.ts`).
A new message, its `thread_reads` bump for the sender, the outbox event and the audit row commit together:

```sql
perform public.outbox_enqueue('message.created', 'thread', <thread_id>, jsonb_build_object('message_id', <id>),
                              'message:' || <id>, now() + interval '2 minutes');
```

If the event (or the audit row) cannot be written, nothing is saved and the API answers 503 (tested with a
forced trigger failure). Audit actions: `thread.created` (`{ org_id, child_id }`), `message.sent`
(`{ thread_id, document_id }`), `message.deleted` (`{ thread_id }`), `thread.archived`. **Message bodies are
never in audit details, notifications or logs** (errors log the Postgres code only).

## Notifications (032 topic `message.created`)

Delivered 2 minutes after the message by the outbox cron. Recipients are decided **at fan-out**
(`message_notification_recipients(message_id)` via `threadMessageRecipients` in `lib/notify/recipients.ts`):
the child's active guardians, the case's assigned care team (the lead included) and anyone who started or
wrote in the thread, while they can still access it, **minus the sender and anyone whose read marker is at or
after the message**; nobody once the message is deleted. Owners/admins who are neither assigned nor in the
conversation can read it but are not notified. Channels: in-app, email, WhatsApp (when configured and opted
in). Template `message_created`: `You have a new message on DoctorNearMe.` linking to
`/family/messages/<thread>` (guardians) or `/dashboard/messages/<thread>` (providers); no sender, child or
message text.

## Attachments (023 vault)

`document_id` must be a `ready` document of the thread's child that **every current participant** can read
under 023's `document_access` (`case_document_attachable(case, doc)`): a provider upload visible to the
guardian, or a family upload the guardian shared with the organisation. Provider-only documents, unshared
family uploads and other organisations' documents -> 422. The message links to
`/api/documents/<id>/download`, which re-checks access and writes the strict `document.downloaded` row. The
picker lists the documents the viewer can read for the child and disables the ones not everyone can see.

## Realtime and RLS (FR-5, NFR-1/2)

- `alter publication supabase_realtime add table public.messages` (migration; idempotent).
- RLS select policies: `message_threads` and `messages` -> `can_access_thread(...)`; `thread_reads` -> own
  rows only and `can_access_thread`. No insert/update/delete grants for `anon`/`authenticated`; write
  functions are `service_role` only.
- Realtime `postgres_changes` checks the subscriber's JWT against these policies for every change
  (`realtime.apply_rls`), so a user who lost access simply receives nothing more. The browser uses
  `lib/supabase-browser.ts` (anon key + the user's session; supabase-js passes the access token to Realtime).
- Family pages' CSP (`lib/csp.ts`) allows the Supabase origin and its `ws(s)://` twin in `connect-src`.
- **Hosted Supabase setup:** Realtime must be enabled for the project (it is by default). Nothing to configure
  per table beyond the migration: Database -> Publications should list `messages` under `supabase_realtime`.
  Do not enable Realtime "Broadcast/Presence authorisation" for this feature; it only uses `postgres_changes`.

Client behaviour (`components/messaging/threadSync.ts`, unit-tested): Realtime is a progressive enhancement.
A change event triggers a fetch through the API (which re-checks access), never trusting the event payload.
While Realtime is `SUBSCRIBED` the page also checks the API every 60 s (Realtime stops sending to a revoked
user, it does not tell them). On `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED` or no answer within 10 s the page checks
the API once, drops the channel (stopping reconnect attempts) and **polls every 15 s**. Any 404 shows
`You no longer have access to this conversation.` and stops all updates. The status line reads
`Live updates on` / `Checking for new messages every 15 seconds`. The inbox pages use the same controller with
an unfiltered `INSERT` subscription (RLS-filtered) and refresh the server-rendered list when it changed.

**Local stack:** Realtime is excluded from the local test stack, so pages fall back to polling (expected
console noise: a few failed `ws://.../realtime/v1/websocket` handshakes before the fallback). Realtime
authorisation is still tested at the database layer: `tests/messaging-rls.test.ts` creates a temporary
`wal2json` logical slot and `realtime.subscription` rows like the Realtime server does and runs the changes
through `realtime.apply_rls` (the core of `realtime.list_changes`).

## UI

- Guardian: `/family/messages` (per child: `New message` with `To` = the treating organisation when there is
  more than one, then the child's threads) and `/family/messages/[threadId]`.
- Provider: case workspace `Messages` tab (`/cases/[id]/messages`, `/cases/[id]/messages/[threadId]`) and the
  inbox `/dashboard/messages` (`/dashboard/messages/[threadId]`), linked from the dashboard header.
- Thread view: messages oldest -> newest with name, role label and time (018 formatter), `Write a message` +
  `Send` (Enter sends on desktop; on touch screens Enter adds a line and the button sends), `Attach document`,
  `Delete` (own, 15 min), `Archive thread` (owners/admins), and the fixed banner
  `Messages are not monitored for emergencies. In an emergency call 108 (ambulance) or 112.`
- Strings: `messaging.*` and `caseTabs.messages` in en/hi/te (hi/te drafts, see `messages/REVIEW.md`).
- Components: `components/messaging/*` (`ThreadView`, `ThreadPage`, `ThreadList`, `NewThreadForm`,
  `LiveThreadsRefresher`, `EmergencyBanner`, `threadSync.ts`, `realtime.ts`, `client.ts`).

## Privacy and audit (041)

- Registry entry `messages` (`lib/privacy/registry.ts`): the guardian export contains the conversations of the child
  that this guardian can open (`thread_access_level = 'guardian'`), with the text they see (deleted messages as
  `This message was deleted.`), sender kind, `own`, attachment ids (files come from the `documents` category) and
  only their own read marker. Erasure (`everything`) deletes every organisation's threads of the child (messages and
  read markers cascade) and their `thread` outbox events. The privacy notice lists messages under what we collect and
  in the retention table.
- Audit rows are written inside the database functions with `actor_user_id`; 041's `audit_events_fill` trigger adds
  `actor_role`, `case_ref`, `org_id` and `child_id` (requests through supabase-js RPC carry no `request_id` /
  `ip_hash`, as for 020-023). The four actions are registered as strict (`kind: "sql"`) in
  `lib/audit/strict-actions.ts` and honour the `AUDIT_FAIL_ACTIONS` dev hook. Errors are logged through
  `lib/log.ts` with the Postgres code only. Audit rows survive case deletion; tests remove their synthetic rows with
  `purgeTestAudit` (`tests/helpers/audit.ts`).

## Not in this ticket

Cross-org or group threads, voice notes, per-message read receipts, typing indicators, push notifications,
search, translation, case-closure archiving, office-hours / response-time copy (product question).

## Tests

`tests/messaging-api.test.ts` (static gate scan; access matrix; reply + unread; 422 no parent; validation;
idempotent `client_id`; 429; concurrent senders; delete window; archive 409; attachments under 023 rules; forced outbox failure
rolls back; fan-out recipients with read markers and revocation; no text in audit/logs; FR-5 sync controller
with fake timers) and `tests/messaging-rls.test.ts` (real user JWTs through PostgREST; no client writes;
Realtime delivery per subscriber; revocation of link / assignment / membership). Helpers:
`tests/helpers/messaging.ts`.
