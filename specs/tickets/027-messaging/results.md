# 027: Secure messaging (guardian <-> care team) - Results

Branch: `ticket/027-messaging` (base `65d8444`: 017-023, 028, 029, 032 merged). Tested against the local
Supabase stack of slot 6 (all migrations applied by `supabase db reset`; **Realtime is not part of this local
stack**), `DEMO_MODE=true`, dev server on port 3060. Browser checks with an isolated headless Chrome
(`playwright-core` in the git-ignored `.tmp/`, own cookie jar), script output in `evidence/acceptance.txt`.
Synthetic accounts (`seed:users --prefix m027 --extra-member`), child `Asha (synthetic m027)` with an org A
case (`provider_a` assigned as `Speech therapist`, `provider_a2` unassigned) and an org B case; synthetic
messages and PDFs only.

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113002700_messaging.sql` | PASS | `message_threads`, `messages` (`unique (sender_id, client_id)`, body 1-4000 not blank, `document_id` -> 023 `documents`), `thread_reads`; trigger keeps thread org/child in sync with the case; access rule `thread_access_level` + RLS helper `can_access_thread` (security definer, `search_path = ''`); select-only RLS policies; `messages` added to `supabase_realtime`; security-definer writes `create_message_thread`, `send_thread_message`, `delete_thread_message`, `mark_thread_read`, `archive_message_thread` (service role only; message + outbox + strict audit in one transaction); `db reset` applies cleanly |
| `npm run lint`, `npm run typecheck`, `npm run build` | PASS | all exit 0; new routes `/api/threads`, `/api/threads/[id]/{messages,read,archive}`, `/api/messages/[id]`, `/family/messages[/[threadId]]`, `/dashboard/messages[/[threadId]]`, `/cases/[id]/messages[/[threadId]]` in the build |
| `npx vitest run` (slot-6 database) | PASS | 62 files, 899 passed, 10 skipped (the pre-existing opt-in `CT_DB_TESTS=1` suite in `tests/intake-completion.test.ts`); every DB suite ran |
| `npx vitest run tests/messaging-rls.test.ts tests/messaging-api.test.ts --reporter=verbose` | PASS | 29 passed, 0 skipped (`evidence/vitest-027-verbose.txt`) |
| RLS with real user JWTs (NFR-1) | PASS | users sign in with a password through Supabase Auth; PostgREST with the anon key + their access token (claims checked: `role: authenticated`, `sub` = user): guardian_a, guardian_a2, org owner, assigned providers read the thread and messages; unassigned member, org B owner, other family and `anon` read 0 rows; read markers: own rows only; inserts/updates/deletes on all three tables and the write RPCs fail for anon and user JWTs; the stored message is unchanged |
| Realtime authorisation (FR-5) | PASS | database layer of `postgres_changes`: temporary `wal2json` slot + `realtime.subscription` rows (`thread_id=eq.<id>`, claims per user) run through `realtime.apply_rls` (the core of `realtime.list_changes`): an insert is delivered to the guardians and the assigned providers only, not to the unassigned member, org B or the other family |
| NFR-2 revocation | PASS | after revoking guardian_a2's link, removing assigned_a's assignment and revoking assigned3_a's membership: the same JWTs read 0 rows on the next request, the next insert reaches none of their Realtime subscriptions (guardian_a still does), and `thread_access_level` is null for all three |
| Idempotent `client_id`, 429, 409, delete window | PASS | thread and message create: same `client_id` -> 200 with the same ids, one row, one outbox event; same `client_id` in another thread -> 409; 30 messages in 5 minutes -> 429 `You're sending messages too fast` (thread create too; replays still 200; other users unaffected; allowed again after the window); 8 concurrent sends by 4 different participants to one thread all succeed (the thread row is locked `for no key update`; `for share` deadlocked, caught by this test); archived -> 409 for send and delete, reads still 200; delete: other's message 403, after 15 min 409, own within 15 min -> body `This message was deleted.` for everyone, stored body overwritten, pending notification `cancelled` |
| Atomic message + outbox event | PASS | a trigger forcing `outbox_events` inserts for the thread to fail -> `POST` 503 `Could not send. Please try again.`, no message row, no `message.sent` audit; works again once removed |
| E-1 conversation with live delivery | PASS (polling) | guardian_a (375 px, touch) starts `m027 Sleep question` via `New message` (`To`: org A, the child has two treating orgs); provider_a on the case `Messages` tab sees it without reload after 14 971 ms; provider replies with Enter, guardian sees it after 785 ms (page refresh cycle). Without local Realtime both pages show `Checking for new messages every 15 seconds`; see Deviations for the 3 s target. Banner `Messages are not monitored for emergencies. In an emergency call 108 (ambulance) or 112.` on both (`family-thread-en-375.png`, `provider-thread.png`, `provider-case-messages-tab.png`) |
| FR-4 thread view | PASS | messages oldest -> newest with `Meera (synthetic) · Parent · <time>` and `Dr Kavya (synthetic) · Speech therapist · <time>` (018 formatter), `Write a message` + `Send`, Enter sends on desktop (201), on touch screens the hint is hidden and the button sends; `Attach document` lists the readable documents and disables `m027 Internal note (not visible to everyone)`; `Archive thread` only for owners/admins; inbox `/dashboard/messages` |
| E-2 notification behaviour | PASS | provider writes while the guardian is on `/family`: event `deliver_after - created_at = 00:02:00`; after waiting 125 s, `npm run -s outbox:run -- --once --mock-log` fans out: guardian_a `in_app:sent` `You have a new message on DoctorNearMe.` (link `/family/messages/<thread>`, shown by `GET /api/notifications` and `/family/notifications`, `family-notifications-en-375.png`), email + WhatsApp delivered to the mock log, none containing any message text; org_admin_a (case lead) notified too, never the sender. Second message while the guardian has the thread open (page shows it, read marker updated): after 2 min + cron the event is `fanned_out` with no row for the guardian. DB test: recipients re-checked at fan-out (read marker, revoked link, sender excluded; unassigned member and org B never) |
| E-3 revocation | PASS | provider_a and guardian_a have the thread open; `remove_case_assignment` for provider_a; guardian sends: the provider page shows `You no longer have access to this conversation.` on its next check (15 412 ms with the page already polling) and never shows the new message (`provider-access-lost.png`); refresh -> 404; direct API `GET`/`POST /api/threads/:id/messages` as provider_a, provider_a2, provider_b, guardian_b -> 404 |
| E-4 attachment and idempotency | PASS | provider uploads two PDFs through the 023 routes; attaching the guardian-visible one -> 201, guardian follows `/api/documents/<id>/download` -> 302 -> 200 `application/pdf`; the `visible_to_guardian = false` one -> 422 `Everyone in this conversation must be able to see this document`; same `client_id` twice -> 201 then 200, one row. DB test also covers unshared family uploads, other orgs' documents, unknown ids (422) and a document hidden later (`{ available: false }`, no title) |
| E-5 privacy | PASS | `message.sent` / `thread.created` / `message.deleted` audit details hold only `thread_id`, `document_id`, `org_id`, `child_id`; dev-server log (374 lines) and the test-run console contain none of the synthetic message texts; notification rows/emails carry the generic text only |
| NFR-4 translated, 375 px, no third-party scripts | PASS | `messaging.*` + `caseTabs.messages` in en/hi/te, `messages/REVIEW.md` regenerated, `tests/i18n-keys.test.ts` green; Telugu family pages (`family-messages-te-375.png`, `family-thread-te-375.png`), Hindi provider inbox (`provider-inbox-hi.png`); no horizontal scroll at 375 px; `/family/messages` loads 19 scripts, all same-origin, under the nonce CSP with no CSP violations |

## Deviations

- **Realtime locally / E-1 "within 3 s":** the local test stack runs without Supabase Realtime (excluded to save
  memory), so E-1 was exercised on the FR-5 fallback: pages poll every 15 s (provider saw the new thread after
  ~15 s; the guardian saw the reply within one cycle). Realtime is wired as a progressive enhancement
  (`components/messaging/realtime.ts` + `threadSync.ts`, unit-tested with fake timers) and its authorisation is
  proven at the database layer (`realtime.apply_rls` over a `wal2json` slot) instead of through the Realtime
  server. A run against hosted Supabase (or a local stack with Realtime) is needed to time the live path.
- **CHANNEL_ERROR handling (FR-5):** a channel error does not by itself show `You no longer have access...`
  (it also happens whenever Realtime is unreachable): the page checks the API at once and shows the message
  only on 404, otherwise it falls back to polling. While Realtime is live the page also re-checks the API every
  60 s, because Realtime stops sending events to a revoked user without telling them.
- **`thread_reads` RLS:** participants read only their own read markers (rd: "select using
  `can_access_thread`"), so nobody learns when others read a thread (per-message read receipts are out of
  scope).
- **Notification recipients (FR-3 "all participants"):** guardians, the case's assigned care team (lead
  included) and anyone who started or wrote in the thread. Org owners/admins who are neither assigned nor in
  the conversation can read it but are not notified about every message of the organisation.
- **CSP:** `lib/csp.ts` now also allows the Supabase `ws(s)://` origin in `connect-src` on family pages
  (Realtime's websocket); `tests/guardian-routing.test.ts` and `docs/guardian-auth.md` updated.
- **Extra API fields:** `GET /api/threads` also returns `case_id`, `child_id`, `child_name`, `archived_at`,
  `created_at` (and `case_label` for providers) for grouping; message views carry sender/role/document data.

## Notes

- New helpers: `lib/messaging/access.ts` (`requireThreadAccess`, `requireMessageAccess`,
  `requireMessagingUser`, `canUseCase`, `requireThreadPage`, `getThreadAccessLevel`), `lib/messaging/store.ts`,
  `lib/messaging/schemas.ts`, `lib/messaging/constants.ts`, `lib/messaging/types.ts`;
  `threadMessageRecipients` in `lib/notify/recipients.ts`; `MESSAGE_TOPICS` in `lib/notify/topics.ts`. The
  032 placeholder payload (`child_id`, `case_id`, `recipient_user_ids`) of `message.created` is replaced by
  `{ message_id }` with aggregate = thread. No new environment variables.
- Migration order: `20261113002700` sorts before the already-merged 028/029/032 migrations; its plpgsql
  functions resolve `provider_profiles` and `outbox_enqueue` at call time (like 022/023). Databases that already
  applied later migrations need `supabase migration up --include-all` (as for 023).
- Shared files touched additively: `components/case/CaseTabs.tsx` (`Messages` tab), `app/dashboard/layout.tsx`
  (`Messages` link), `messages/*.json` (`messaging` namespace + `caseTabs.messages`), `lib/csp.ts`.
- Hindi and Telugu strings are drafts awaiting native review (`messages/REVIEW.md`).
- Docs: `docs/messaging.md` (new, incl. how Realtime RLS is configured for hosted Supabase),
  `docs/system-design.md`, `docs/notifications.md`, `docs/guardian-auth.md`.

## Merge of `main` (024 assessments / published versions, 025 IEP, 041 privacy and audit baseline)

- Conflicts resolved keeping both sides: `lib/notify/topics.ts` / `recipients.ts` (024/041 recipients and topic
  groups next to `threadMessageRecipients` / `MESSAGE_TOPICS`), `docs/system-design.md`, `messages/*.json`
  (main's catalogues + `messaging.*` + `caseTabs.messages`; `messages/REVIEW.md` regenerated with
  `npx tsx scripts/i18n-review.ts`). Case tabs and the dashboard header merged automatically (`Assessments`, `Goals`
  and `Messages`).
- **041 privacy registry:** new category `messages` (`message_threads`, `messages`, `thread_reads`) in
  `lib/privacy/registry.ts`: guardian export = the child's conversations this guardian can open, with the text they
  see, sender kind, `own`, attachment ids and only their own read marker (another family gets nothing); erasure
  (`everything`) deletes every organisation's threads of the child and their `thread` outbox events. Privacy notice
  (`/privacy`): messages added to "what we collect" and the retention table (en/hi/te); `docs/privacy/retention.md`
  updated.
- **041 audit:** the four messaging actions (`thread.created`, `message.sent`, `message.deleted`,
  `thread.archived`) are registered as strict `kind: "sql"` actions in `lib/audit/strict-actions.ts`; the database
  functions write the audit row themselves (the `message.sent` insert moved from the shared helper into
  `create_message_thread` / `send_thread_message`, still in the same transaction), the 041 fill trigger attributes
  `actor_role`, `case_ref`, `org_id`, `child_id` from `actor_user_id`, and `lib/messaging/store.ts` honours
  `AUDIT_FAIL_ACTIONS` and logs through `lib/log.ts`. Test cleanups never delete audit rows directly: the messaging
  suites remove only their own synthetic rows through `purgeTestAudit` (`tests/helpers/audit.ts`).
- New tests: `AUDIT_FAIL_ACTIONS=message.sent` -> 503 and nothing saved, attributed audit row; registry export
  (own child only) and erasure (rolled back).
- After `dnm-db.sh 6 <worktree> reset` (all migrations incl. 0024xx, 0025xx, 0041xx): `npm run lint` (exit 0, no
  warnings), `npm run typecheck` (exit 0), `npx vitest run` 71 files, **1064 passed, 11 skipped** (10 = the opt-in
  `CT_DB_TESTS` suite, 1 = the opt-in live crawl in `tests/no-tracking.test.ts`; every DB suite ran), messaging suites
  31 passed (`evidence/vitest-027-verbose.txt`), `tests/audit-hardening.test.ts` green with the new entries,
  `npm run build` exit 0.
- E-1 / E-3 re-checked in the headless browser (fresh `seed:users --prefix m027` data): guardian starts a thread,
  provider's case tab shows it after 15 202 ms (polling), reply reaches the guardian live, banners present; removing
  provider_a's assignment -> `You no longer have access to this conversation.` after 15 400 ms, new message never
  shown (`evidence/acceptance.txt`, last section; screenshots refreshed).
