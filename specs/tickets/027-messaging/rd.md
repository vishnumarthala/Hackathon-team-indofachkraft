# 027: Secure messaging (guardian <-> care team)

**Status:** draft
**Mode:** solo
**Runs:** waits for 022, 023, 032: participants come from guardian links and case assignments; new-message alerts go through the outbox; message attachments use the document vault (023)

## Summary

Case-scoped message threads between a child's guardians and the assigned providers of one
organisation, delivered live with Supabase Realtime. Because the browser subscribes directly, this is
the first feature that needs **real RLS policies** (rule 3) - and they must be proven to cut off access
the moment a guardian link, assignment or org membership is revoked. Notifications contain no message
text.

## Functional requirements

- **FR-1** - Migration `<ts>_messaging.sql`:
  - `message_threads(id, case_id -> cases, org_id, child_id, subject (1-120), created_by, created_at,
    last_message_at, archived_at)`.
  - `messages(id uuid pk, thread_id, sender_id -> auth.users, sender_kind text check in
    ('guardian','provider'), body text (1-4000), document_id null -> documents (023), client_id uuid not null,
    created_at, deleted_at, unique (sender_id, client_id))`.
  - `thread_reads(thread_id, user_id, last_read_at, primary key (thread_id, user_id))`.
  - SQL function `can_access_thread(thread_id uuid) returns boolean` (`security definer`, `search_path =
    ''`) = `auth.uid()` is an active guardian of the thread's child **or** has case access to the thread's
    case under 022 rules (owner/admin of org, or active assignment) with active org membership.
  - RLS policies: `select` on `message_threads`, `messages`, `thread_reads` using `can_access_thread`;
    no `insert/update/delete` policies (writes go through server routes). `messages` added to the
    `supabase_realtime` publication.
- **FR-2** - APIs (server routes re-check with the same rule via `lib/messaging/access.ts`):
  - `GET /api/threads?case_id=|child_id=` -> 200 `{ threads: [{ id, subject, org_name, last_message_at,
    unread }] }`.
  - `POST /api/threads` `{ case_id, subject, body, client_id }` -> 201 `{ thread, message }`
    (guardian: must be linked to the case child; provider: case access). No guardian linked yet -> 422
    `{ error: "No parent account is linked to this child yet" }`.
  - `GET /api/threads/:id/messages?before=<iso>&limit=50` -> 200 `{ messages, has_more }`.
  - `POST /api/threads/:id/messages` `{ body, client_id, document_id? }` -> 201 `{ message }`; repeated
    `client_id` from the same sender -> 200 with the existing message (idempotent); archived thread -> 409.
    `document_id` must be readable by every current thread participant per 023 rules (422 otherwise).
  - `POST /api/threads/:id/read` -> 200 (upserts `thread_reads`).
  - `DELETE /api/messages/:id` (own message, within 15 minutes) -> 200, body replaced by
    `This message was deleted.` for everyone.
  - Rate limit: 30 messages per user per 5 minutes -> 429 `{ error: "You're sending messages too fast" }`.
- **FR-3** - Message insert + `outbox_enqueue('message.created', 'thread', thread_id, { message_id },
  'message:<message_id>', now() + interval '2 minutes')` in one transaction. Fan-out (032 registry)
  sends to all participants except the sender who have **not read** the thread since the message
  (checked at fan-out); template text: `You have a new message on DoctorNearMe.` with a link to the
  thread - no sender name, no child name, no body.
- **FR-4** - Guardian UI `/family/messages` (threads across children, grouped by child) and
  `/family/messages/[threadId]`; provider UI: case workspace `Messages` tab and `/dashboard/messages` inbox.
  Thread view: messages oldest -> newest, sender name + role label (`Parent`, `<discipline_label>`),
  time (018 formatting), composer `Write a message` + `Send` (Enter sends on desktop, button on mobile),
  `Attach document` (picker of documents the user can access for that child). A fixed banner:
  `Messages are not monitored for emergencies. In an emergency call 108 (ambulance) or 112.`
- **FR-5** - Realtime: the thread page subscribes with the browser Supabase client (anon key + user
  session) to `postgres_changes` `INSERT` on `messages` filtered by `thread_id`; new messages appear
  without reload; on `CHANNEL_ERROR`/revocation the page shows `You no longer have access to this
  conversation.` and stops polling. Fallback: poll every 15 s when Realtime is unavailable.
- **FR-6** - Archive: provider owner/admin can `Archive thread` (`POST /api/threads/:id/archive`);
  archived threads are read-only. Case closure is out of scope.

## Non-functional requirements

- **NFR-1** - RLS is the browser's only path to data; tests use a real `authenticated` JWT (not the
  service role) to prove policies.
- **NFR-2** - Revocation (guardian link revoked, assignment removed, org membership revoked) blocks both
  new API reads and new Realtime events for that user within one subsequent event (test).
- **NFR-3** - Message bodies never logged, never in audit details (audit `message.sent` with ids only),
  never in notifications.
- **NFR-4** - Translated chrome (en/hi/te); 375 px; no third-party scripts on `/family/messages`.

## Affected areas

- `supabase/migrations/<ts>_messaging.sql` (new)
- `lib/messaging/**` (new), `lib/notify/topics.ts` + template `message_created` (register topic)
- `app/api/threads/**`, `app/api/messages/[id]/route.ts` (new)
- `app/family/messages/**`, `app/dashboard/messages/**`, case workspace `Messages` tab (new)
- `lib/supabase-browser.ts` (use only), `messages/*.json`
- `tests/messaging-rls.test.ts`, `tests/messaging-api.test.ts` (new)

## Don't touch

- Outbox internals (032), sharing grants (022), existing migrations, `BOARD.md`

## Out of scope

- Cross-org threads, group chats beyond one case, voice notes, read receipts per message, typing
  indicators, push notifications, message search, translation.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Transport | Supabase Realtime + RLS | plan §4 "messaging (Supabase Realtime)" |
| D-2 | Scope | One org's care team for one case + child's guardians | rule 2 |
| D-3 | Writes | Server routes only; RLS for reads/Realtime | rule 3 |
| D-4 | Notification content | Generic text, delayed 2 min, skipped if already read | privacy + noise |
| D-5 | Emergency | Persistent 108/112 banner | plan §2 "Safety" |

## Open questions

- Dependency gap: `document_id` attachments use 023, which is not upstream of 027 in the plan. If 023
  has not merged, ship without attachments (no column) and add them in a follow-up migration.
- Expected provider response times / office hours text per org - product copy, not code.
