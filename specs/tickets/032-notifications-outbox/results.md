# 032: Notifications - transactional outbox, scheduler, email / in-app / WhatsApp adapters - Results

Branch: `ticket/032-notifications-outbox` (base: `main` with 017-020, 028, 029 merged). Tested against the
isolated local Supabase stack of slot 5 (ports 613xx, all ten migrations applied by `db reset`),
`DEMO_MODE=true`, `CRON_SECRET=test-3050`, dev server on port 3050, integrated browser (375 px wide) and curl.
Accounts from `npm run -s seed:users -- --prefix e032`. Synthetic data only; Resend and WhatsApp are never
called (DEMO_MODE / mocked).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113003200_outbox.sql` | PASS | `db reset` applies all migrations; `outbox_enqueue` twice with one dedup key returns the same id; `authenticated` sees only its own in-app rows (guardian_a 3 own / 0 others / 0 email-WhatsApp rows), `outbox_events` and `anon` access are `permission denied` |
| `npm run lint` | PASS | exit 0, no warnings |
| `npm run typecheck` | PASS | exit 0 |
| `npx vitest run` | PASS | 55 files, 763 passed, 10 skipped (the pre-existing 010 block); every DB suite ran (incl. 028/029/020 suites and the new `outbox.test.ts`) |
| `npm run build` | PASS | exit 0; new routes `/api/cron/outbox`, `/api/notifications`, `/api/notifications/read`, `/api/notification-preferences`, `/api/admin/notifications/[id]/retry`, `/notifications`, `/family/notifications`, `/dashboard/notifications`, `/dashboard/settings`, `/admin/notifications` |
| `npm run verify` | PASS | the four commands above, all exit 0 |
| `npx vitest run tests/outbox.test.ts tests/notify-adapters.test.ts tests/notify-templates.test.ts --reporter=verbose` | PASS | 3 files, 62 tests (list below) |
| Rolled-back enqueue -> no event; same `dedup_key` twice -> one event | PASS | `outbox.test.ts` "enqueue commits with the caller's transaction" (`sql.begin` + throw -> 0 rows; `enqueue` twice and `enqueueEvent` via RPC -> same id, 1 row; payload with an extra key -> `Invalid payload`) |
| Two concurrent `notifications_claim` (two DB connections) never return the same row; expired lease reclaimed | PASS | `outbox.test.ts` NFR-2: 60 rows claimed in batches of 7 by two pools -> disjoint, 60 total; expired lease reclaimed by the other connection (`attempts` 2) and the stale lease can no longer record an outcome |
| Retry schedule 1m, 5m, 30m, 2h, 12h then `dead`; permanent error -> `dead` at once | PASS | `outbox.test.ts` FR-5 (measured delays `[1, 5, 30, 120, 720]` min, 6th attempt `dead` + one `notification.dead` audit row, `last_error` without the address); permanent `NotifyError` -> `dead` with `attempts` 1; unit test in `notify-adapters.test.ts` |
| Fan-out re-checks access | PASS | `outbox.test.ts`: `iep.published` for a child with guardians A and B, B's link revoked after enqueue -> rows only for A (3 channels); `assessment.red_flag` -> only the case org's provider |
| WhatsApp adapter: URL/body, `skipped` without env, `opted_out` | PASS | `notify-adapters.test.ts`: `POST https://graph.facebook.com/v21.0/123456789/messages`, Bearer token, template name/language/body params, `biz_opaque_callback_data`; missing token / phone id / DEMO_MODE -> `whatsapp_not_configured` (fetch never called); preference off -> `opted_out`; no verified phone -> `no_phone`; Meta 131026/132001 permanent, 130429/5xx transient |
| Email adapter: `.ics` stable UID + incremented SEQUENCE; `Idempotency-Key` | PASS | `notify-adapters.test.ts`: `invite.ics` (`text/calendar; method=REQUEST`) with the same `UID` and `SEQUENCE:0` / `SEQUENCE:1`; through the real Resend SDK with `fetch` mocked the request carries `Idempotency-Key: notification:<id>` and the base64 attachment; DEMO_MODE -> nothing sent, provider id `demo` |
| Templates: en/hi/te; no child `display_name`, no `autism` / `ISAA` / `diagnos` / `score` in email/WhatsApp | PASS | `notify-templates.test.ts`: 12 topics x 3 locales x 2 roles; hi/te differ from en; payload schemas are strict (a `display_name` key is rejected) |
| E-1 end-to-end in-app + email | PASS | `select outbox_enqueue('test.ping','user','<guardian_a>','{}','ping-e032',now())` -> `359`; `curl -X POST .../api/cron/outbox` without header -> `401 {"error":"Unauthorized"}`, wrong bearer -> 401, with `Bearer test-3050` -> `200 {"fanned_out":1,"sent":1,"failed":0,"skipped":1}`; repeat with nothing due -> 200 zeros in 6 ms. guardian_a (phone OTP demo sign-in) sees bell `Notifications, 1 unread` (badge `1`); `/notifications` redirects to `/family/notifications` and lists `Test notification`; `Mark all as read` -> bell `Notifications, 0 unread`, button disabled. Email row `sent`, `provider_message_id = demo`; WhatsApp row `skipped` / `whatsapp_not_configured` |
| E-2 scheduled + cancel | PASS | enqueued `ping-sched-e032` and `ping-cancel-e032` with `deliver_after = now() + 2 minutes`, `outbox_cancel('ping-cancel-')` -> 1. Cron at 00:23:22 and 00:25:12: scheduled event still `pending`, no rows; cron at 00:25:33 (after `deliver_after` 00:25:22): `fanned_out` with in-app `sent`. Cancelled event stays `cancelled`, never fanned out or sent |
| E-3 WhatsApp skipped, preferences | PASS | guardian_a turned `Email` off in `/family/settings` (keyboard, `Saved.`, persisted after reload); next event: email `skipped` / `opted_out`, in-app `sent`, WhatsApp `skipped` / `whatsapp_not_configured`; the domain flow (enqueue + cron 200) is unaffected |
| E-4 authz negatives | PASS | guardian_b: `GET /api/notifications` -> `items: []` (none of guardian_a's ids); `POST /api/notifications/read` with guardian_a's two ids -> `200 {"updated":0}`, guardian_a's unread row still `read_at = null`. provider_a: `/admin/notifications` -> redirected to `/dashboard`; `POST /api/admin/notifications/<id>/retry` -> 403. Platform admin: page shows counts and the dead row (topic, channel, status, attempts, error; no message text), `Retry` -> `Queued again.` |
| E-5 concurrency | PASS | 100 `test.ping` events for guardian_b (= 200 email/WhatsApp notifications), two `npm run -s outbox:run -- --duration 60 --mock-log <file>` processes for one minute: each fanned out 50 events and sent 100; mock log 200 lines, 200 unique ids, 0 duplicates; DB: email 100 `sent`, WhatsApp 100 `sent`, in-app 100 `sent`. Also automated in `outbox.test.ts` (two pools, counting senders, each id exactly once) |
| `after()` immediate drain | PASS | platform admin `POST /api/admin/providers/<id>/suspend` (synthetic verified profile) -> 200; without any cron call the `provider.suspended` event was fanned out 16 ms after commit and the email sent (demo) 36 ms after; provider_b's `GET /api/notifications` lists `Profile suspended` |
| 028 `notifyLater` replaced | PASS | triggers enqueue `provider.verified` / `.rejected` (on `credential_submissions`), `.suspended` / `.claimed` (on `provider_profiles`) in the deciding transaction; `tests/verification.test.ts` and `tests/claim-link.test.ts` assert the events; rollback test in `outbox.test.ts` |

Automated test list (62): WhatsApp request/skip/opt-out/error classes (4); email `.ics`, Resend header, DEMO,
skips, error classes (5); retry policy, error hygiene, ICS folding (3); topic registry + strict payloads (13);
templates render (12) + content rule (12) + role links + invite (2); DB: transaction/dedup, schedule/cancel,
access re-check, two-connection claims + lease expiry, retry schedule, 200 x two workers, preferences (E-3),
inbox/read authz + pagination (E-1/E-4), admin retry, cron auth, 028 triggers (11).

## Deviations

- **WhatsApp and Resend not called for real.** No Meta business account, approved templates or Resend key
  exist locally. The WhatsApp adapter is complete (Graph API request, error classification) and tested with a
  mocked `fetch`; without `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`, or in `DEMO_MODE`, deliveries are
  `skipped` / `whatsapp_not_configured`. Email keeps `lib/email.ts` DEMO behaviour (row `sent`, provider id
  `demo`). Template submission to Meta is a human task (list in `docs/notifications.md`).
- **Vercel cron not exercised** (no deployment). `vercel.json` schedules `/api/cron/outbox` every minute;
  Vercel cron uses `GET`, so the route accepts `GET` and `POST` with the same bearer check. Locally the
  route was driven by curl and `npm run outbox:run`.
- **Retry count.** FR-5 lists five delays and "after 5 attempts -> dead"; the eval asks for the full
  1m/5m/30m/2h/12h schedule "then dead". Implemented as 6 attempts in total: the first attempt plus one retry
  after each delay; the failure of the attempt after the 12 h retry is `dead`.
- **Preferences.** In-app is always on; email defaults **on**, WhatsApp defaults **off** (opt-in, required by
  Meta for business-initiated messages). A preference-off delivery is `skipped` / `opted_out` (FR-6), not
  `dead`; FR-5's "opted out -> dead" applies to provider-reported opt-outs (Meta 131050).
- **`/notifications`** redirects to `/family/notifications` (guardians, inside the family shell) or
  `/dashboard/notifications` (providers and admins) so each role keeps its header and bell.
- **Provider settings** did not exist; added `/dashboard/settings` (linked as `Settings` in the provider
  header) with the `Notifications` section.
- **`/admin/notifications` for other roles** redirects to the user's home (eval: 403/redirect), unlike the
  older `/admin/*` pages, which answer 404. The retry API answers 403.
- **Recipients `recipients(payload, { sql, event })`** take the fan-out transaction as a second argument
  (FR-2 shows `recipients(payload)`), so access checks run inside the fan-out transaction.
- **`message.created`** (027 not built yet) uses producer-named `recipient_user_ids` re-checked against the
  child (027 replaces it with thread participants who have not read the thread). 028's provider topics and
  022's `sharing.granted` (see the merge section) were added to the registry.
- **Template strings** (en/hi/te) live in the template files, not in `messages/*.json`, so the browser bundle
  does not carry them; hi/te are first drafts listed for native review in `docs/notifications.md`. UI strings
  are in `messages/*.json` (`notifications` namespace, `REVIEW.md` regenerated, rows `pending`).
- **Additions not named in the rd:** `notifications.last_attempt_at` (admin ordering),
  `notification_complete(...)` and `notification_retry(...)` SQL functions (lease-checked outcome and audited
  retry in one transaction), `outbox_has_due_work()`, `lib/pg.ts` (shared Postgres pool, same global as
  `lib/facts.ts`), `GET /api/notification-preferences`.

## Notes

- **Producer API for later tickets** (`docs/notifications.md`): `enqueue(tx, { topic, aggregateType,
  aggregateId, payload, dedupKey, deliverAfter? })` inside `sql.begin` (`lib/pg.ts` `pg()`), or
  `perform public.outbox_enqueue(...)` inside SQL functions; `enqueueEvent({...})` for supabase-js code (also
  drains); `drainSoon(eventIds?)` after the response; `cancelEvents(prefix)` / `outbox_cancel(prefix)` (030
  reminders, e.g. `appt:<id>:`). Register topics in `lib/notify/topics.ts` and templates in
  `lib/notify/templates/` (`defineTemplate`, optional `ics`), add a sample payload to
  `tests/notify-templates.test.ts`.
- **Schema:** `outbox_events`, `notifications`, `notification_preferences` + the functions above; triggers
  `credential_submissions_outbox` and `provider_profiles_outbox` (028 topics).
- **Env:** `CRON_SECRET` (required for cron), `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_API_VERSION` (default `v21.0`) in `.env.example` and `lib/env.ts`.
- **022 `sharing.granted`** is wired (merge section below); no `notifyLater` remains in code or docs.
- **030** adds its `/api/cron/booking` entry to `vercel.json` next to `/api/cron/outbox`; `/api/cron/*` is
  already public to the proxy (handlers check the secret).
- **Shared files touched additively:** `lib/auth-access.ts` (one public prefix), `lib/email.ts`
  (attachments + idempotency key + status on `EmailError`), `lib/env.ts`, `.env.example`, `messages/*.json`
  (new `notifications` namespace), `messages/REVIEW.md` (regenerated), `docs/system-design.md`, family portal
  layout + settings page and dashboard layout (bell, settings link), `tests/helpers/providers.ts` (cleanup
  of outbox rows), 028's `lib/providers/{verification,claims}.ts` (`notifyLater` -> `drainSoon`).
- **Browser cookie collision (environment):** all local dev servers share the `localhost` cookie
  `sb-127-auth-token` regardless of port, so another worker's sign-in in the same integrated browser replaced
  the session mid-run (`User from sub claim in JWT does not exist`, the pre-existing proxy 500 noted in 020).
  The drain check was then run with curl and a private cookie jar.
- The E2E data (`e032-*@example.test` accounts, `ping-*-e032` / `e5-e032-*` events, the synthetic
  `e032-dr-b` profile) is left in the slot 5 database.

## Merge with `main` (022 care team + sharing grants)

- `git merge main` into `ticket/032-notifications-outbox`. Conflicts: `lib/notify/topics.ts` (032 registry kept,
  022's `SHARING_TOPICS` kept as a registry-typed constant, 022's `notifyLater` stub dropped),
  `messages/{en,hi,te}.json` (both namespaces kept, deep-merged, no value clashes), `messages/REVIEW.md`
  (regenerated with `npx tsx scripts/i18n-review.ts`, 1013 rows). `lib/authz.ts`, `lib/auth-access.ts`,
  `docs/system-design.md`, `.env.example`, seed scripts and tests merged automatically. No 032 code calls
  `listCases`.
- **`sharing.granted` wired to the outbox.** New migration `20261113003201_sharing_outbox.sql`: an `after insert`
  trigger on `sharing_grants` enqueues `sharing.granted` (payload `grant_id, child_id, source_org_id,
  grantee_org_id, grantee_case_id`, dedup `sharing.granted:<grant id>`) inside `create_sharing_grant`'s
  transaction; `createSharingGrant` calls `drainSoon()` instead of `notifyLater`. Recipients
  (`activeGrantRecipients`): active owners/admins of the grantee org, re-checked at fan-out that the grant is
  not revoked or expired, the child is live and the granting guardian's link is still active (org and child
  read from the grant row, not the payload). In-app + email (no WhatsApp), template `sharing_granted`
  ("A family shared their child's records with your organisation.", no child name, no scopes), linking to
  the grantee case's `Shared with us` tab (`/cases/<id>/shared`). `docs/sharing.md`, `docs/providers.md` and
  `docs/notifications.md` updated; `grep notifyLater` finds nothing outside `specs/`.
- **Aligned with 022's access rule:** `caseProviders` (`assessment.red_flag`) and `childAccessFilter`
  (`message.created`) now use `case_access_level()` (org owners/admins + assigned care team) instead of any
  active org member.
- Tests: `tests/outbox.test.ts` adds "022 sharing.granted" (failed grant transaction -> no event; event payload;
  grantee owner + admin get in-app + email, grantee member and source org get nothing; revoked grant and
  departed guardian -> no rows); `tests/sharing-grants.test.ts` asserts the outbox event instead of the
  `notifyLater` mock; `tests/notify-templates.test.ts` checks the `Shared with us` link;
  `tests/helpers/world.ts` cleanup also deletes outbox events of its synthetic children.
- After `dnm-db.sh 5 <worktree> reset` (12 migrations): `npm run lint` and `npm run typecheck` exit 0;
  `npx vitest run` 57 files, 816 passed, 10 skipped (the pre-existing 010 block; all DB suites ran, including
  022's `case-access` / `sharing-grants`); no outbox rows left behind; `npm run build` exit 0.
- Live re-check (dev server 3050, `CRON_SECRET=test-3050`, fresh `seed:users --prefix e032`):
  - E-1: cron without header 401, with header `200 {"fanned_out":1,"sent":1,"failed":0,"skipped":1}`;
    guardian_a's `GET /api/notifications` lists `Test notification` (unread 1) and `/family` renders the bell
    `Notifications, 1 unread`; guardian_b sees `items: []`; email `sent` / `demo`, WhatsApp `skipped` /
    `whatsapp_not_configured`.
  - Sharing: guardian_a `POST /api/family/children/<child>/sharing-grants` (org B -> org A, reports, 90 days)
    -> 201; without any cron call the event was fanned out 27 ms later (`after()` drain): org A's owner
    (`org_admin_a`) got in-app + email (`demo`) linking to `/cases/<org A case>/shared` (200 for them, 404 for
    provider_b); org A's plain member `provider_a` and source-org owner `provider_b` got nothing.
